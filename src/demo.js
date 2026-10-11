// DEMO_MODE: a mock of the WhatsApp Cloud API (calling, messaging, templates
// and the account checks of the setup wizard) plus a browser simulator that
// plays the WhatsApp user. The mock reaches SieFlow Phone through the real, signed
// /webhook, so the demo runs the production code path end to end.
// Never enable it on a public server.
//
// Typing a value that contains "bad" as a token or app secret in the wizard
// simulates Meta rejecting it.

import { randomBytes } from 'node:crypto';
import { readJson, sendError, sendJson } from './http.js';
import { log } from './log.js';
import { EventHub } from './sse.js';
import { signBody } from './webhook.js';

const digits = (value) => String(value ?? '').replace(/\D/g, '');
const unixNow = () => Math.floor(Date.now() / 1000);
const UNANSWERED_MS = 45_000; // Meta gives up on an unanswered call after 30 to 60 s.
const PERMISSION_DAYS = 7;

// Numbers ending in 000 act like a user who has not granted call permission.
const lacksPermission = (number) => number.endsWith('000');

const DEMO_TEMPLATES = [
  {
    name: 'seguimiento_pedido',
    language: 'es',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hola {{1}}, tu pedido {{2}} ya va en camino.' }],
  },
  {
    name: 'permiso_llamada',
    language: 'es',
    status: 'APPROVED',
    category: 'MARKETING',
    components: [
      { type: 'BODY', text: 'Hola {{1}}, ¿podemos llamarte por WhatsApp para ayudarte con tu solicitud?' },
      { type: 'CALL_PERMISSION_REQUEST' },
    ],
  },
  {
    name: 'order_update',
    language: 'en_US',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' },
      { type: 'BODY', text: 'Hi {{1}}, your order is on its way.' },
      { type: 'FOOTER', text: 'Reply STOP to opt out' },
    ],
  },
  {
    name: 'promo_octubre',
    language: 'es',
    status: 'APPROVED',
    category: 'MARKETING',
    components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Mira la promoción de octubre.' }],
  },
];

const DEMO_PHONE = {
  id: 'demo-phone-number-id',
  display_phone_number: '+1 555-010-0000',
  verified_name: 'Demo Business',
  quality_rating: 'GREEN',
  platform_type: 'CLOUD_API',
  code_verification_status: 'VERIFIED',
  messaging_limit_tier: 'TIER_10K',
};

function renderTemplate(template, components = []) {
  const valuesFor = (type) => components.find((c) => c.type === type)?.parameters ?? [];
  const fillText = (text, parameters) => {
    let index = 0;
    return String(text ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => {
      const named = parameters.find((p) => p.parameter_name === name);
      const value = named ?? parameters[/^\d+$/.test(name) ? Number(name) - 1 : index];
      index += 1;
      return value?.text ?? match;
    });
  };
  const header = template.components.find((c) => c.type === 'HEADER' && c.format === 'TEXT');
  const body = template.components.find((c) => c.type === 'BODY');
  return [header && fillText(header.text, valuesFor('header')), fillText(body?.text, valuesFor('body'))]
    .filter(Boolean)
    .join('\n\n');
}

