// HTTP server: Meta webhook, operator API, setup wizard, Server-Sent Events
// and the static UI. Call audio never touches this process: it flows
// browser <-> WhatsApp over WebRTC.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCredentials, LoginLimiter, parseCookies, peekSessionUser, signSession, verifySession } from './auth.js';
import { CallError, CallStore, publicCall } from './calls.js';
import { Store } from './db.js';
import { createDemo } from './demo.js';
import { createGraph, GraphError, NO_CALL_PERMISSION, normalizeNumber } from './graph.js';
import { HttpError, readBody, readJson, sendError, sendJson } from './http.js';
import { iceServersFor } from './ice.js';
import { createInbox } from './inbox.js';
import { log } from './log.js';
import { Settings, Users } from './settings.js';
import { createSetup } from './setup.js';
import { EventHub } from './sse.js';
import { parseWebhook, verifySignature } from './webhook.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT_DIR, 'public');
export const VERSION = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')).version;
const COOKIE = 'sieflow_phone_session';
// Over HTTPS the cookie carries the __Host- prefix: Secure, host-only, path /.
const SECURE_COOKIE = '__Host-sieflow_phone_session';
const DAY_MS = 24 * 3_600_000;
// scrypt runs on libuv's thread pool, which also resolves DNS for Graph API
// calls: a flood of sign-ins must not delay answering a call.
const MAX_PASSWORD_CHECKS = 2;
const WEBHOOK_LIMIT = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'microphone=(self), camera=(), geolocation=()',
};

// Quicksand (the SieFlow typeface) comes from Google Fonts; without it the UI
// falls back to the system font.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const UI_FILES = [
  'index.html',
  'app.js',
  'api.js',
  'ui.js',
  'i18n.js',
  'phone.js',
  'inbox.js',
  'wizard.js',
  'style.css',
  'favicon.svg',
  'manifest.webmanifest',
];

// Cached in memory in production; read from disk on every request otherwise,
// so UI changes show up on reload while developing.
function loadAssets(demo) {
  const names = [...UI_FILES];
  if (demo) names.push('simulator.html', 'simulator.js');
  const cache = process.env.NODE_ENV === 'production';
  const assets = new Map();
  for (const name of names) {
    const file = join(PUBLIC_DIR, name);
    const cached = cache ? readFileSync(file) : null;
    assets.set('/' + name, { read: () => cached ?? readFileSync(file), type: MIME[extname(name)] });
  }
  assets.set('/', assets.get('/index.html'));
  assets.set('/setup', assets.get('/index.html'));
  if (demo) assets.set('/simulator', assets.get('/simulator.html'));
  return assets;
}

