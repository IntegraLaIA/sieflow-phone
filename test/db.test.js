import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.js';
import { buildTemplate, normalizeTemplate, windowOpen } from '../src/inbox.js';

function store() {
  let now = 1_000_000;
  const db = new Store({ now: () => now });
  db.tick = (ms) => (now += ms);
  return db;
}

test('inbound messages open the chat window and count as unread', () => {
  const db = store();
  const conversation = db.conversationFor('573001112233', 'Ana');
  assert.equal(conversation.unread, 0);
  assert.equal(windowOpen(conversation, 1_000_000), false);

  db.addMessage(conversation.id, { wamid: 'w1', direction: 'in', kind: 'text', body: 'hola', createdAt: 1_000_000 });
  const updated = db.conversation(conversation.id);
  assert.equal(updated.unread, 1);
  assert.equal(updated.lastPreview, 'hola');
  assert.equal(updated.name, 'Ana');
  assert.equal(windowOpen(updated, 1_000_000 + 23 * 3_600_000), true);
  assert.equal(windowOpen(updated, 1_000_000 + 25 * 3_600_000), false);
});

test('a retried webhook does not duplicate a message', () => {
  const db = store();
  const { id } = db.conversationFor('1317');
  assert.ok(db.addMessage(id, { wamid: 'same', direction: 'in', kind: 'text', body: 'a' }));
  assert.equal(db.addMessage(id, { wamid: 'same', direction: 'in', kind: 'text', body: 'a' }), null);
  assert.equal(db.messages(id).messages.length, 1);
});

test('delivery statuses only move forward and failures always win', () => {
  const db = store();
  const { id } = db.conversationFor('1317');
  db.addMessage(id, { wamid: 'out-1', direction: 'out', kind: 'text', body: 'hi', status: 'pending' });
  assert.equal(db.updateStatus('out-1', 'delivered').status, 'delivered');
  assert.equal(db.updateStatus('out-1', 'sent'), null, 'no going back');
  assert.equal(db.updateStatus('out-1', 'failed', 'Re-engagement').error, 'Re-engagement');
  assert.equal(db.updateStatus('out-1', 'read'), null, 'a failed message stays failed');
  assert.equal(db.updateStatus('unknown', 'read'), null);
  assert.equal(db.updateStatus('out-1', '__proto__'), null, 'only known statuses');
});

test('replying keeps the conversation open, an inbound message reopens it', () => {
  const db = store();
  const { id } = db.conversationFor('1317');
  db.setStatus(id, 'resolved');
  db.addMessage(id, { wamid: 'o', direction: 'out', kind: 'text', body: 'bye' });
  assert.equal(db.conversation(id).status, 'resolved');
  db.addMessage(id, { wamid: 'i', direction: 'in', kind: 'text', body: 'one more thing' });
  assert.equal(db.conversation(id).status, 'open');
});

test('filters and counts follow the assignee', () => {
  const db = store();
  const a = db.conversationFor('111111111', 'Ana');
  const b = db.conversationFor('222222222', 'Beto');
  db.addMessage(a.id, { wamid: 'a1', direction: 'in', kind: 'text', body: 'x' });
  db.addMessage(b.id, { wamid: 'b1', direction: 'in', kind: 'text', body: 'y' });
  db.assign(a.id, 'luis');
  assert.deepEqual(db.conversations({ filter: 'mine', agent: 'luis' }).map((c) => c.name), ['Ana']);
  assert.deepEqual(db.conversations({ filter: 'unassigned', agent: 'luis' }).map((c) => c.name), ['Beto']);
  assert.equal(db.conversations({ filter: 'all', q: 'bet' }).length, 1);
  assert.equal(db.conversations({ filter: 'all', q: '2222' }).length, 1);
  assert.deepEqual(db.counts('luis'), { mine: 1, unassigned: 1, total: 2, unread: 2 });
  db.markRead(a.id);
  assert.equal(db.counts('luis').unread, 1);
});

