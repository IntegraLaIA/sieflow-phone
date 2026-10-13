// WhatsApp Cloud API webhooks: signature check and normalization of call and
// message payloads into small event objects.

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(rawBody, header, appSecret) {
  if (typeof header !== 'string' || !header.startsWith('sha256=') || !appSecret) return false;
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signBody(rawBody, appSecret) {
  return 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

function firstError(errors) {
  const error = Array.isArray(errors) ? errors[0] : null;
  if (!error) return null;
  return {
    code: error.code ?? null,
    message: error.error_data?.details || error.message || error.title || null,
  };
}

const toNumber = (value) => (value === undefined || value === null || value === '' ? null : Number(value));

// What Meta says it charges for a message, as sent in its status webhooks:
// { billable, pricing_model: "PMP", category: "service" | "utility" | ..., type: "regular" | ... }.
function parsePricing(pricing) {
  if (!pricing || typeof pricing !== 'object') return null;
  const text = (value) => (value === undefined || value === null || value === '' ? null : String(value).toLowerCase().slice(0, 40));
  return {
    billable: typeof pricing.billable === 'boolean' ? pricing.billable : null,
    category: text(pricing.category),
    type: text(pricing.type),
    model: text(pricing.pricing_model),
  };
}

const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'document', 'sticker']);

// One incoming WhatsApp message -> { kind, body, media?, data?, reaction? }
function parseMessage(message) {
  const type = message.type;
  if (type === 'text') return { kind: 'text', body: message.text?.body ?? '' };

  if (MEDIA_KINDS.has(type)) {
    const media = message[type] ?? {};
    return {
      kind: type,
      body: media.caption ?? null,
      media: { id: media.id ?? null, mime: media.mime_type ?? null, filename: media.filename ?? null },
      data: type === 'audio' && media.voice ? { voice: true } : null,
    };
  }

  if (type === 'location') {
    const location = message.location ?? {};
    return {
      kind: 'location',
      body: [location.name, location.address].filter(Boolean).join(', ') || null,
      data: { latitude: location.latitude ?? null, longitude: location.longitude ?? null },
    };
  }

  if (type === 'contacts') {
    const lines = (message.contacts ?? []).map((contact) =>
      [contact.name?.formatted_name, ...(contact.phones ?? []).map((p) => p.phone)].filter(Boolean).join(' '),
    );
    return { kind: 'contacts', body: lines.join('\n') || null };
  }

  if (type === 'interactive') {
    const interactive = message.interactive ?? {};
    if (interactive.type === 'call_permission_reply') {
      const reply = interactive.call_permission_reply ?? {};
      return {
        kind: 'call_permission_reply',
        body: null,
        data: {
          response: reply.response ?? null,
          isPermanent: Boolean(reply.is_permanent),
          expiresAt: toNumber(reply.expiration_timestamp),
        },
      };
    }
    const reply = interactive.button_reply ?? interactive.list_reply;
    if (reply) return { kind: 'reply', body: reply.title ?? '', data: { id: reply.id ?? null } };
    return { kind: 'unsupported', body: null, data: { type: `interactive:${interactive.type}` } };
  }

  if (type === 'button') {
    return { kind: 'reply', body: message.button?.text ?? '', data: { payload: message.button?.payload ?? null } };
  }

  if (type === 'reaction') {
    return { kind: 'reaction', reaction: { messageId: message.reaction?.message_id ?? null, emoji: message.reaction?.emoji ?? '' } };
  }

  return { kind: 'unsupported', body: null, data: { type: type ?? 'unknown' } };
}

// Returns events in delivery order:
//   call.connect      { callId, direction, peer, peerName, sdpType, sdp }
//   call.status       { callId, status }                    RINGING | ACCEPTED | REJECTED
//   call.terminate    { callId, direction, peer, status, duration, error }
//   message.received  { wamid, from, name, timestamp, replyTo, kind, body, media?, data?, reaction? }
//   message.status    { wamid, status, error, pricing }      sent | delivered | read | failed
export function parseWebhook(payload, phoneNumberId) {
  const events = [];
  if (!payload || payload.object !== 'whatsapp_business_account') return events;

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const pnid = value.metadata?.phone_number_id;
      if (phoneNumberId && pnid && pnid !== phoneNumberId) continue;
      const names = new Map((value.contacts ?? []).map((c) => [c.wa_id ?? c.user_id, c.profile?.name ?? null]));

      if (change.field === 'calls') {
        for (const call of value.calls ?? []) {
          // User-initiated connect webhooks carry an SDP offer and may omit "direction".
          const direction =
            call.direction ?? (call.session?.sdp_type === 'answer' ? 'BUSINESS_INITIATED' : 'USER_INITIATED');
          const peer =
            direction === 'USER_INITIATED' ? (call.from ?? call.from_user_id) : (call.to ?? call.to_user_id);
          const base = { callId: call.id, direction, peer: peer ?? null, peerName: names.get(peer) ?? null };

          if (call.event === 'connect') {
            events.push({
              type: 'call.connect',
              ...base,
              sdpType: call.session?.sdp_type ?? null,
              sdp: call.session?.sdp ?? null,
            });
          } else if (call.event === 'terminate') {
            events.push({
              type: 'call.terminate',
              ...base,
              status: call.status ?? null,
              duration: toNumber(call.duration),
              error: firstError(call.errors ?? value.errors),
            });
          }
        }
        for (const status of value.statuses ?? []) {
          if (status.type && status.type !== 'call') continue;
          events.push({ type: 'call.status', callId: status.id, status: status.status ?? null });
        }
      } else if (change.field === 'messages') {
        for (const message of value.messages ?? []) {
          const from = message.from ?? message.from_user_id ?? null;
          if (!from) continue;
          events.push({
            type: 'message.received',
            wamid: message.id ?? null,
            from,
            name: names.get(from) ?? null,
            timestamp: toNumber(message.timestamp),
            replyTo: message.context?.id ?? null,
            ...parseMessage(message),
          });
        }
        for (const status of value.statuses ?? []) {
          if (!status.id || !status.status) continue;
          events.push({
            type: 'message.status',
            wamid: status.id,
            status: status.status,
            error: firstError(status.errors),
            pricing: parsePricing(status.pricing),
          });
        }
      }
    }
  }
  return events;
}
