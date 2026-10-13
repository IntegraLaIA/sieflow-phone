// The message log: monthly counts, Meta's pricing, retention and the CSV.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, Store } from '../src/db.js';
import { csvCell, FREE_SERVICE_MESSAGES, summarize } from '../src/usage.js';

const DAY = 86_400_000;
const OCT = Date.UTC(2026, 9, 5);

test('the message log counts each month by category, operator and what Meta billed', () => {
  const db = new Store();
  const { id } = db.conversationFor('573001112233', 'Ana');
  db.addMessage(id, { wamid: 'in-0', direction: 'in', kind: 'text', body: 'antes', createdAt: Date.UTC(2026, 8, 20) });
  db.addMessage(id, { wamid: 'in-1', direction: 'in', kind: 'text', body: 'hola', createdAt: OCT });
  const reply = { direction: 'out', kind: 'text', category: 'service', body: 'hi', status: 'pending' };
  db.addMessage(id, { ...reply, wamid: 'out-1', agent: 'luis', createdAt: OCT + 1 });
  db.addMessage(id, { ...reply, wamid: 'out-3', agent: 'ana', createdAt: OCT + 3 });
  db.addMessage(id, {
    wamid: 'out-2',
    direction: 'out',
    kind: 'template',
    category: 'marketing',
    body: 'promo',
    status: 'pending',
    agent: 'luis',
    data: { template: 'promo' },
    createdAt: OCT + 2,
  });
  db.addMessage(id, { direction: 'out', kind: 'call', agent: 'ana', data: { outcome: 'completed', duration: 65 }, createdAt: OCT + 4 });
  db.addMessage(id, { direction: 'in', kind: 'call', agent: 'luis', data: { outcome: 'completed', duration: 30 }, createdAt: OCT + 5 });

  const free = db.updateStatus('out-1', 'delivered', null, { billable: false, category: 'service', type: 'free_customer_service' });
  assert.equal(free.billable, false);
  assert.equal(free.pricingType, 'free_customer_service');
  assert.equal(db.updateStatus('out-2', 'sent', null, { billable: true, category: 'marketing', type: 'regular' }).billable, true);
  db.updateStatus('out-2', 'read');
  assert.ok(db.updateStatus('out-2', 'read', null, { billable: true, category: 'marketing', type: 'regular' }), 'pricing alone is an update');
  db.updateStatus('out-3', 'failed', 'Re-engagement');

  const usage = db.usage('2026-09');
  assert.deepEqual(usage.get('2026-09'), { received: 1 });
  assert.deepEqual(usage.get('2026-10'), {
    received: 1,
    'sent.service': 2,
    'delivered.service': 1,
    'sent.marketing': 1,
    'delivered.marketing': 1,
    billable: 1,
    failed: 1,
    'agent.luis.messages': 2,
    'agent.ana.messages': 1,
    'calls.out': 1,
    'calls.out_seconds': 65,
    'calls.in': 1,
    'calls.in_seconds': 30,
    'agent.ana.calls': 1,
    'agent.luis.calls': 1,
  });

  const october = summarize('2026-10', usage.get('2026-10'));
  assert.deepEqual(october.service, { delivered: 1, free: FREE_SERVICE_MESSAGES, overFree: 0 });
  assert.equal(october.sent.total, 3);
  assert.equal(october.delivered.total, 2);
  assert.deepEqual(october.calls, { in: 1, out: 1, inSeconds: 30, outSeconds: 65 });
  assert.deepEqual(october.agents, [
    { agent: 'luis', messages: 2, calls: 1 },
    { agent: 'ana', messages: 1, calls: 1 },
  ]);
  assert.equal(summarize('2026-11', { 'delivered.service': 1200 }).service.overFree, 200);
  assert.equal(summarize('2026-11').received, 0);
});

test('pruned and erased messages leave their monthly counts behind', () => {
  const db = new Store();
  const a = db.conversationFor('111111111', 'A');
  const b = db.conversationFor('222222222', 'B');
  db.addMessage(a.id, { wamid: 'a1', direction: 'in', kind: 'text', body: 'x', createdAt: OCT });
  db.addMessage(a.id, {
    wamid: 'a2',
    direction: 'out',
    kind: 'text',
    category: 'service',
    status: 'delivered',
    agent: 'ana',
    body: 'y',
    createdAt: OCT + 1,
  });
  db.addMessage(b.id, { wamid: 'b1', direction: 'in', kind: 'text', body: 'z', createdAt: OCT + 10 * DAY });
  const counted = db.usage('2026-10').get('2026-10');
  assert.deepEqual(counted, { received: 2, 'sent.service': 1, 'delivered.service': 1, 'agent.ana.messages': 1 });

  assert.equal(db.prune(OCT + DAY), 2);
  assert.deepEqual(db.usage('2026-10').get('2026-10'), counted);
  assert.equal(db.deleteConversation(b.id), true);
  assert.deepEqual(db.usage('2026-10').get('2026-10'), counted);
  assert.equal(db.messageLog({ month: '2026-10' }).messages.length, 0, 'the detail goes, the counts stay');
});