test('missed calls count as unread and show up in recent calls with the contact name', () => {
  const db = store();
  const { id } = db.conversationFor('1317', 'Pablo');
  db.addMessage(id, { direction: 'in', kind: 'call', data: { callId: 'c1', outcome: 'missed', duration: 0 } });
  assert.equal(db.conversation(id).unread, 1);
  const [call] = db.recentCalls();
  assert.equal(call.id, 'c1');
  assert.equal(call.peerName, 'Pablo');
  assert.equal(call.outcome, 'missed');
  assert.equal(call.direction, 'inbound');
});

test('older messages load page by page', () => {
  const db = store();
  const { id } = db.conversationFor('1317');
  for (let i = 0; i < 5; i += 1) db.addMessage(id, { wamid: `m${i}`, direction: 'in', kind: 'text', body: String(i) });
  const first = db.messages(id, { limit: 3 });
  assert.deepEqual(first.messages.map((m) => m.body), ['2', '3', '4']);
  assert.equal(first.hasMore, true);
  const older = db.messages(id, { limit: 3, before: first.messages[0].id });
  assert.deepEqual(older.messages.map((m) => m.body), ['0', '1']);
  assert.equal(older.hasMore, false);
});

test('retention prunes old messages and their previews', () => {
  const db = store();
  const { id } = db.conversationFor('1317', 'Pablo');
  db.addMessage(id, { wamid: 'old', direction: 'in', kind: 'text', body: 'old secret', createdAt: 1_000 });
  db.addMessage(id, { wamid: 'new', direction: 'in', kind: 'text', body: 'recent', createdAt: 5_000_000 });
  assert.equal(db.prune(2_000_000), 1);
  assert.deepEqual(db.messages(id).messages.map((m) => m.body), ['recent']);
  assert.equal(db.deleteConversation(id), true);
  assert.equal(db.conversation(id), null);
  assert.equal(db.deleteConversation(id), false);
});

test('settings and operators persist in the database', () => {
  const db = store();
  db.setSettings({ phoneNumberId: '123', verifyToken: 'abc' });
  db.setSettings({ verifyToken: '' });
  assert.deepEqual(db.settings(), { phoneNumberId: '123' });
  db.createUser('ana', 'scrypt:x:y', 'admin');
  assert.equal(db.user('ana').role, 'admin');
  assert.equal(db.setRole('ana', 'agent'), true);
  assert.equal(db.deleteUser('ana'), true);
  assert.equal(db.user('ana'), null);
});

test('templates: placeholders, unsupported formats and the call permission button', () => {
  const positional = normalizeTemplate({
    name: 'pedido',
    language: 'es',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Pedido {{1}}' },
      { type: 'BODY', text: 'Hola {{1}}, tu pedido {{2}} sale {{2}}.' },
      { type: 'CALL_PERMISSION_REQUEST' },
    ],
  });
  assert.deepEqual(positional.bodyParams, ['1', '2']);
  assert.equal(positional.callPermission, true);
  assert.equal(positional.supported, true);
  const built = buildTemplate(positional, { header: ['4512'], body: ['Ana', 'hoy\nen la tarde'] });
  assert.equal(built.text, 'Pedido 4512\n\nHola Ana, tu pedido hoy en la tarde sale hoy en la tarde.');
  assert.deepEqual(built.components[1], {
    type: 'body',
    parameters: [
      { type: 'text', text: 'Ana' },
      { type: 'text', text: 'hoy en la tarde' },
    ],
  });
  assert.throws(() => buildTemplate(positional, { header: ['1'], body: ['only one'] }), { code: 'bad_params' });

  const named = normalizeTemplate({ name: 'n', language: 'es', parameter_format: 'NAMED', components: [{ type: 'BODY', text: 'Hola {{nombre}}' }] });
  assert.deepEqual(buildTemplate(named, { body: ['Ana'] }).components[0].parameters, [
    { type: 'text', parameter_name: 'nombre', text: 'Ana' },
  ]);

  const media = normalizeTemplate({ name: 'm', language: 'es', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'x' }] });
  assert.equal(media.supported, false);
  assert.equal(media.reason, 'media_header');
});
