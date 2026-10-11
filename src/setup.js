// First-run wizard and admin settings: the operator account, the Meta app,
// the webhook, calling and the team. Every Meta value is checked live against
// the Graph API before SieFlow Phone relies on it.

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { LoginLimiter } from './auth.js';
import { CallError } from './calls.js';
import { GraphError } from './graph.js';
import { readJson, sendJson } from './http.js';
import { log } from './log.js';

const REQUIRED_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management'];
// Calling needs a messaging limit of 2,000 or more.
const CALLING_TIERS = new Set(['TIER_2K', 'TIER_10K', 'TIER_100K', 'TIER_UNLIMITED']);
const LOW_TIERS = new Set(['TIER_50', 'TIER_250', 'TIER_1K']);
const META_ID = /^[\w.-]{1,64}$/;

export function newSetupCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export const normalizeCode = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function sameCode(given, expected) {
  const digest = (value) => createHash('sha256').update(normalizeCode(value)).digest();
  return normalizeCode(expected).length >= 8 && timingSafeEqual(digest(given), digest(expected));
}

const graphFailure = (error) => ({ ok: false, error: error instanceof GraphError ? error.message : String(error.message) });

export function createSetup({ config, settings, users, graph, login, clientIp, onUserChanged = () => {} }) {
  const isReady = () => users.count() > 0 && settings.missing().length === 0;
  const codeAttempts = new LoginLimiter({ max: 10, windowMs: 15 * 60_000 });

  // Without any operator, the first visitor who knows the code from the logs
  // becomes the administrator. Nobody else can claim a fresh instance.
  let setupCode = null;
  function ensureSetupCode() {
    if (users.count() > 0) {
      setupCode = null;
      return;
    }
    if (!setupCode) {
      setupCode = config.setupCode || newSetupCode();
      log.warn('SieFlow Phone needs setup: open it in the browser and enter this code', { setupCode });
      process.stdout.write(`\n  Setup code: ${setupCode}\n\n`);
    }
  }

  function status(user) {
    const base = { ready: isReady(), needsAccount: users.count() === 0, demo: config.demo };
    if (user?.role !== 'admin') return base;
    return {
      ...base,
      missing: settings.missing(),
      fields: settings.view(),
      webhook: { ...settings.webhook, verifyTokenSet: Boolean(config.verifyToken) },
    };
  }

  // Values typed in the wizard win; empty fields fall back to what is stored.
  function pick(body, key) {
    const value = typeof body[key] === 'string' && body[key].trim() ? body[key].trim() : config[key];
    if (value && ['appId', 'wabaId', 'phoneNumberId'].includes(key) && !META_ID.test(value)) {
      throw new CallError(400, 'bad_id', `${key} does not look like a Meta id`);
    }
    if (value && key === 'accessToken' && value.length > 2048) throw new CallError(400, 'bad_token', 'Token too long');
    return value;
  }

  async function verifyMeta(body) {
    const values = {
      appId: pick(body, 'appId'),
      appSecret: pick(body, 'appSecret'),
      accessToken: pick(body, 'accessToken'),
      wabaId: pick(body, 'wabaId'),
    };
    if (!values.accessToken) throw new CallError(400, 'missing_token', 'Paste the access token first');
    // A throwaway client with the values being checked, not the saved ones.
    const probe = graph.withOptions(values);
    const report = { token: null, wabas: [] };

    let wabaIds = values.wabaId ? [values.wabaId] : [];
    if (values.appId && values.appSecret) {
      try {
        const data = (await probe.debugToken(values.accessToken))?.data ?? {};
        const scopes = data.scopes ?? [];
        report.token = {
          valid: Boolean(data.is_valid),
          type: data.type ?? null,
          appName: data.application ?? null,
          appMatches: String(data.app_id ?? '') === String(values.appId),
          expiresAt: data.expires_at ? data.expires_at * 1000 : 0,
          scopes,
          missingScopes: REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope)),
          error: data.error?.message ?? null,
        };
        const granted = (data.granular_scopes ?? [])
          .filter((scope) => REQUIRED_SCOPES.includes(scope.scope))
          .flatMap((scope) => scope.target_ids ?? []);
        wabaIds = [...new Set([...wabaIds, ...granted])];
      } catch (error) {
        // Wrong app id or secret: Meta refuses the app token itself.
        report.token = { valid: false, appSecretRejected: true, error: graphFailure(error).error };
      }
    } else {
      report.token = { valid: null, error: null, needsApp: true };
    }

    for (const id of wabaIds.slice(0, 10)) {
      const entry = { id, name: null, phones: [], error: null };
      try {
        entry.name = (await probe.waba(id))?.name ?? null;
        entry.phones = ((await probe.phoneNumbers(id))?.data ?? []).map((phone) => ({
          id: phone.id,
          displayNumber: phone.display_phone_number ?? null,
          verifiedName: phone.verified_name ?? null,
          quality: phone.quality_rating ?? null,
          platform: phone.platform_type ?? null,
          limitTier: phone.messaging_limit_tier ?? null,
        }));
      } catch (error) {
        entry.error = graphFailure(error).error;
      }
      report.wabas.push(entry);
    }
    return report;
  }

  async function saveMeta(body) {
    const values = {
      appId: pick(body, 'appId'),
      appSecret: pick(body, 'appSecret'),
      accessToken: pick(body, 'accessToken'),
      wabaId: pick(body, 'wabaId'),
      phoneNumberId: pick(body, 'phoneNumberId'),
    };
    for (const key of ['appSecret', 'accessToken', 'phoneNumberId']) {
      if (!values[key]) throw new CallError(400, 'missing_field', `Missing ${key}`);
    }
    // The number must answer with this token before anything is saved.
    let phone;
    try {
      phone = await graph.withOptions(values).phoneNumber(values.phoneNumberId);
    } catch (error) {
      throw new CallError(400, 'phone_unreachable', `The token cannot read that phone number: ${graphFailure(error).error}`);
    }
    const patch = {};
    for (const [key, value] of Object.entries(values)) {
      if (value && value !== config[key] && !config.envLocked.has(key)) patch[key] = value;
    }
    if (!config.envLocked.has('displayNumber') && phone?.display_phone_number) {
      patch.displayNumber = phone.display_phone_number;
    }
    if (!config.verifyToken && !config.envLocked.has('verifyToken')) patch.verifyToken = randomBytes(18).toString('base64url');
    settings.update(patch);
    return { phone: { id: phone.id, displayNumber: phone.display_phone_number ?? null, verifiedName: phone.verified_name ?? null } };
  }

  async function configureWebhook(body) {
    let callbackUrl;
    try {
      callbackUrl = new URL(String(body.callbackUrl ?? ''));
    } catch {
      throw new CallError(400, 'bad_url', 'Type the public URL of this instance, e.g. https://phone.example.com/webhook');
    }
    const patch = {};
    if (!config.envLocked.has('publicUrl')) patch.publicUrl = callbackUrl.origin;
    if (!config.verifyToken && !config.envLocked.has('verifyToken')) patch.verifyToken = randomBytes(18).toString('base64url');
    if (Object.keys(patch).length) settings.update(patch);

    // `code` lets the wizard explain the problem in the operator's language.
    const results = [];
    if (body.auto) {
      if (callbackUrl.protocol !== 'https:' && !config.demo) {
        results.push({ step: 'app', ok: false, code: 'https_required', error: 'Meta only accepts HTTPS callback URLs' });
      } else if (!config.appId || !config.appSecret) {
        results.push({ step: 'app', ok: false, code: 'app_missing', error: 'Add the App ID and App Secret first' });
      } else {
        try {
          await graph.subscribeAppWebhook(callbackUrl.href, config.verifyToken);
          results.push({ step: 'app', ok: true });
        } catch (error) {
          results.push({ step: 'app', ...graphFailure(error) });
        }
      }
      if (config.wabaId) {
        try {
          await graph.subscribeWaba();
          results.push({ step: 'waba', ok: true });
        } catch (error) {
          results.push({ step: 'waba', ...graphFailure(error) });
        }
      } else {
        results.push({ step: 'waba', ok: false, code: 'waba_missing', error: 'Add the WhatsApp Business Account ID first' });
      }
    }
    return { callbackUrl: callbackUrl.href, verifyToken: config.verifyToken, results };
  }

  async function webhookStatus() {
    let fields = null;
    if (config.appId && config.appSecret) {
      try {
        const subscription = ((await graph.appSubscriptions())?.data ?? []).find(
          (item) => item.object === 'whatsapp_business_account',
        );
        if (subscription) {
          fields = {
            callbackUrl: subscription.callback_url ?? null,
            active: subscription.active ?? null,
            names: (subscription.fields ?? []).map((field) => field.name ?? field),
          };
        }
      } catch {
        fields = null;
      }
    }
    return {
      verifiedAt: settings.webhook.verifiedAt,
      lastEventAt: settings.webhook.lastEventAt,
      verifyToken: config.verifyToken,
      publicUrl: config.publicUrl,
      subscription: fields,
    };
  }

  async function callingStatus() {
    const report = { phone: null, calling: null, checks: [], error: null };
    try {
      const phone = await graph.phoneNumber();
      report.phone = {
        displayNumber: phone.display_phone_number ?? null,
        verifiedName: phone.verified_name ?? null,
        quality: phone.quality_rating ?? null,
        platform: phone.platform_type ?? null,
        limitTier: phone.messaging_limit_tier ?? null,
      };
    } catch (error) {
      report.error = graphFailure(error).error;
      return report;
    }
    try {
      report.calling = (await graph.getSettings())?.calling ?? null;
    } catch (error) {
      report.error = graphFailure(error).error;
    }
    const phone = report.phone;
    const check = (id, state, value = null) => report.checks.push({ id, state, value });
    check('platform', !phone.platform ? 'unknown' : phone.platform === 'CLOUD_API' ? 'ok' : 'fail', phone.platform);
    check('quality', !phone.quality || phone.quality === 'UNKNOWN' ? 'unknown' : phone.quality === 'RED' ? 'warn' : 'ok', phone.quality);
    check(
      'limit',
      CALLING_TIERS.has(phone.limitTier) ? 'ok' : LOW_TIERS.has(phone.limitTier) ? 'fail' : 'unknown',
      phone.limitTier,
    );
    const sip = report.calling?.sip?.status;
    check('sip', !report.calling ? 'unknown' : sip === 'ENABLED' ? 'fail' : 'ok', sip ?? 'DISABLED');
    check('calling', report.calling?.status === 'ENABLED' ? 'ok' : 'warn', report.calling?.status ?? null);
    const restrictions = report.calling?.restrictions?.restrictions_list ?? [];
    if (restrictions.length) check('restrictions', 'fail', restrictions.map((r) => r.type).join(', '));
    return report;
  }

  async function saveCalling(body) {
    if (typeof body.permissionRequestText === 'string' && !config.envLocked.has('permissionRequestText')) {
      settings.update({ permissionRequestText: body.permissionRequestText.trim().slice(0, 1024) });
    }
    const calling = {
      status: body.enabled ? 'ENABLED' : 'DISABLED',
      call_icon_visibility: body.showIcon ? 'DEFAULT' : 'DISABLE_ALL',
      callback_permission_status: body.callbackPermission ? 'ENABLED' : 'DISABLED',
    };
    await graph.updateCallingSettings(calling);
    log.info('calling settings updated', calling);
    return callingStatus();
  }

  // ---- routes ---------------------------------------------------------------

  async function handle(req, res, url, user) {
    const { pathname } = url;
    const method = req.method;

    if (pathname === '/api/setup' && method === 'GET') {
      ensureSetupCode();
      sendJson(res, 200, status(user));
      return true;
    }

    if (pathname === '/api/setup/account' && method === 'POST') {
      const body = await readJson(req, 4096);
      if (users.count() > 0) throw new CallError(409, 'already_set_up', 'This instance already has operators: sign in');
      ensureSetupCode();
      const ip = clientIp(req);
      if (codeAttempts.blocked(ip)) throw new CallError(429, 'too_many_attempts', 'Too many attempts. Try again later.');
      if (!sameCode(body.code, setupCode)) {
        codeAttempts.fail(ip);
        throw new CallError(403, 'bad_code', 'The setup code does not match the one in the logs');
      }
      const created = users.create({ username: body.username, password: body.password, role: 'admin' });
      setupCode = null;
      log.info('administrator created', { user: created.username });
      login(req, res, created.username);
      return true;
    }

    if (!pathname.startsWith('/api/setup/') && !pathname.startsWith('/api/users')) return false;
    if (!user) throw new CallError(401, 'unauthorized', 'Sign in first');
    if (user.role !== 'admin') throw new CallError(403, 'admins_only', 'Only administrators can change the configuration');

    if (pathname === '/api/setup/meta/verify' && method === 'POST') {
      sendJson(res, 200, await verifyMeta(await readJson(req)));
      return true;
    }
    if (pathname === '/api/setup/meta' && method === 'POST') {
      const result = await saveMeta(await readJson(req));
      sendJson(res, 200, { ...result, ...status(user) });
      return true;
    }
    if (pathname === '/api/setup/webhook') {
      if (method === 'POST') {
        sendJson(res, 200, await configureWebhook(await readJson(req)));
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, await webhookStatus());
        return true;
      }
    }
    if (pathname === '/api/setup/calling') {
      if (method === 'GET') {
        sendJson(res, 200, await callingStatus());
        return true;
      }
      if (method === 'POST') {
        sendJson(res, 200, await saveCalling(await readJson(req)));
        return true;
      }
    }

    if (pathname === '/api/users') {
      if (method === 'GET') {
        sendJson(res, 200, { users: users.list() });
        return true;
      }
      if (method === 'POST') {
        const body = await readJson(req, 4096);
        sendJson(res, 200, { user: users.create(body), users: users.list() });
        return true;
      }
    }
    const one = pathname.match(/^\/api\/users\/([\w.@-]{1,64})$/);
    if (one) {
      const name = decodeURIComponent(one[1]);
      if (method === 'POST') {
        users.update(name, await readJson(req, 4096));
        onUserChanged(name);
        sendJson(res, 200, { users: users.list() });
        return true;
      }
      if (method === 'DELETE') {
        if (name === user.username) throw new CallError(409, 'self_delete', 'You cannot remove your own account');
        users.remove(name);
        onUserChanged(name);
        sendJson(res, 200, { users: users.list() });
        return true;
      }
    }
    return false;
  }

  return { handle, isReady, ensureSetupCode };
}
