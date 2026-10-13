// Conversations, messages and the call log in one SQLite file (node:sqlite,
// built into Node). Without DATA_DIR the database lives in memory.

import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS = [
  `CREATE TABLE contacts (
     wa_id TEXT PRIMARY KEY,
     name TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE conversations (
     id INTEGER PRIMARY KEY,
     wa_id TEXT NOT NULL UNIQUE REFERENCES contacts(wa_id),
     status TEXT NOT NULL DEFAULT 'open',
     assignee TEXT,
     unread INTEGER NOT NULL DEFAULT 0,
     last_message_at INTEGER,
     last_inbound_at INTEGER,
     last_kind TEXT,
     last_preview TEXT,
     last_direction TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX conversations_recent ON conversations(status, last_message_at DESC);
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY,
     conversation_id INTEGER NOT NULL REFERENCES conversations(id),
     wamid TEXT UNIQUE,
     direction TEXT NOT NULL,
     kind TEXT NOT NULL,
     body TEXT,
     media_id TEXT,
     media_mime TEXT,
     filename TEXT,
     data TEXT,
     reply_to TEXT,
     status TEXT,
     error TEXT,
     agent TEXT,
     reaction TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX messages_thread ON messages(conversation_id, id);
   CREATE INDEX messages_kind ON messages(kind, id);
   CREATE INDEX messages_media ON messages(media_id);`,
  `CREATE TABLE users (
     username TEXT PRIMARY KEY,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'agent',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  // 3: what each message costs. "category" is what SieFlow Phone sent (service
  // for free-form replies, or the template's category); billable and pricing_*
  // are what Meta reports in its status webhooks. usage_archive keeps the monthly
  // counts of messages that RETENTION_DAYS or an erasure removes (counts only).
  `ALTER TABLE messages ADD COLUMN category TEXT;
   ALTER TABLE messages ADD COLUMN billable INTEGER;
   ALTER TABLE messages ADD COLUMN pricing_category TEXT;
   ALTER TABLE messages ADD COLUMN pricing_type TEXT;
   UPDATE messages SET category = CASE
       WHEN kind = 'template' OR json_extract(data, '$.template') IS NOT NULL THEN 'template'
       ELSE 'service' END
     WHERE direction = 'out' AND kind <> 'call';
   CREATE INDEX messages_created ON messages(created_at);
   CREATE TABLE usage_archive (
     month TEXT NOT NULL,
     metric TEXT NOT NULL,
     value INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (month, metric)
   );`,
];

const STATUS_RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };

const SUMMARY = `
  SELECT c.id, c.wa_id AS waId, k.name, c.status, c.assignee, c.unread,
         c.last_message_at AS lastMessageAt, c.last_inbound_at AS lastInboundAt,
         c.last_kind AS lastKind, c.last_preview AS lastPreview, c.last_direction AS lastDirection,
         c.created_at AS createdAt
  FROM conversations c JOIN contacts k ON k.wa_id = c.wa_id`;

const plain = (row) => (row ? { ...row } : null);

function toMessage(row) {
  if (!row) return null;
  let data = null;
  try {
    data = row.data ? JSON.parse(row.data) : null;
  } catch {
    data = null;
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    wamid: row.wamid,
    direction: row.direction,
    kind: row.kind,
    body: row.body,
    mediaId: row.media_id,
    mediaMime: row.media_mime,
    filename: row.filename,
    data,
    replyTo: row.reply_to,
    status: row.status,
    error: row.error,
    agent: row.agent,
    reaction: row.reaction,
    category: row.category ?? null,
    billable: row.billable === null || row.billable === undefined ? null : row.billable === 1,
    pricingCategory: row.pricing_category ?? null,
    pricingType: row.pricing_type ?? null,
    createdAt: row.created_at,
  };
}

// Months are UTC calendar months, "YYYY-MM".
export const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const monthStart = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
const monthEnd = (month) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);

// Messages grouped by everything the monthly counts depend on.
const USAGE_ROWS = `
  SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS month, direction, kind, category, status, billable, agent,
         COUNT(*) AS n,
         COALESCE(SUM(CASE WHEN kind = 'call' THEN json_extract(data, '$.duration') END), 0) AS seconds
  FROM messages`;
const USAGE_GROUP = 'GROUP BY month, direction, kind, category, status, billable, agent';

// One group of messages -> what it adds to its month. The same rules count live
// messages and the ones about to be pruned or erased, so the counts outlive them.
function addUsage(metrics, row) {
  const add = (metric, value = row.n) => {
    if (value) metrics[metric] = (metrics[metric] ?? 0) + value;
  };
  if (row.kind === 'call') {
    const side = row.direction === 'in' ? 'in' : 'out';
    add(`calls.${side}`);
    add(`calls.${side}_seconds`, Math.round(Number(row.seconds) || 0));
    if (row.agent) add(`agent.${row.agent}.calls`);
    return;
  }
  if (row.direction === 'in') {
    add('received');
    return;
  }
  const category = row.category || 'service';
  add(`sent.${category}`);
  if (row.status === 'delivered' || row.status === 'read') add(`delivered.${category}`);
  if (row.status === 'failed') add('failed');
  if (row.billable === 1) add('billable');
  if (row.agent) add(`agent.${row.agent}.messages`);
}

function usageByMonth(rows, months = new Map()) {
  for (const row of rows) {
    if (!months.has(row.month)) months.set(row.month, {});
    addUsage(months.get(row.month), row);
  }
  return months;
}

function logEntry(row) {
  const message = toMessage(row);
  return {
    id: message.id,
    conversationId: message.conversationId,
    createdAt: message.createdAt,
    direction: message.direction,
    kind: message.kind,
    category: message.category,
    template: message.data?.template ?? null,
    status: message.status,
    error: message.error,
    billable: message.billable,
    pricingCategory: message.pricingCategory,
    pricingType: message.pricingType,
    agent: message.agent,
    duration: message.kind === 'call' ? (message.data?.duration ?? 0) : null,
    outcome: message.kind === 'call' ? (message.data?.outcome ?? null) : null,
    waId: row.wa_id,
    name: row.name,
  };
}

export class Store {
  constructor({ dataDir = '', now = () => Date.now() } = {}) {
    let file = ':memory:';
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
      file = join(dataDir, 'sieflow-phone.db');
    }
    this.file = file;
    this.now = now;
    this.db = new DatabaseSync(file);
    if (dataDir) {
      try {
        chmodSync(file, 0o600); // tokens and the app secret live here
      } catch {
        // Not supported on every filesystem (e.g. Windows); the server also sets umask 077.
      }
    }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
    this.#migrate();
    this.#prepare();
  }

  #migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let index = version; index < MIGRATIONS.length; index += 1) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[index]);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  #prepare() {
    const q = (sql) => this.db.prepare(sql);
    this.sql = {
      upsertContact: q(`
        INSERT INTO contacts (wa_id, name, created_at, updated_at) VALUES (:wa_id, :name, :now, :now)
        ON CONFLICT(wa_id) DO UPDATE SET name = COALESCE(excluded.name, contacts.name), updated_at = excluded.updated_at`),
      insertConversation: q(`
        INSERT OR IGNORE INTO conversations (wa_id, created_at, updated_at) VALUES (:wa_id, :now, :now)`),
      conversationById: q(`${SUMMARY} WHERE c.id = ?`),
      conversationByWaId: q(`${SUMMARY} WHERE c.wa_id = ?`),
      listConversations: q(`${SUMMARY}
        WHERE c.status = :status
          AND (:filter = 'all' OR (:filter = 'mine' AND c.assignee = :agent) OR (:filter = 'unassigned' AND c.assignee IS NULL))
          AND (:like = '' OR k.name LIKE :like ESCAPE '\\' OR c.wa_id LIKE :like ESCAPE '\\')
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
        LIMIT :limit`),
      counts: q(`
        SELECT COALESCE(SUM(assignee = :agent), 0) AS mine,
               COALESCE(SUM(assignee IS NULL), 0) AS unassigned,
               COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN assignee = :agent OR assignee IS NULL THEN unread ELSE 0 END), 0) AS unread
        FROM conversations WHERE status = 'open'`),
      insertMessage: q(`
        INSERT OR IGNORE INTO messages
          (conversation_id, wamid, direction, kind, body, media_id, media_mime, filename, data, reply_to, status, error, agent, category, created_at)
        VALUES
          (:conversation_id, :wamid, :direction, :kind, :body, :media_id, :media_mime, :filename, :data, :reply_to, :status, :error, :agent, :category, :created_at)`),
      touchConversation: q(`
        UPDATE conversations SET
          last_message_at = :at, last_kind = :kind, last_preview = :preview, last_direction = :direction,
          unread = unread + :unread,
          last_inbound_at = COALESCE(:inbound_at, last_inbound_at),
          status = CASE WHEN :reopen = 1 THEN 'open' ELSE status END,
          updated_at = :at
        WHERE id = :id`),
      messageById: q('SELECT * FROM messages WHERE id = ?'),
      messageByWamid: q('SELECT * FROM messages WHERE wamid = ?'),
      updateStatus: q('UPDATE messages SET status = :status, error = :error WHERE id = :id'),
      setPricing: q('UPDATE messages SET billable = :billable, pricing_category = :category, pricing_type = :type WHERE id = :id'),
      setReaction: q('UPDATE messages SET reaction = :reaction WHERE id = :id'),
      thread: q('SELECT * FROM messages WHERE conversation_id = :id AND id < :before ORDER BY id DESC LIMIT :limit'),
      lastInbound: q(`SELECT wamid FROM messages WHERE conversation_id = ? AND direction = 'in' AND wamid IS NOT NULL ORDER BY id DESC LIMIT 1`),
      assign: q('UPDATE conversations SET assignee = :agent, updated_at = :now WHERE id = :id'),
      setStatus: q('UPDATE conversations SET status = :status, updated_at = :now WHERE id = :id'),
      markRead: q('UPDATE conversations SET unread = 0 WHERE id = ?'),
      recentCalls: q(`
        SELECT m.*, c.wa_id, k.name FROM messages m
        JOIN conversations c ON c.id = m.conversation_id JOIN contacts k ON k.wa_id = c.wa_id
        WHERE m.kind = 'call' ORDER BY m.id DESC LIMIT ?`),
      hasMedia: q('SELECT 1 AS ok FROM messages WHERE media_id = ? LIMIT 1'),
      pruneMessages: q('DELETE FROM messages WHERE created_at < ?'),
      prunePreviews: q('UPDATE conversations SET last_preview = NULL WHERE last_message_at < ?'),
      deleteMessages: q('DELETE FROM messages WHERE conversation_id = ?'),
      deleteConversation: q('DELETE FROM conversations WHERE id = ?'),
      deleteContact: q('DELETE FROM contacts WHERE wa_id = ?'),
      usageSince: q(`${USAGE_ROWS} WHERE created_at >= ? ${USAGE_GROUP}`),
      usageBefore: q(`${USAGE_ROWS} WHERE created_at < ? ${USAGE_GROUP}`),
      usageOfConversation: q(`${USAGE_ROWS} WHERE conversation_id = ? ${USAGE_GROUP}`),
      archivedUsage: q('SELECT month, metric, value FROM usage_archive WHERE month >= ?'),
      archiveUsage: q(`
        INSERT INTO usage_archive (month, metric, value) VALUES (:month, :metric, :value)
        ON CONFLICT(month, metric) DO UPDATE SET value = value + excluded.value`),
      messageLog: q(`
        SELECT m.*, c.wa_id, k.name FROM messages m
        JOIN conversations c ON c.id = m.conversation_id JOIN contacts k ON k.wa_id = c.wa_id
        WHERE m.created_at >= :from AND m.created_at < :to AND m.id < :before
          AND (:filter = ''
               OR (:filter = 'received' AND m.direction = 'in' AND m.kind <> 'call')
               OR (:filter = 'sent' AND m.direction = 'out' AND m.kind <> 'call')
               OR (:filter = 'calls' AND m.kind = 'call'))
          AND (:agent = '' OR m.agent = :agent)
        ORDER BY m.id DESC LIMIT :limit`),
      allSettings: q('SELECT key, value FROM settings'),
      setSetting: q(`
        INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :now)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
      deleteSetting: q('DELETE FROM settings WHERE key = ?'),
      users: q('SELECT username, password_hash, role, created_at FROM users ORDER BY created_at'),
      user: q('SELECT username, password_hash, role, created_at FROM users WHERE username = ?'),
      insertUser: q(`
        INSERT INTO users (username, password_hash, role, created_at) VALUES (:username, :hash, :role, :now)`),
      updatePassword: q('UPDATE users SET password_hash = :hash WHERE username = :username'),
      updateRole: q('UPDATE users SET role = :role WHERE username = :username'),
      deleteUser: q('DELETE FROM users WHERE username = ?'),
    };
  }

  // ---- settings (key/value, values stored as JSON) ----

  settings() {
    const values = {};
    for (const row of this.sql.allSettings.all()) {
      try {
        values[row.key] = JSON.parse(row.value);
      } catch {
        values[row.key] = row.value;
      }
    }
    return values;
  }

  setSettings(patch) {
    const now = this.now();
    this.db.exec('BEGIN');
    try {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null || value === '') this.sql.deleteSetting.run(key);
        else this.sql.setSetting.run({ key, value: JSON.stringify(value), now });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---- operators ----

  users() {
    return this.sql.users.all().map(plain);
  }

  user(username) {
    return plain(this.sql.user.get(username));
  }

  createUser(username, hash, role) {
    this.sql.insertUser.run({ username, hash, role, now: this.now() });
    return this.user(username);
  }

  setPassword(username, hash) {
    return this.sql.updatePassword.run({ username, hash }).changes > 0;
  }

  setRole(username, role) {
    return this.sql.updateRole.run({ username, role }).changes > 0;
  }

  deleteUser(username) {
    return this.sql.deleteUser.run(username).changes > 0;
  }

  close() {
    this.db.close();
  }

  // ---- conversations ----

  conversation(id) {
    return plain(this.sql.conversationById.get(id));
  }

  conversationFor(waId, name = null) {
    const now = this.now();
    this.sql.upsertContact.run({ wa_id: waId, name: name || null, now });
    this.sql.insertConversation.run({ wa_id: waId, now });
    return plain(this.sql.conversationByWaId.get(waId));
  }

  conversations({ filter = 'all', status = 'open', agent = '', q = '', limit = 100 } = {}) {
    const term = String(q).trim().replace(/[\\%_]/g, (char) => `\\${char}`);
    return this.sql.listConversations
      .all({ filter, status, agent, like: term ? `%${term}%` : '', limit })
      .map(plain);
  }

  counts(agent) {
    return plain(this.sql.counts.get({ agent }));
  }

  assign(id, agent) {
    this.sql.assign.run({ id, agent: agent || null, now: this.now() });
    return this.conversation(id);
  }

  setStatus(id, status) {
    this.sql.setStatus.run({ id, status, now: this.now() });
    return this.conversation(id);
  }

  markRead(id) {
    this.sql.markRead.run(id);
    return this.conversation(id);
  }

  lastInboundWamid(id) {
    return this.sql.lastInbound.get(id)?.wamid ?? null;
  }

  // ---- messages ----

  // Returns null when the WhatsApp message id was already stored (webhook retries).
  addMessage(conversationId, message) {
    const at = message.createdAt ?? this.now();
    const result = this.sql.insertMessage.run({
      conversation_id: conversationId,
      wamid: message.wamid ?? null,
      direction: message.direction,
      kind: message.kind,
      body: message.body ?? null,
      media_id: message.mediaId ?? null,
      media_mime: message.mediaMime ?? null,
      filename: message.filename ?? null,
      data: message.data ? JSON.stringify(message.data) : null,
      reply_to: message.replyTo ?? null,
      status: message.status ?? null,
      error: message.error ?? null,
      agent: message.agent ?? null,
      category: message.category ?? null,
      created_at: at,
    });
    if (result.changes === 0) return null;

    const inbound = message.direction === 'in';
    const isCall = message.kind === 'call';
    const missedCall = isCall && inbound && ['missed', 'failed'].includes(message.data?.outcome);
    this.sql.touchConversation.run({
      id: conversationId,
      at,
      kind: message.kind,
      preview: message.body ? String(message.body).slice(0, 160) : null,
      direction: message.direction,
      unread: (inbound && !isCall) || missedCall ? 1 : 0,
      inbound_at: inbound && !isCall ? at : null,
      reopen: inbound ? 1 : 0,
    });
    return toMessage(this.sql.messageById.get(result.lastInsertRowid));
  }

  messages(conversationId, { before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
    const rows = this.sql.thread.all({ id: conversationId, before, limit: limit + 1 });
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse().map(toMessage), hasMore };
  }

  // Delivery statuses only move forward; "failed" always wins. Meta's pricing,
  // when a status carries it, is stored whatever the status does.
  updateStatus(wamid, status, error = null, pricing = null) {
    const row = this.sql.messageByWamid.get(wamid);
    if (!row) return null;
    let changed = false;
    if (pricing && (pricing.billable !== null || pricing.category || pricing.type)) {
      this.sql.setPricing.run({
        id: row.id,
        billable: pricing.billable === null ? row.billable : pricing.billable ? 1 : 0,
        category: pricing.category ?? row.pricing_category,
        type: pricing.type ?? row.pricing_type,
      });
      changed = true;
    }
    const advances =
      status === 'failed'
        ? true
        : Object.hasOwn(STATUS_RANK, status) && row.status !== 'failed' && (STATUS_RANK[row.status] ?? -1) < STATUS_RANK[status];
    if (advances) {
      this.sql.updateStatus.run({ id: row.id, status, error: error ?? null });
      changed = true;
    }
    return changed ? toMessage(this.sql.messageById.get(row.id)) : null;
  }

  setReaction(wamid, emoji) {
    const row = this.sql.messageByWamid.get(wamid);
    if (!row) return null;
    this.sql.setReaction.run({ id: row.id, reaction: emoji || null });
    return toMessage(this.sql.messageById.get(row.id));
  }

  hasMessage(wamid) {
    return Boolean(this.sql.messageByWamid.get(wamid));
  }

  hasMedia(mediaId) {
    return Boolean(this.sql.hasMedia.get(mediaId));
  }

  // ---- privacy ----

  // RETENTION_DAYS: messages and call records older than the cutoff go away.
  // Their monthly counts stay in usage_archive.
  prune(cutoff) {
    this.db.exec('BEGIN');
    try {
      this.#archiveUsage(this.sql.usageBefore.all(cutoff));
      const removed = this.sql.pruneMessages.run(cutoff).changes;
      this.sql.prunePreviews.run(cutoff);
      this.db.exec('COMMIT');
      return removed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Erases a contact with all its messages and calls (data subject requests).
  deleteConversation(id) {
    const conversation = this.conversation(id);
    if (!conversation) return false;
    this.db.exec('BEGIN');
    try {
      this.#archiveUsage(this.sql.usageOfConversation.all(id));
      this.sql.deleteMessages.run(id);
      this.sql.deleteConversation.run(id);
      this.sql.deleteContact.run(conversation.waId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  // ---- message log ----

  #archiveUsage(rows) {
    for (const [month, metrics] of usageByMonth(rows)) {
      for (const [metric, value] of Object.entries(metrics)) this.sql.archiveUsage.run({ month, metric, value });
    }
  }

  // Month ("YYYY-MM") -> { metric: count } for every month from `sinceMonth` on:
  // live messages plus the archived counts of removed ones.
  usage(sinceMonth) {
    const months = usageByMonth(this.sql.usageSince.all(monthStart(sinceMonth)));
    for (const row of this.sql.archivedUsage.all(sinceMonth)) {
      if (!months.has(row.month)) months.set(row.month, {});
      const metrics = months.get(row.month);
      metrics[row.metric] = (metrics[row.metric] ?? 0) + row.value;
    }
    return months;
  }

  // One month of messages and calls, newest first, without the message text.
  messageLog({ month, filter = '', agent = '', before = Number.MAX_SAFE_INTEGER, limit = 50 }) {
    const rows = this.sql.messageLog.all({
      from: monthStart(month),
      to: monthEnd(month),
      before,
      filter,
      agent,
      limit: limit + 1,
    });
    return { messages: rows.slice(0, limit).map(logEntry), hasMore: rows.length > limit };
  }

  // ---- calls ----

  recentCalls(limit = 50) {
    return this.sql.recentCalls.all(limit).map((row) => {
      const message = toMessage(row);
      return {
        id: message.data?.callId ?? `m${message.id}`,
        conversationId: message.conversationId,
        direction: message.direction === 'in' ? 'inbound' : 'outbound',
        peer: row.wa_id,
        peerName: row.name,
        agent: message.agent,
        outcome: message.data?.outcome ?? null,
        duration: message.data?.duration ?? 0,
        createdAt: message.createdAt,
      };
    });
  }
}