test('the message log lists one month without the message text, filtered and page by page', () => {
  const db = new Store();
  const start = Date.UTC(2026, 9, 1);
  const { id } = db.conversationFor('573001112233', 'Ana');
  for (let i = 0; i < 3; i += 1) {
    db.addMessage(id, { wamid: `in-${i}`, direction: 'in', kind: 'text', body: 'secreto', createdAt: start + i });
  }
  db.addMessage(id, {
    wamid: 'out',
    direction: 'out',
    kind: 'template',
    category: 'utility',
    data: { template: 'pedido' },
    agent: 'luis',
    body: 'secreto',
    createdAt: start + 10,
  });
  db.addMessage(id, { direction: 'in', kind: 'call', agent: 'ana', data: { outcome: 'completed', duration: 12 }, createdAt: start + 20 });
  db.addMessage(id, { wamid: 'nov', direction: 'in', kind: 'text', body: 'later', createdAt: Date.UTC(2026, 10, 1) });
  db.addMessage(id, { wamid: 'sep', direction: 'in', kind: 'text', body: 'earlier', createdAt: start - 1 });

  const all = db.messageLog({ month: '2026-10' });
  assert.equal(all.messages.length, 5);
  assert.equal(all.hasMore, false);
  assert.ok(all.messages.every((entry) => !('body' in entry) && entry.waId === '573001112233' && entry.name === 'Ana'));
  assert.equal(all.messages[0].kind, 'call');
  assert.equal(all.messages[0].duration, 12);
  assert.equal(all.messages[0].outcome, 'completed');

  const sent = db.messageLog({ month: '2026-10', filter: 'sent' }).messages;
  assert.deepEqual(
    sent.map((entry) => [entry.template, entry.category, entry.agent]),
    [['pedido', 'utility', 'luis']],
  );
  assert.equal(db.messageLog({ month: '2026-10', filter: 'calls' }).messages.length, 1);
  assert.equal(db.messageLog({ month: '2026-10', agent: 'luis' }).messages.length, 1);

  const first = db.messageLog({ month: '2026-10', filter: 'received', limit: 2 });
  assert.equal(first.hasMore, true);
  const rest = db.messageLog({ month: '2026-10', filter: 'received', limit: 2, before: first.messages.at(-1).id });
  assert.equal(rest.messages.length, 1);
  assert.equal(rest.hasMore, false);
});

test('migration 3 sorts the messages already sent into service and templates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sieflow-phone-'));
  try {
    const raw = new DatabaseSync(join(dir, 'sieflow-phone.db'));
    for (const sql of MIGRATIONS.slice(0, 2)) raw.exec(sql);
    raw.exec('PRAGMA user_version = 2');
    raw.exec(`INSERT INTO contacts (wa_id, created_at, updated_at) VALUES ('1317', 1, 1)`);
    raw.exec(`INSERT INTO conversations (wa_id, created_at, updated_at) VALUES ('1317', 1, 1)`);
    const insert = raw.prepare('INSERT INTO messages (conversation_id, direction, kind, data, created_at) VALUES (1, ?, ?, ?, 1)');
    insert.run('out', 'text', null);
    insert.run('out', 'template', '{"template":"pedido"}');
    insert.run('out', 'call_permission_request', '{"template":"permiso"}');
    insert.run('out', 'call_permission_request', null);
    insert.run('in', 'text', null);
    insert.run('out', 'call', '{"duration":5}');
    raw.close();

    const db = new Store({ dataDir: dir });
    const categories = db.db
      .prepare('SELECT category FROM messages ORDER BY id')
      .all()
      .map((row) => row.category);
    assert.deepEqual(categories, ['service', 'template', 'template', 'service', null, null]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CSV cells are quoted and never start a spreadsheet formula', () => {
  assert.equal(csvCell('Ana'), 'Ana');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(12), '12');
  assert.equal(csvCell('Pérez, Ana'), '"Pérez, Ana"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+57 300'), "'+57 300");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
});