function safeEqual(a, b) {
  const digest = (value) => createHash('sha256').update(String(value)).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function ipv6Prefix(address) {
  if (!address.includes(':')) return address;
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

const isSdp = (value) => typeof value === 'string' && value.startsWith('v=0') && value.length < 64 * 1024;

export async function createApp(config) {
  const db = new Store({ dataDir: config.dataDir });
  const settings = new Settings(config, db);
  const users = new Users(config, db);
  const calls = new CallStore();
  const hub = new EventHub();
  const graph = createGraph(config);
  const limiter = new LoginLimiter();
  const ipLimiter = new LoginLimiter({ max: 50 });
  const revoked = new Map(); // token -> time it stops mattering (signed out before expiry)
  let passwordChecks = 0;
  const assets = loadAssets(config.demo);
  const demo = config.demo ? createDemo(config) : null;
  const inbox = createInbox({ config, db, graph, hub, users });
  const setup = createSetup({
    config,
    settings,
    users,
    graph,
    login: startSession,
    clientIp,
    onUserChanged: (username) => hub.disconnect((user) => user === username),
  });

  if (config.retentionDays) {
    const prune = () => {
      const removed = db.prune(Date.now() - config.retentionDays * DAY_MS);
      if (removed) log.info('retention: old messages deleted', { removed, days: config.retentionDays });
    };
    prune();
    setInterval(prune, 6 * 3_600_000).unref();
  }

  calls.on('ringing', (call) => hub.send('call.ringing', publicCall(call)));
  calls.on('update', (call) => hub.send('call.updated', publicCall(call)));
  calls.on('answer', (call) =>
    hub.send('call.answer', { callId: call.id, sdp: call.answerSdp }, (user) => user === call.agent),
  );
  calls.on('ended', (call) => {
    let conversationId = null;
    try {
      conversationId = inbox.recordCall(call);
    } catch (error) {
      log.error('could not record the call', { callId: call.id, error: error.message });
    }
    // Outgoing calls only know the number; the conversation knows the name.
    const peerName = call.peerName ?? (conversationId ? db.conversation(conversationId)?.name : null) ?? null;
    hub.send('call.ended', { ...publicCall(call), peerName, conversationId });
    log.info('call ended', {
      callId: call.id,
      direction: call.direction,
      outcome: call.outcome,
      duration: call.duration,
      agent: call.agent,
    });
  });

  // ---- Meta webhook ---------------------------------------------------------

  function handleEvent(event) {
    switch (event.type) {
      case 'call.connect':
        if (event.sdpType === 'offer' && event.direction === 'USER_INITIATED') {
          const call = calls.addInbound(event);
          if (call) log.info('incoming call', { callId: call.id });
        } else if (event.sdpType === 'answer') {
          calls.outboundAnswer(event.callId, event.sdp);
        }
        break;
      case 'call.status':
        calls.status(event.callId, event.status);
        break;
      case 'call.terminate': {
        const call = calls.get(event.callId);
        if (!call || call.state === 'ended') break;
        if (event.error) log.warn('call terminated with an error', { callId: event.callId, ...event.error });
        const failed = event.status === 'FAILED' && event.error && !call.answeredAt && call.direction === 'outbound';
        calls.end(event.callId, { outcome: failed ? 'failed' : undefined, duration: event.duration ?? undefined });
        break;
      }
      case 'message.received':
        inbox.onMessage(event);
        if (event.kind === 'call_permission_reply') {
          log.info('call permission reply', { response: event.data?.response });
          hub.send('permission.reply', { peer: event.from, peerName: event.name, ...event.data });
        }
        break;
      case 'message.status':
        inbox.onStatus(event);
        break;
    }
  }

  function verifyWebhook(res, url) {
    const params = url.searchParams;
    const token = params.get('hub.verify_token') ?? '';
    if (params.get('hub.mode') === 'subscribe' && config.verifyToken && safeEqual(token, config.verifyToken)) {
      settings.trackWebhook('verified');
      log.info('webhook verified by Meta');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(params.get('hub.challenge') ?? '');
      return;
    }
    log.warn('webhook verification failed');
    sendError(res, 403, 'forbidden', 'Webhook verification failed');
  }

  function forward(raw, signature) {
    fetch(config.forwardUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
      signal: AbortSignal.timeout(5000),
    })
      .then((res) => res.ok || log.warn('webhook forward failed', { status: res.status }))
      .catch((error) => log.warn('webhook forward failed', { error: error.message }));
  }

  async function receiveWebhook(req, res) {
    const raw = await readBody(req, WEBHOOK_LIMIT);
    if (!config.appSecret) return sendError(res, 503, 'setup_required', 'SieFlow Phone is not configured yet');
    const signature = req.headers['x-hub-signature-256'];
    if (!verifySignature(raw, signature, config.appSecret)) {
      log.warn('webhook rejected: invalid signature');
      return sendError(res, 401, 'bad_signature', 'Invalid signature');
    }
    // Acknowledge first: Meta retries webhooks that take too long.
    sendJson(res, 200, { ok: true });
    settings.trackWebhook('event');
    if (config.forwardUrl) forward(raw, signature);
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      log.warn('webhook body is not JSON');
      return;
    }
    for (const event of parseWebhook(payload, config.phoneNumberId)) {
      try {
        handleEvent(event);
      } catch (error) {
        log.error('webhook event failed', { type: event.type, error: error.message });
      }
    }
  }

  // ---- Sessions -------------------------------------------------------------

  // Sessions are signed with a key that includes the user's password hash:
  // changing the password or removing the user signs them out everywhere.
  const sessionKey = (user) => `${config.sessionSecret}:${user.hash}`;

  const sessionToken = (req) => {
    const cookies = parseCookies(req.headers.cookie);
    return cookies[SECURE_COOKIE] ?? cookies[COOKIE];
  };

  function sessionUser(req) {
    const token = sessionToken(req);
    if (!token || revoked.has(token)) return null;
    const claimed = peekSessionUser(token);
    const user = claimed ? users.get(claimed) : null;
    if (!user || verifySession(token, sessionKey(user)) !== user.username) return null;
    return { username: user.username, role: user.role };
  }

  function revoke(token) {
    const now = Date.now();
    for (const [key, until] of revoked) if (until < now) revoked.delete(key);
    revoked.set(token, now + config.sessionTtlMs);
  }

  const isHttps = (req) =>
    Boolean(req.socket.encrypted) || (config.trustProxy && String(req.headers['x-forwarded-proto']).startsWith('https'));

  // Rate limits key on the client address. Behind a proxy, the last
  // X-Forwarded-For entry is the one the proxy added; earlier ones come from
  // the client and can be anything. One IPv6 /64 counts as one client.
  function clientIp(req) {
    const forwarded = config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '') : '';
    const address = (forwarded.split(',').pop() ?? '').trim() || req.socket.remoteAddress || 'unknown';
    return ipv6Prefix(address.replace(/^::ffff:/, ''));
  }

  function sessionCookie(req, value, maxAgeSeconds) {
    const name = isHttps(req) ? SECURE_COOKIE : COOKIE;
    const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (isHttps(req)) parts.push('Secure');
    return parts.join('; ');
  }

  const clearCookies = (req) => [
    `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    ...(isHttps(req) ? [`${SECURE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure`] : []),
  ];

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  function me(user) {
    return {
      user: user.username,
      role: user.role,
      ready: setup.isReady(),
      demo: config.demo,
      displayNumber: config.displayNumber,
      iceServers: iceServersFor(config, user.username),
      agents: users.list().map((item) => item.username),
      templatesEnabled: Boolean(config.wabaId),
      permissionRequestText: config.permissionRequestText,
    };
  }

  function startSession(req, res, username) {
    const user = users.get(username);
    const token = signSession(username, sessionKey(user), config.sessionTtlMs);
    sendJson(res, 200, me({ username, role: user.role }), {
      'set-cookie': sessionCookie(req, token, Math.floor(config.sessionTtlMs / 1000)),
    });
  }

  async function login(req, res) {
    const body = await readJson(req, 4096);
    const username = String(body.username ?? '').trim().slice(0, 64);
    const password = String(body.password ?? '');
    const ip = clientIp(req);
    const key = `${ip}|${username.toLowerCase()}`;
    if (limiter.blocked(key) || ipLimiter.blocked(ip)) {
      return sendError(res, 429, 'too_many_attempts', 'Too many failed attempts. Try again in a few minutes.');
    }
    if (passwordChecks >= MAX_PASSWORD_CHECKS) {
      return sendError(res, 429, 'busy', 'Too many sign-ins at once. Try again in a moment.');
    }
    passwordChecks += 1;
    let valid;
    try {
      valid = await checkCredentials((name) => users.get(name)?.hash, username, password);
    } finally {
      passwordChecks -= 1;
    }
    if (!valid) {
      limiter.fail(key);
      ipLimiter.fail(ip);
      log.warn('sign-in failed'); // no username: people sometimes type their password there
      return sendError(res, 401, 'bad_credentials', 'Wrong username or password');
    }
    limiter.reset(key);
    log.info('operator signed in', { user: username });
    startSession(req, res, username);
  }

  // ---- Calls ----------------------------------------------------------------

  function openEvents(req, res, user) {
    const client = hub.open(req, res, user, () => sessionUser(req)?.username === user);
    hub.sendTo(client, 'snapshot', { calls: calls.live().map(publicCall), history: db.recentCalls(50) });
    hub.send('agents', { agents: hub.users() });
    req.on('close', () => hub.send('agents', { agents: hub.users() }));
  }

  async function callAction(req, res, user, callId, action) {
    const body = await readJson(req);
    const call = calls.get(callId);
    if (!call || call.state === 'ended') return sendError(res, 404, 'not_found', 'Call not found or already finished');

    if (action === 'pre-accept') {
      if (!isSdp(body.sdp)) return sendError(res, 400, 'bad_sdp', 'An SDP answer is required');
      calls.claim(callId, user, body.sdp);
      try {
        await graph.preAccept(callId, body.sdp);
      } catch (error) {
        calls.release(callId, user);
        throw error;
      }
      log.info('call pre-accepted', { callId, agent: user });
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'accept') {
      if (call.state !== 'connecting' || call.agent !== user) {
        return sendError(res, 409, 'not_yours', 'Pre-accept the call before accepting it');
      }
      // Meta requires the exact SDP that was sent with pre_accept.
      await graph.accept(callId, call.answerSdp);
      calls.activate(callId);
      log.info('call accepted', { callId, agent: user });
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'reject') {
      if (call.direction !== 'inbound' || call.state !== 'ringing') {
        return sendError(res, 409, 'not_ringing', 'Only a ringing call can be declined');
      }
      await graph.reject(callId);
      calls.end(callId, { outcome: 'declined', agent: user });
      return sendJson(res, 200, { ok: true });
    }

    // hangup
    if (call.agent !== user) return sendError(res, 403, 'not_yours', 'Only the operator on the call can hang up');
    const notAnswered = !call.answeredAt;
    try {
      if (call.direction === 'inbound' && notAnswered) await graph.reject(callId);
      else await graph.terminate(callId);
    } catch (error) {
      log.warn('hangup request failed, ending the call locally', { callId, error: error.message });
    }
    let outcome;
    if (notAnswered) outcome = call.direction === 'inbound' ? 'declined' : 'cancelled';
    calls.end(callId, { outcome });
    sendJson(res, 200, { ok: true });
  }

  async function dial(req, res, user) {
    const body = await readJson(req);
    const to = normalizeNumber(body.to);
    if (!to) return sendError(res, 400, 'bad_number', 'Use the full number with country code (digits only)');
    if (!isSdp(body.sdp)) return sendError(res, 400, 'bad_sdp', 'An SDP offer is required');
    let callId;
    try {
      callId = await graph.connect(to, body.sdp);
    } catch (error) {
      if (error instanceof GraphError && error.code === NO_CALL_PERMISSION) {
        return sendError(res, 409, 'no_permission', 'This person has not allowed calls from your business yet');
      }
      throw error;
    }
    const call = calls.addOutbound({ callId, agent: user, peer: to });
    log.info('outgoing call', { callId, agent: user });
    sendJson(res, 200, { callId, answerSdp: call.answerSdp });
  }

  // ---- API routing ----------------------------------------------------------

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    if (method !== 'GET' && !sameOrigin(req)) return sendError(res, 403, 'bad_origin', 'Cross-origin request refused');

    if (pathname === '/api/info' && method === 'GET') {
      return sendJson(res, 200, {
        demo: config.demo,
        login: config.demo ? config.demoLogin : null,
        ready: setup.isReady(),
        needsAccount: users.count() === 0,
      });
    }
    if (pathname === '/api/login' && method === 'POST') return login(req, res);
    if (pathname === '/api/logout' && method === 'POST') {
      const token = sessionToken(req);
      if (token) revoke(token);
      return sendJson(res, 200, { ok: true }, { 'set-cookie': clearCookies(req) });
    }

    const user = sessionUser(req);
    if (await setup.handle(req, res, url, user)) return;
    if (!user) return sendError(res, 401, 'unauthorized', 'Sign in first');
    if (pathname === '/api/me' && method === 'GET') return sendJson(res, 200, me(user));
    if (!setup.isReady()) return sendError(res, 503, 'setup_required', 'SieFlow Phone is not configured yet');

    if (method === 'GET' && pathname === '/api/events') return openEvents(req, res, user.username);
    if (method === 'GET' && pathname === '/api/history') return sendJson(res, 200, { calls: db.recentCalls(100) });
    if (await inbox.handle(req, res, url, user)) return;

    if (method === 'POST') {
      if (pathname === '/api/calls') return dial(req, res, user.username);
      const action = pathname.match(/^\/api\/calls\/([^/]+)\/(pre-accept|accept|reject|hangup)$/);
      if (action) return callAction(req, res, user.username, decodeURIComponent(action[1]), action[2]);
    }
    sendError(res, 404, 'not_found', 'Not found');
  }

  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (pathname === '/healthz') return sendJson(res, 200, { ok: true, version: VERSION });
    if (pathname === '/webhook') {
      if (method === 'GET') return verifyWebhook(res, url);
      if (method === 'POST') return receiveWebhook(req, res);
      return sendError(res, 405, 'method_not_allowed', 'Method not allowed');
    }
    if (pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (demo && pathname.startsWith('/demo/')) return demo.handle(req, res, url);

    const asset = (method === 'GET' || method === 'HEAD') && assets.get(pathname);
    if (asset) {
      const headers = { 'content-type': asset.type, 'cache-control': 'no-cache' };
      if (asset.type.startsWith('text/html')) headers['content-security-policy'] = CSP;
      res.writeHead(200, headers);
      res.end(method === 'HEAD' ? undefined : asset.read());
      return;
    }
    sendError(res, 404, 'not_found', 'Not found');
  }

  const server = createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (isHttps(req)) res.setHeader('strict-transport-security', 'max-age=31536000');
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendError(res, 400, 'bad_url', 'Bad URL');
    }
    try {
      await route(req, res, url);
    } catch (error) {
      if (res.headersSent) return void res.end();
      if (error instanceof HttpError || error instanceof CallError) {
        return sendError(res, error.status, error.code, error.message, error.status === 413 ? { connection: 'close' } : {});
      }
      if (error instanceof GraphError) {
        log.warn('graph api error', { status: error.status, code: error.code, message: error.message });
        return sendError(res, 502, 'graph_error', `WhatsApp API: ${error.message}`);
      }
      if (error.name === 'TimeoutError') return sendError(res, 504, 'timeout', 'The WhatsApp API did not answer in time');
      log.error('request failed', { path: url.pathname, error: error.message, stack: error.stack });
      sendError(res, 500, 'internal', 'Internal error');
    }
  });

  setup.ensureSetupCode();

  return {
    server,
    calls,
    hub,
    db,
    config,
    async listen(port = config.port, host = config.host) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const actualPort = server.address().port;
      if (demo) {
        config.graphBaseUrl = `http://127.0.0.1:${actualPort}/demo/graph`;
        demo.setPort(actualPort);
      }
      return actualPort;
    },
    async close() {
      hub.close();
      demo?.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}
