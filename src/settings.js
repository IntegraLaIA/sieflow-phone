// Runtime settings and operators, backed by the database. Environment
// variables override stored values and cannot be changed from the UI.

import { randomBytes } from 'node:crypto';
import { hashPassword } from './auth.js';
import { CallError } from './calls.js';
import { EDITABLE, SECRET_SETTINGS, USERNAME_PATTERN } from './config.js';

const ROLES = new Set(['admin', 'agent']);
const TRACK_EVERY_MS = 30_000;

function mask(value) {
  const text = String(value ?? '');
  if (!text) return '';
  return text.length <= 8 ? '••••' : `••••${text.slice(-4)}`;
}

export class Settings {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    const stored = db.settings();
    for (const key of Object.keys(EDITABLE)) {
      if (!config.envLocked.has(key) && stored[key] !== undefined) config[key] = stored[key];
    }
    // Generated once and kept, so operators stay signed in across restarts.
    if (!config.sessionSecret) {
      if (!stored.sessionSecret) db.setSettings({ sessionSecret: randomBytes(32).toString('hex') });
      config.sessionSecret = db.settings().sessionSecret;
    }
    this.webhook = {
      verifiedAt: stored['webhook.verifiedAt'] ?? null,
      lastEventAt: stored['webhook.lastEventAt'] ?? null,
    };
  }

  // What the wizard shows: secrets masked, env-locked fields flagged.
  view() {
    const fields = {};
    for (const key of Object.keys(EDITABLE)) {
      const value = this.config[key] ?? '';
      fields[key] = {
        value: SECRET_SETTINGS.has(key) ? mask(value) : value,
        set: Boolean(value),
        locked: this.config.envLocked.has(key),
        variable: EDITABLE[key],
      };
    }
    return fields;
  }

  update(patch) {
    const changes = {};
    for (const [key, raw] of Object.entries(patch)) {
      if (!Object.hasOwn(EDITABLE, key)) throw new CallError(400, 'unknown_setting', `Unknown setting: ${key}`);
      if (this.config.envLocked.has(key)) {
        throw new CallError(409, 'locked', `${EDITABLE[key]} is set in the environment and cannot be changed here`);
      }
      const value = typeof raw === 'string' ? raw.trim() : raw;
      changes[key] = value;
    }
    this.db.setSettings(changes);
    for (const [key, value] of Object.entries(changes)) this.config[key] = value ?? '';
  }

  // Everything SieFlow Phone needs before operators can take calls.
  missing() {
    return ['phoneNumberId', 'accessToken', 'appSecret', 'verifyToken'].filter((key) => !this.config[key]);
  }

  trackWebhook(kind) {
    const key = kind === 'verified' ? 'verifiedAt' : 'lastEventAt';
    const now = Date.now();
    const previous = this.webhook[key];
    this.webhook[key] = now;
    if (!previous || now - previous > TRACK_EVERY_MS) this.db.setSettings({ [`webhook.${key}`]: now });
  }
}

export class Users {
  constructor(config, db) {
    this.config = config;
    this.db = db;
  }

  get(username) {
    const fromEnv = this.config.envUsers.get(username);
    if (fromEnv) return { username, hash: fromEnv, role: 'admin', source: 'env' };
    const row = this.db.user(username);
    return row ? { username, hash: row.password_hash, role: row.role, source: 'db' } : null;
  }

  list() {
    const fromEnv = [...this.config.envUsers.keys()].map((username) => ({ username, role: 'admin', source: 'env' }));
    const fromDb = this.db
      .users()
      .filter((row) => !this.config.envUsers.has(row.username))
      .map((row) => ({ username: row.username, role: row.role, source: 'db', createdAt: row.created_at }));
    return [...fromEnv, ...fromDb];
  }

  count() {
    return this.list().length;
  }

  admins() {
    return this.list().filter((user) => user.role === 'admin');
  }

  create({ username, password, role = 'agent' }) {
    const name = String(username ?? '').trim();
    if (!USERNAME_PATTERN.test(name)) {
      throw new CallError(400, 'bad_username', 'Usernames use letters, digits and . _ @ - (up to 64)');
    }
    if (!ROLES.has(role)) throw new CallError(400, 'bad_role', 'Role must be admin or agent');
    if (this.get(name)) throw new CallError(409, 'user_exists', 'That username is taken');
    let hash;
    try {
      hash = hashPassword(String(password ?? ''));
    } catch (error) {
      throw new CallError(400, 'weak_password', error.message);
    }
    this.db.createUser(name, hash, role);
    return { username: name, role, source: 'db' };
  }

  #editable(username) {
    const user = this.get(username);
    if (!user) throw new CallError(404, 'not_found', 'User not found');
    if (user.source === 'env') throw new CallError(409, 'locked', 'This user is defined in USERS and cannot be edited here');
    return user;
  }

  setPassword(username, password) {
    this.#editable(username);
    try {
      this.db.setPassword(username, hashPassword(String(password ?? '')));
    } catch (error) {
      throw new CallError(400, 'weak_password', error.message);
    }
  }

  update(username, { role, password }) {
    const user = this.#editable(username);
    if (role !== undefined) {
      if (!ROLES.has(role)) throw new CallError(400, 'bad_role', 'Role must be admin or agent');
      if (user.role === 'admin' && role !== 'admin' && this.admins().length <= 1) {
        throw new CallError(409, 'last_admin', 'There must be at least one administrator');
      }
      this.db.setRole(username, role);
    }
    if (password) this.setPassword(username, password);
  }

  remove(username) {
    const user = this.#editable(username);
    if (user.role === 'admin' && this.admins().length <= 1) {
      throw new CallError(409, 'last_admin', 'There must be at least one administrator');
    }
    this.db.deleteUser(username);
  }
}
