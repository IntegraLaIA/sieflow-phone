// Shared inbox: WhatsApp conversations next to the calls. Operators see the
// same list, take or assign conversations and resolve them. Messages outside
// the 24-hour customer service window can only be templates, as WhatsApp rules;
// inside it, free-form replies are service messages, which Meta also charges
// from October 1, 2026 (see usage.js).

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CallError } from './calls.js';
import { normalizeNumber } from './graph.js';
import { readJson, sendJson } from './http.js';
import { log } from './log.js';

const DAY_MS = 24 * 3_600_000;
const TEMPLATE_CACHE_MS = 5 * 60_000;
const PENDING_STATUS_MS = 60_000;
const STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };
const UNSUPPORTED_BUTTONS = new Set(['COPY_CODE', 'OTP', 'FLOW', 'CATALOG', 'MPM', 'SPM']);
const TEMPLATE_CATEGORIES = new Set(['marketing', 'utility', 'authentication']);
const DEFAULT_PERMISSION_TEXT = 'We would like to call you on WhatsApp about your request. Is that OK?';

export const windowOpen = (conversation, now = Date.now()) =>
  Boolean(conversation?.lastInboundAt) && now - conversation.lastInboundAt < DAY_MS;

function placeholders(text) {
  const names = [];
  for (const match of String(text ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  if (names.every((name) => /^\d+$/.test(name))) names.sort((a, b) => Number(a) - Number(b));
  return names;
}

// Graph template -> what the UI needs to fill and preview it.
export function normalizeTemplate(template) {
  const components = template.components ?? [];
  const find = (type) => components.find((c) => String(c.type).toUpperCase() === type);
  const header = find('HEADER');
  const body = find('BODY');
  const footer = find('FOOTER');
  const buttons = find('BUTTONS')?.buttons ?? [];
  let reason = null;
  if (header && header.format && String(header.format).toUpperCase() !== 'TEXT') reason = 'media_header';
  for (const button of buttons) {
    const type = String(button.type).toUpperCase();
    if (UNSUPPORTED_BUTTONS.has(type) || (type === 'URL' && /\{\{/.test(button.url ?? ''))) reason = 'dynamic_button';
  }
  const headerText = header && String(header.format ?? 'TEXT').toUpperCase() === 'TEXT' ? (header.text ?? null) : null;
  const headerParams = placeholders(headerText);
  const bodyParams = placeholders(body?.text);
  return {
    name: template.name,
    language: template.language,
    category: TEMPLATE_CATEGORIES.has(String(template.category ?? '').toLowerCase())
      ? String(template.category).toLowerCase()
      : null,
    header: headerText,
    body: body?.text ?? '',
    footer: footer?.text ?? null,
    buttons: buttons.map((button) => button.text).filter(Boolean),
    headerParams,
    bodyParams,
    named: template.parameter_format === 'NAMED' || [...headerParams, ...bodyParams].some((n) => !/^\d+$/.test(n)),
    callPermission: components.some((c) => String(c.type).toUpperCase() === 'CALL_PERMISSION_REQUEST'),
    supported: reason === null,
    reason,
  };
}

function fill(text, names, values) {
  let out = String(text ?? '');
  names.forEach((name, index) => {
    out = out.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g'), () => values[index]);
  });
  return out;
}

// WhatsApp rejects template parameters with new lines, tabs or long runs of spaces.
const cleanParam = (value) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();

export function buildTemplate(template, params = {}) {
  const header = (params.header ?? []).map(cleanParam);
  const body = (params.body ?? []).map(cleanParam);
  if (header.length !== template.headerParams.length || body.length !== template.bodyParams.length) {
    throw new CallError(400, 'bad_params', 'Fill in every template field');
  }
  if ([...header, ...body].some((value) => !value || value.length > 1024)) {
    throw new CallError(400, 'bad_params', 'Template fields cannot be empty or longer than 1024 characters');
  }
  const param = (name, text) => (template.named ? { type: 'text', parameter_name: name, text } : { type: 'text', text });
  const components = [];
  if (header.length) components.push({ type: 'header', parameters: template.headerParams.map((n, i) => param(n, header[i])) });
  if (body.length) components.push({ type: 'body', parameters: template.bodyParams.map((n, i) => param(n, body[i])) });
  const text = [fill(template.header, template.headerParams, header), fill(template.body, template.bodyParams, body)]
    .filter(Boolean)
    .join('\n\n');
  return { components, text };
}

export function createInbox({ config, db, graph, hub, users }) {
  const pendingStatuses = new Map();
  let templateCache = { at: 0, list: null };

  const view = (conversation) =>
    conversation && {
      ...conversation,
      windowOpen: windowOpen(conversation),
      windowEndsAt: conversation.lastInboundAt ? conversation.lastInboundAt + DAY_MS : null,
    };

  function publishConversation(id) {
    const conversation = db.conversation(id);
    if (conversation) hub.send('conversation.updated', view(conversation));
    return conversation;
  }

  const publishMessage = (event, message) => hub.send(event, { conversationId: message.conversationId, message });

  // A status (with Meta's pricing) can arrive before the send call returns.
  function rememberStatus(wamid, status, error, pricing) {
    const now = Date.now();
    for (const [id, entry] of pendingStatuses) if (now - entry.at > PENDING_STATUS_MS) pendingStatuses.delete(id);
    const previous = pendingStatuses.get(wamid);
    const latest = !previous || STATUS_RANK[status] >= STATUS_RANK[previous.status];
    pendingStatuses.set(wamid, {
      status: latest ? status : previous.status,
      error: latest ? error : previous.error,
      pricing: pricing ?? previous?.pricing ?? null,
      at: now,
    });
  }

  function storeOutbound(conversation, message, user) {
    if (!conversation.assignee && user) db.assign(conversation.id, user); // first reply takes the conversation
    let stored = db.addMessage(conversation.id, { direction: 'out', status: 'pending', agent: user, ...message });
    const pending = stored?.wamid && pendingStatuses.get(stored.wamid);
    if (pending) {
      pendingStatuses.delete(stored.wamid);
      stored = db.updateStatus(stored.wamid, pending.status, pending.error?.message, pending.pricing) ?? stored;
    }
    publishMessage('message.created', stored);
    publishConversation(conversation.id);
    return stored;
  }

  // ---- webhook events -------------------------------------------------------

  function onMessage(event) {
    if (event.kind === 'reaction') {
      const updated = event.reaction?.messageId && db.setReaction(event.reaction.messageId, event.reaction.emoji);
      if (updated) publishMessage('message.updated', updated);
      return null;
    }
    const conversation = db.conversationFor(event.from, event.name);
    const message = db.addMessage(conversation.id, {
      wamid: event.wamid,
      direction: 'in',
      kind: event.kind,
      body: event.body,
      mediaId: event.media?.id,
      mediaMime: event.media?.mime,
      filename: event.media?.filename,
      data: event.data,
      replyTo: event.replyTo,
      createdAt: event.timestamp ? event.timestamp * 1000 : undefined,
    });
    if (!message) return null; // webhook retry
    publishMessage('message.created', message);
    publishConversation(conversation.id);
    return message;
  }

  function onStatus(event) {
    const updated = db.updateStatus(event.wamid, event.status, event.error?.message ?? null, event.pricing);
    if (updated) {
      publishMessage('message.updated', updated);
      if (event.status === 'failed') log.warn('message failed', { code: event.error?.code, error: event.error?.message });
    } else if (Object.hasOwn(STATUS_RANK, event.status) && !db.hasMessage(event.wamid)) {
      rememberStatus(event.wamid, event.status, event.error, event.pricing);
    }
  }

  function recordCall(call) {
    if (!call.peer) return null;
    const conversation = db.conversationFor(call.peer, call.peerName);
    if (call.agent && call.answeredAt && !conversation.assignee) db.assign(conversation.id, call.agent);
    const message = db.addMessage(conversation.id, {
      direction: call.direction === 'inbound' ? 'in' : 'out',
      kind: 'call',
      agent: call.agent,
      data: { callId: call.id, outcome: call.outcome, duration: call.duration },
      createdAt: call.createdAt,
    });
    if (message) publishMessage('message.created', message);
    publishConversation(conversation.id);
    return conversation.id;
  }

  // ---- templates ------------------------------------------------------------

  async function templates(refresh = false) {
    if (!config.wabaId) return [];
    if (!refresh && templateCache.list && Date.now() - templateCache.at < TEMPLATE_CACHE_MS) return templateCache.list;
    const data = await graph.listTemplates();
    const list = (data?.data ?? []).filter((t) => t.status === 'APPROVED').map(normalizeTemplate);
    templateCache = { at: Date.now(), list };
    return list;
  }

  async function sendTemplate(conversation, request, user, { permissionOnly = false } = {}) {
    const template = (await templates()).find((t) => t.name === request?.name && t.language === request?.language);
    if (!template) throw new CallError(404, 'template_not_found', 'Template not found or not approved');
    if (!template.supported) throw new CallError(400, 'template_unsupported', 'This template needs media or dynamic buttons');
    if (permissionOnly && !template.callPermission) {
      throw new CallError(400, 'not_permission_template', 'Pick a template with a call permission button');
    }
    const { components, text } = buildTemplate(template, request.params);
    const wamid = await graph.sendTemplate(conversation.waId, template.name, template.language, components);
    return storeOutbound(
      conversation,
      {
        wamid,
        kind: template.callPermission ? 'call_permission_request' : 'template',
        category: template.category ?? 'template',
        body: text,
        data: { template: template.name, language: template.language },
      },
      user,
    );
  }

  // ---- media ----------------------------------------------------------------

  async function proxyMedia(res, mediaId) {
    if (!db.hasMedia(mediaId)) throw new CallError(404, 'not_found', 'Unknown media');
    const info = await graph.mediaInfo(mediaId);
    // The download carries our access token: only to Meta's own media hosts.
    let mediaUrl;
    try {
      mediaUrl = new URL(info?.url);
    } catch {
      throw new CallError(502, 'bad_media_url', 'WhatsApp returned no media URL');
    }
    const allow = (url) =>
      config.demo ||
      (url.protocol === 'https:' && /(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net)$/.test(url.hostname));
    if (!allow(mediaUrl)) throw new CallError(502, 'bad_media_url', 'Unexpected media URL from WhatsApp');
    const upstream = await graph.downloadMedia(mediaUrl.href, allow);
    const mime = String(info.mime_type || upstream.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0]
      .trim()
      .toLowerCase();
    // Anything that could run in the page (HTML, SVG, PDF viewers...) downloads instead.
    const inline = /^(image\/(jpeg|png|webp|gif)|audio\/|video\/)/.test(mime);
    const headers = {
      'content-type': inline ? mime : 'application/octet-stream',
      'content-disposition': inline ? 'inline' : 'attachment',
      'cache-control': 'private, no-store', // shared computers: nothing stays in the browser cache
      'content-security-policy': "default-src 'none'; sandbox",
    };
    const length = upstream.headers.get('content-length');
    if (length) headers['content-length'] = length;
    res.writeHead(200, headers);
    await pipeline(Readable.fromWeb(upstream.body), res);
  }

  // ---- routes ---------------------------------------------------------------

  async function conversationAction(req, res, url, user, conversation, action, role) {
    const method = req.method;

    if (method === 'DELETE' && action === '') {
      if (role !== 'admin') throw new CallError(403, 'admins_only', 'Only administrators can delete conversations');
      db.deleteConversation(conversation.id);
      hub.send('conversation.deleted', { id: conversation.id });
      log.info('conversation deleted', { by: user });
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && action === '') {
      const { messages, hasMore } = db.messages(conversation.id);
      return sendJson(res, 200, { conversation: view(conversation), messages, hasMore });
    }
    if (method === 'GET' && action === 'messages') {
      const before = Number(url.searchParams.get('before')) || undefined;
      return sendJson(res, 200, db.messages(conversation.id, { before }));
    }
    if (method === 'GET' && action === 'permission') {
      const data = await graph.callPermissions(conversation.waId);
      const actions = new Map((data?.actions ?? []).map((item) => [item.action_name, item]));
      return sendJson(res, 200, {
        status: data?.permission?.status ?? 'unknown',
        expiresAt: data?.permission?.expiration_time ?? data?.permission?.expiration ?? null,
        canCall: actions.get('start_call')?.can_perform_action ?? null,
        canRequest: actions.get('send_call_permission_request')?.can_perform_action ?? null,
      });
    }
    if (method !== 'POST') return false;

    const body = await readJson(req);
    switch (action) {
      case 'messages': {
        const text = String(body.text ?? '').trim();
        if (!text) throw new CallError(400, 'empty', 'Write a message first');
        if (text.length > 4096) throw new CallError(400, 'too_long', 'WhatsApp messages are limited to 4096 characters');
        if (!windowOpen(conversation)) {
          throw new CallError(409, 'window_closed', 'More than 24 hours since their last message: send a template');
        }
        const wamid = await graph.sendText(conversation.waId, text);
        return sendJson(res, 200, {
          message: storeOutbound(conversation, { wamid, kind: 'text', category: 'service', body: text }, user),
        });
      }
      case 'template':
        return sendJson(res, 200, { message: await sendTemplate(conversation, body, user) });
      case 'permission-request': {
        if (body.template) {
          return sendJson(res, 200, { message: await sendTemplate(conversation, body.template, user, { permissionOnly: true }) });
        }
        if (!windowOpen(conversation)) {
          throw new CallError(409, 'window_closed', 'Outside the 24-hour window the request has to be a template');
        }
        const text = String(body.text || config.permissionRequestText || DEFAULT_PERMISSION_TEXT).trim().slice(0, 1024);
        const wamid = await graph.sendPermissionRequest(conversation.waId, text);
        log.info('call permission requested', { agent: user });
        return sendJson(res, 200, {
          message: storeOutbound(conversation, { wamid, kind: 'call_permission_request', category: 'service', body: text }, user),
        });
      }
      case 'read': {
        const lastInbound = conversation.unread > 0 ? db.lastInboundWamid(conversation.id) : null;
        db.markRead(conversation.id);
        publishConversation(conversation.id);
        if (lastInbound) {
          graph.markRead(lastInbound).catch((error) => log.debug('read receipt failed', { error: error.message }));
        }
        return sendJson(res, 200, { ok: true });
      }
      case 'assign': {
        const agent = body.agent ? String(body.agent) : null;
        if (agent && !users.get(agent)) throw new CallError(400, 'unknown_agent', 'Unknown operator');
        db.assign(conversation.id, agent);
        return sendJson(res, 200, { conversation: view(publishConversation(conversation.id)) });
      }
      case 'status': {
        if (!['open', 'resolved'].includes(body.status)) throw new CallError(400, 'bad_status', 'Status must be open or resolved');
        db.setStatus(conversation.id, body.status);
        return sendJson(res, 200, { conversation: view(publishConversation(conversation.id)) });
      }
      default:
        return false;
    }
  }

  async function handle(req, res, url, session) {
    const user = session.username;
    const { pathname } = url;
    const method = req.method;

    if (pathname === '/api/conversations') {
      if (method === 'GET') {
        const params = url.searchParams;
        const filter = ['mine', 'unassigned', 'all'].includes(params.get('filter')) ? params.get('filter') : 'all';
        const status = params.get('status') === 'resolved' ? 'resolved' : 'open';
        const conversations = db.conversations({ filter, status, agent: user, q: params.get('q') ?? '' }).map(view);
        sendJson(res, 200, { conversations, counts: db.counts(user) });
        return true;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const waId = normalizeNumber(body.to);
        if (!waId) throw new CallError(400, 'bad_number', 'Use the full number with country code (digits only)');
        sendJson(res, 200, { conversation: view(db.conversationFor(waId)) });
        return true;
      }
    }

    if (pathname === '/api/templates' && method === 'GET') {
      if (!config.wabaId) {
        sendJson(res, 200, { enabled: false, templates: [] });
        return true;
      }
      try {
        sendJson(res, 200, { enabled: true, templates: await templates(url.searchParams.has('refresh')) });
      } catch (error) {
        sendJson(res, 200, { enabled: true, templates: [], error: error.message });
      }
      return true;
    }

    const media = pathname.match(/^\/api\/media\/([\w.-]{1,128})$/);
    if (media && method === 'GET') {
      await proxyMedia(res, media[1]);
      return true;
    }

    const match = pathname.match(/^\/api\/conversations\/(\d+)(?:\/([a-z-]+))?$/);
    if (!match) return false;
    const conversation = db.conversation(Number(match[1]));
    if (!conversation) throw new CallError(404, 'not_found', 'Conversation not found');
    const handled = await conversationAction(req, res, url, user, conversation, match[2] ?? '', session.role);
    return handled !== false;
  }

  return { handle, onMessage, onStatus, recordCall, view };
}
