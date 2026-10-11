import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWebhook, signBody, verifySignature } from '../src/webhook.js';

const PNID = '106540352242922';

function envelope(field, value, phoneNumberId = PNID) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field,
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

test('signatures are checked against the raw body', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const header = signBody(body, 'app-secret');
  assert.equal(verifySignature(body, header, 'app-secret'), true);
  assert.equal(verifySignature(body, header, 'other-secret'), false);
  assert.equal(verifySignature(Buffer.from('{}'), header, 'app-secret'), false);
  assert.equal(verifySignature(body, undefined, 'app-secret'), false);
  assert.equal(verifySignature(body, 'sha256=zz', 'app-secret'), false);
  assert.equal(verifySignature(body, header, ''), false);
});

test('a user-initiated connect without "direction" is an inbound call with an offer', () => {
  const events = parseWebhook(
    envelope('calls', {
      contacts: [{ profile: { name: 'Pablo' }, wa_id: '13175551399' }],
      calls: [
        {
          id: 'wacid.1',
          from: '13175551399',
          to: '15550783881',
          event: 'connect',
          timestamp: '1671644824',
          session: { sdp_type: 'offer', sdp: 'v=0 offer' },
        },
      ],
    }),
    PNID,
  );
  assert.deepEqual(events, [
    {
      type: 'call.connect',
      callId: 'wacid.1',
      direction: 'USER_INITIATED',
      peer: '13175551399',
      peerName: 'Pablo',
      sdpType: 'offer',
      sdp: 'v=0 offer',
    },
  ]);
});

test('a business-initiated connect carries the SDP answer and the callee as peer', () => {
  const [event] = parseWebhook(
    envelope('calls', {
      calls: [
        {
          id: 'wacid.2',
          from: '15550783881',
          to: '13175551399',
          event: 'connect',
          direction: 'BUSINESS_INITIATED',
          session: { sdp_type: 'answer', sdp: 'v=0 answer' },
        },
      ],
    }),
  );
  assert.equal(event.direction, 'BUSINESS_INITIATED');
  assert.equal(event.peer, '13175551399');
  assert.equal(event.sdpType, 'answer');
});

test('call statuses and terminate events are normalized', () => {
  const events = parseWebhook(
    envelope('calls', {
      statuses: [
        { id: 'wacid.2', type: 'call', status: 'RINGING' },
        { id: 'wamid.x', type: 'message', status: 'read' },
      ],
      calls: [
        {
          id: 'wacid.2',
          from: '15550783881',
          to: '13175551399',
          event: 'terminate',
          direction: 'BUSINESS_INITIATED',
          status: 'FAILED',
          errors: [{ code: 138002, message: 'Call rejected' }],
        },
      ],
    }),
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ['call.terminate', 'call.status'],
  );
  const terminate = events[0];
  assert.equal(terminate.status, 'FAILED');
  assert.equal(terminate.duration, null);
  assert.deepEqual(terminate.error, { code: 138002, message: 'Call rejected' });
  assert.deepEqual(events[1], { type: 'call.status', callId: 'wacid.2', status: 'RINGING' });
});

test('terminate keeps the duration Meta reports', () => {
  const [event] = parseWebhook(
    envelope('calls', {
      calls: [{ id: 'wacid.1', from: '1317', to: '1555', event: 'terminate', direction: 'USER_INITIATED', status: 'COMPLETED', duration: 42 }],
    }),
  );
  assert.equal(event.duration, 42);
  assert.equal(event.error, null);
});

test('call permission replies arrive as messages', () => {
  const [event] = parseWebhook(
    envelope('messages', {
      contacts: [{ profile: { name: 'Pablo' }, wa_id: '13175551399' }],
      messages: [
        {
          from: '13175551399',
          id: 'wamid.reply',
          timestamp: '1760000000',
          type: 'interactive',
          context: { id: 'wamid.request' },
          interactive: {
            type: 'call_permission_reply',
            call_permission_reply: { response: 'accept', is_permanent: false, expiration_timestamp: '1768550400' },
          },
        },
      ],
    }),
  );
  assert.deepEqual(event, {
    type: 'message.received',
    wamid: 'wamid.reply',
    from: '13175551399',
    name: 'Pablo',
    timestamp: 1760000000,
    replyTo: 'wamid.request',
    kind: 'call_permission_reply',
    body: null,
    data: { response: 'accept', isPermanent: false, expiresAt: 1768550400 },
  });
});

test('incoming messages of every kind are normalized', () => {
  const events = parseWebhook(
    envelope('messages', {
      contacts: [{ profile: { name: 'Pablo' }, wa_id: '1317' }],
      messages: [
        { from: '1317', id: 'm1', type: 'text', text: { body: 'hola' } },
        { from: '1317', id: 'm2', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'factura' } },
        { from: '1317', id: 'm3', type: 'audio', audio: { id: 'media-2', mime_type: 'audio/ogg', voice: true } },
        { from: '1317', id: 'm4', type: 'location', location: { latitude: 4.6, longitude: -74.1, name: 'Oficina' } },
        { from: '1317', id: 'm5', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Sí' } } },
        { from: '1317', id: 'm6', type: 'reaction', reaction: { message_id: 'm0', emoji: '👍' } },
        { from: '1317', id: 'm7', type: 'order', order: {} },
      ],
    }),
  );
  assert.deepEqual(
    events.map((e) => [e.kind, e.body ?? null]),
    [
      ['text', 'hola'],
      ['image', 'factura'],
      ['audio', null],
      ['location', 'Oficina'],
      ['reply', 'Sí'],
      ['reaction', null],
      ['unsupported', null],
    ],
  );
  assert.deepEqual(events[1].media, { id: 'media-1', mime: 'image/jpeg', filename: null });
  assert.deepEqual(events[2].data, { voice: true });
  assert.deepEqual(events[3].data, { latitude: 4.6, longitude: -74.1 });
  assert.deepEqual(events[5].reaction, { messageId: 'm0', emoji: '👍' });
  assert.equal(events[6].data.type, 'order');
});

test('message delivery statuses carry their errors', () => {
  const events = parseWebhook(
    envelope('messages', {
      statuses: [
        { id: 'wamid.1', status: 'delivered', recipient_id: '1317' },
        {
          id: 'wamid.2',
          status: 'failed',
          errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'More than 24 hours' } }],
        },
      ],
    }),
  );
  assert.deepEqual(events, [
    { type: 'message.status', wamid: 'wamid.1', status: 'delivered', error: null },
    { type: 'message.status', wamid: 'wamid.2', status: 'failed', error: { code: 131047, message: 'More than 24 hours' } },
  ]);
});

test('events for other phone numbers and other objects are ignored', () => {
  const other = envelope('calls', { calls: [{ id: 'x', event: 'connect', session: { sdp_type: 'offer', sdp: 'v=0' } }] }, '999');
  assert.deepEqual(parseWebhook(other, PNID), []);
  assert.deepEqual(parseWebhook({ object: 'page', entry: [] }, PNID), []);
  assert.deepEqual(parseWebhook(null, PNID), []);
});