export function createDemo(config) {
  const hub = new EventHub();
  const calls = new Map();
  const people = new Map(); // wa_id -> { name, permissionUntil }
  const calling = {
    status: 'ENABLED',
    call_icon_visibility: 'DEFAULT',
    callback_permission_status: 'ENABLED',
    sip: { status: 'DISABLED' },
  };
  let appSubscription = null;
  let port = config.port;

  const business = () => digits(config.displayNumber) || '15550100000';
  const newId = (prefix) => `${prefix}.demo.${randomBytes(9).toString('base64url')}`;
  const person = (waId, name) => {
    if (!people.has(waId)) people.set(waId, { name: name || 'Demo User', permissionUntil: 0 });
    const entry = people.get(waId);
    if (name) entry.name = name;
    return entry;
  };
  const contact = (waId) => ({ profile: { name: person(waId).name }, wa_id: waId });
  const canCall = (waId) => !lacksPermission(waId) || person(waId).permissionUntil > Date.now();

  async function postWebhook(field, value) {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: config.wabaId || 'demo-waba-id',
          changes: [
            {
              field,
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: business(), phone_number_id: config.phoneNumberId },
                ...value,
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(body, config.appSecret) },
        body,
      });
      if (!res.ok) log.warn('demo webhook was rejected', { status: res.status });
    } catch (error) {
      log.warn('demo webhook failed', { error: error.message });
    }
  }

  // ---- calls ----------------------------------------------------------------

  function callFields(callId, call) {
    const inbound = call.direction === 'inbound';
    return {
      id: callId,
      from: inbound ? call.user : business(),
      to: inbound ? business() : call.user,
      direction: inbound ? 'USER_INITIATED' : 'BUSINESS_INITIATED',
      timestamp: String(unixNow()),
    };
  }

  const callStatusWebhook = (callId, call, status) =>
    postWebhook('calls', {
      statuses: [{ id: callId, type: 'call', status, timestamp: String(unixNow()), recipient_id: call.user }],
    });

  async function terminate(callId, status) {
    const call = calls.get(callId);
    if (!call || call.ended) return;
    call.ended = true;
    clearTimeout(call.timer);
    const extra = { event: 'terminate', status };
    if (call.acceptedAt) {
      const start = Math.floor(call.acceptedAt / 1000);
      const end = unixNow();
      Object.assign(extra, { start_time: String(start), end_time: String(end), duration: Math.max(0, end - start) });
    }
    hub.send('ended', { callId });
    await postWebhook('calls', { contacts: [contact(call.user)], calls: [{ ...callFields(callId, call), ...extra }] });
    setTimeout(() => calls.delete(callId), 60_000).unref();
  }

  function track(callId, call) {
    call.ended = false;
    call.acceptedAt = null;
    call.timer = setTimeout(() => terminate(callId, 'FAILED'), UNANSWERED_MS);
    call.timer.unref?.();
    calls.set(callId, call);
    return call;
  }

  // ---- messages -------------------------------------------------------------

  const messageStatus = (wamid, to, status) =>
    postWebhook('messages', {
      statuses: [{ id: wamid, status, timestamp: String(unixNow()), recipient_id: to }],
    });

  async function permissionReply(waId, contextId, response) {
    const entry = person(waId);
    const expiresAt = unixNow() + PERMISSION_DAYS * 86_400;
    entry.permissionUntil = response === 'accept' ? expiresAt * 1000 : 0;
    await postWebhook('messages', {
      contacts: [contact(waId)],
      messages: [
        {
          from: waId,
          id: newId('wamid'),
          timestamp: String(unixNow()),
          type: 'interactive',
          context: contextId ? { from: business(), id: contextId } : undefined,
          interactive: {
            type: 'call_permission_reply',
            call_permission_reply: {
              response,
              is_permanent: false,
              expiration_timestamp: response === 'accept' ? String(expiresAt) : undefined,
              response_source: 'user_action',
            },
          },
        },
      ],
    });
  }

  async function deliver(to, wamid, shown) {
    await messageStatus(wamid, to, 'sent');
    hub.send('message', { id: wamid, to, ...shown });
    await messageStatus(wamid, to, 'delivered');
    if (hub.size > 0) {
      setTimeout(() => messageStatus(wamid, to, 'read'), 1200).unref();
    } else if (shown.permission) {
      // Nobody at the simulator: the person accepts after a moment.
      setTimeout(() => permissionReply(to, wamid, 'accept'), 1500).unref();
    }
  }

  // ---- mock Graph API -------------------------------------------------------

  function graphError(res, status, code, message) {
    sendJson(res, status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'demo' } });
  }

  async function graphCalls(req, res) {
    const body = await readJson(req);
    const { action, call_id: callId } = body;

    if (action === 'connect') {
      const user = digits(body.to);
      if (!canCall(user)) return graphError(res, 400, 138006, 'Lack of call request permission for this user');
      const id = newId('wacid');
      track(id, { direction: 'outbound', user });
      // Reply to the server first, then ring the simulator.
      setTimeout(() => hub.send('incoming', { callId: id, from: config.displayNumber, sdp: body.session?.sdp }), 0);
      return sendJson(res, 200, { messaging_product: 'whatsapp', calls: [{ id }] });
    }

    const call = calls.get(callId);
    if (!call || call.ended) return graphError(res, 400, 100, 'Invalid call id');

    switch (action) {
      case 'pre_accept':
        call.answerSdp = body.session?.sdp;
        hub.send('answer', { callId, sdp: call.answerSdp });
        break;
      case 'accept':
        if (body.session?.sdp !== call.answerSdp) {
          return graphError(res, 400, 100, 'SDP answer in accept does not match the one sent in pre_accept');
        }
        call.acceptedAt = Date.now();
        clearTimeout(call.timer);
        hub.send('accepted', { callId });
        break;
      case 'reject':
        setTimeout(() => terminate(callId, 'FAILED'), 10);
        break;
      case 'terminate':
        setTimeout(() => terminate(callId, 'COMPLETED'), 10);
        break;
      default:
        return graphError(res, 400, 100, `Unsupported action: ${action}`);
    }
    sendJson(res, 200, { messaging_product: 'whatsapp', success: true });
  }

  async function graphMessages(req, res) {
    const body = await readJson(req);
    if (body.status === 'read') {
      hub.send('read', { id: body.message_id });
      return sendJson(res, 200, { success: true });
    }
    const to = digits(body.to);
    let shown;
    if (body.type === 'text') {
      shown = { kind: 'text', body: body.text?.body ?? '' };
    } else if (body.type === 'template') {
      const template = DEMO_TEMPLATES.find(
        (t) => t.name === body.template?.name && t.language === body.template?.language?.code,
      );
      if (!template) return graphError(res, 404, 132001, 'Template name does not exist in the translation');
      shown = {
        kind: 'template',
        body: renderTemplate(template, body.template.components),
        permission: template.components.some((c) => c.type === 'CALL_PERMISSION_REQUEST'),
      };
    } else if (body.type === 'interactive' && body.interactive?.type === 'call_permission_request') {
      shown = { kind: 'call_permission_request', body: body.interactive.body?.text ?? '', permission: true };
    } else {
      return graphError(res, 400, 100, 'The demo only sends text, templates and call permission requests');
    }
    const wamid = newId('wamid');
    sendJson(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: wamid }] });
    setTimeout(() => deliver(to, wamid, shown), 30).unref();
  }

  function graphPermissions(res, url) {
    const waId = digits(url.searchParams.get('user_wa_id'));
    const until = person(waId).permissionUntil;
    const allowed = canCall(waId);
    sendJson(res, 200, {
      messaging_product: 'whatsapp',
      permission: until > Date.now() ? { status: 'temporary', expiration_time: Math.floor(until / 1000) } : { status: allowed ? 'permanent' : 'no_permission' },
      actions: [
        { action_name: 'send_call_permission_request', can_perform_action: !allowed },
        { action_name: 'start_call', can_perform_action: allowed },
      ],
    });
  }

  const bearer = (req) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const looksBad = (value) => /bad/i.test(value);

  async function graph(req, res, url, id, resource) {
    const token = bearer(req);
    if (!token || looksBad(token)) return graphError(res, 401, 190, 'Invalid OAuth access token');
    const method = req.method;

    if (id === 'debug_token') {
      const input = url.searchParams.get('input_token') ?? '';
      const [appId] = token.split('|');
      return sendJson(res, 200, {
        data: {
          app_id: appId,
          type: 'SYSTEM_USER',
          application: 'SieFlow Phone demo app',
          expires_at: 0,
          is_valid: !looksBad(input),
          scopes: ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management'],
          granular_scopes: [
            { scope: 'whatsapp_business_management', target_ids: ['demo-waba-id'] },
            { scope: 'whatsapp_business_messaging', target_ids: ['demo-waba-id'] },
          ],
        },
      });
    }

    if (!resource) {
      if (id === 'demo-waba-id') return sendJson(res, 200, { id, name: 'Demo Business' });
      if (id === DEMO_PHONE.id) return sendJson(res, 200, DEMO_PHONE);
      return graphError(res, 404, 100, 'Unsupported get request in the demo');
    }

    switch (resource) {
      case 'calls':
        return method === 'POST' ? graphCalls(req, res) : graphError(res, 405, 100, 'POST only');
      case 'messages':
        return method === 'POST' ? graphMessages(req, res) : graphError(res, 405, 100, 'POST only');
      case 'call_permissions':
        return graphPermissions(res, url);
      case 'settings':
        if (method === 'POST') {
          Object.assign(calling, (await readJson(req)).calling ?? {});
          return sendJson(res, 200, { success: true });
        }
        return sendJson(res, 200, { calling });
      case 'phone_numbers':
        return sendJson(res, 200, { data: [DEMO_PHONE] });
      case 'message_templates':
        return sendJson(res, 200, { data: DEMO_TEMPLATES });
      case 'subscribed_apps':
        return sendJson(res, 200, { success: true });
      case 'subscriptions': {
        if (method === 'GET') return sendJson(res, 200, { data: appSubscription ? [appSubscription] : [] });
        // Like Meta: check the callback URL answers the verification challenge.
        // The demo calls itself because its public URL is usually localhost.
        const verifyToken = url.searchParams.get('verify_token') ?? '';
        const challenge = randomBytes(6).toString('hex');
        const check = await fetch(
          `http://127.0.0.1:${port}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${challenge}`,
        ).catch(() => null);
        if (!check?.ok || (await check.text()) !== challenge) {
          return graphError(res, 400, 2200, 'Callback verification failed with the given verify token');
        }
        appSubscription = {
          object: 'whatsapp_business_account',
          callback_url: url.searchParams.get('callback_url'),
          active: true,
          fields: (url.searchParams.get('fields') ?? '').split(',').filter(Boolean).map((name) => ({ name, version: 'v24.0' })),
        };
        return sendJson(res, 200, { success: true });
      }
      default:
        return graphError(res, 400, 100, 'Unsupported request in the demo');
    }
  }

  // ---- simulator (the WhatsApp user) ----------------------------------------

  async function simulator(req, res, action) {
    const body = await readJson(req);

    if (action === 'call') {
      if (typeof body.sdp !== 'string') return sendError(res, 400, 'bad_sdp', 'SDP offer required');
      const user = digits(body.from) || '15550100101';
      person(user, String(body.name || '').slice(0, 60));
      const callId = newId('wacid');
      track(callId, { direction: 'inbound', user });
      await postWebhook('calls', {
        contacts: [contact(user)],
        // Real user-initiated connect webhooks carry no "direction" field.
        calls: [
          { id: callId, from: user, to: business(), event: 'connect', timestamp: String(unixNow()), session: { sdp_type: 'offer', sdp: body.sdp } },
        ],
      });
      return sendJson(res, 200, { callId });
    }

    if (action === 'message') {
      const user = digits(body.from) || '15550100101';
      person(user, String(body.name || '').slice(0, 60));
      const text = String(body.text ?? '').slice(0, 4096);
      if (!text.trim()) return sendError(res, 400, 'empty', 'Write a message');
      const wamid = newId('wamid');
      await postWebhook('messages', {
        contacts: [contact(user)],
        messages: [{ from: user, id: wamid, timestamp: String(unixNow()), type: 'text', text: { body: text } }],
      });
      return sendJson(res, 200, { id: wamid });
    }

    if (action === 'permission') {
      const user = digits(body.from) || '15550100101';
      person(user, String(body.name || '').slice(0, 60));
      await permissionReply(user, body.context ?? null, body.response === 'accept' ? 'accept' : 'reject');
      return sendJson(res, 200, { ok: true });
    }

    const call = calls.get(body.callId);
    if (!call || call.ended) return sendError(res, 404, 'not_found', 'Unknown or finished call');
    const callId = body.callId;

    if (action === 'ringing') {
      await postWebhook('calls', {
        contacts: [contact(call.user)],
        calls: [{ ...callFields(callId, call), event: 'connect', session: { sdp_type: 'answer', sdp: body.sdp } }],
      });
      await callStatusWebhook(callId, call, 'RINGING');
    } else if (action === 'accept') {
      call.acceptedAt = Date.now();
      clearTimeout(call.timer);
      await callStatusWebhook(callId, call, 'ACCEPTED');
    } else if (action === 'decline') {
      await callStatusWebhook(callId, call, 'REJECTED');
      await terminate(callId, 'FAILED');
    } else if (action === 'hangup') {
      await terminate(callId, call.acceptedAt ? 'COMPLETED' : 'FAILED');
    }
    sendJson(res, 200, { ok: true });
  }

  return {
    setPort(value) {
      port = value;
    },
    async handle(req, res, url) {
      const path = url.pathname;
      if (path === '/demo/events' && req.method === 'GET') {
        hub.open(req, res);
        return;
      }
      const sim = path.match(/^\/demo\/sim\/(call|ringing|accept|decline|hangup|message|permission)$/);
      if (sim && req.method === 'POST') return simulator(req, res, sim[1]);
      const graphPath = path.match(/^\/demo\/graph\/[^/]+\/([^/]+)(?:\/([^/]+))?$/);
      if (graphPath) return graph(req, res, url, decodeURIComponent(graphPath[1]), graphPath[2]);
      sendError(res, 404, 'not_found', 'Not found');
    },
    close() {
      hub.close();
      for (const call of calls.values()) clearTimeout(call.timer);
    },
  };
}
