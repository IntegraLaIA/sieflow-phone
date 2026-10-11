// Process configuration from environment variables (see .env.example).
//
// The Meta settings can come from the environment or from the setup wizard,
// which stores them in the database. An environment variable always wins and
// shows up as read-only in the wizard. Nothing here is required: an empty
// instance starts and asks for its configuration in the browser.

import { readFileSync } from 'node:fs';
import { hashPassword } from './auth.js';

// Wizard-editable settings and the environment variable that overrides each.
export const EDITABLE = {
  appId: 'WA_APP_ID',
  appSecret: 'WA_APP_SECRET',
  accessToken: 'WA_ACCESS_TOKEN',
  wabaId: 'WA_WABA_ID',
  phoneNumberId: 'WA_PHONE_NUMBER_ID',
  verifyToken: 'WA_VERIFY_TOKEN',
  displayNumber: 'WA_DISPLAY_NUMBER',
  graphVersion: 'WA_GRAPH_VERSION',
  permissionRequestText: 'PERMISSION_REQUEST_TEXT',
  publicUrl: 'PUBLIC_URL',
};

export const SECRET_SETTINGS = new Set(['appSecret', 'accessToken']);

const DEFAULTS = {
  graphVersion: 'v24.0',
};

const DEMO_VALUES = {
  appId: 'demo-app-id',
  appSecret: 'demo-app-secret',
  accessToken: 'demo-access-token',
  wabaId: 'demo-waba-id',
  phoneNumberId: 'demo-phone-number-id',
  verifyToken: 'demo-verify-token',
  displayNumber: '+1 555 010 0000',
};

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

function argValue(argv, name) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

export const USERNAME_PATTERN = /^[\w.@-]{1,64}$/;

// USERS="ana:scrypt:...,luis:scrypt:..." or one "name:hash" per line in USERS_FILE.
// Operators defined this way are administrators and cannot be edited in the UI.
export function parseUsers(text) {
  const users = new Map();
  for (const raw of String(text ?? '').split(/[,\n]/)) {
    const entry = raw.trim();
    if (!entry || entry.startsWith('#')) continue;
    const sep = entry.indexOf(':');
    const name = sep > 0 ? entry.slice(0, sep).trim() : '';
    if (!USERNAME_PATTERN.test(name)) {
      throw new Error('Each USERS entry must look like name:scrypt:salt:hash (letters, digits, . _ @ - in the name)');
    }
    const hash = entry.slice(sep + 1).trim();
    if (!hash.startsWith('scrypt:')) {
      throw new Error(`The password for "${name}" must be a scrypt hash. Generate one with: node src/cli.js hash-password`);
    }
    users.set(name, hash);
  }
  return users;
}

function parseIceServers(text) {
  if (!text || !text.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('ICE_SERVERS must be a JSON array, e.g. [{"urls":"stun:stun.example.com:3478"}]');
  }
  if (!Array.isArray(parsed)) throw new Error('ICE_SERVERS must be a JSON array');
  return parsed;
}

function positiveNumber(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return number;
}

export function loadConfig(env = process.env, argv = process.argv.slice(2)) {
  const demo = truthy(env.DEMO_MODE) || argv.includes('--demo');

  const envUsers = parseUsers(env.USERS_FILE ? readFileSync(env.USERS_FILE, 'utf8') : env.USERS);
  let demoLogin = null;
  if (demo && envUsers.size === 0) {
    demoLogin = { username: 'demo', password: 'demo1234' };
    envUsers.set(demoLogin.username, hashPassword(demoLogin.password));
  }

  const config = {
    demo,
    demoLogin,
    port: positiveNumber('PORT', argValue(argv, 'port') ?? env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    // In demo mode the app points this at its own mock once it knows its port.
    graphBaseUrl: (env.WA_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, ''),
    envLocked: new Set(),
    envUsers,
    sessionSecret: env.SESSION_SECRET || '',
    sessionTtlMs: positiveNumber('SESSION_TTL_HOURS', env.SESSION_TTL_HOURS, 12) * 3_600_000,
    trustProxy: truthy(env.TRUST_PROXY),
    iceServers: parseIceServers(env.ICE_SERVERS),
    turn: {
      urls: list(env.TURN_URLS),
      secret: env.TURN_SECRET || '',
      username: env.TURN_USERNAME || '',
      password: env.TURN_PASSWORD || '',
      ttlSeconds: positiveNumber('TURN_TTL_SECONDS', env.TURN_TTL_SECONDS, 3600),
    },
    forwardUrl: env.WEBHOOK_FORWARD_URL || '',
    setupCode: env.SETUP_CODE || '',
    retentionDays: env.RETENTION_DAYS ? positiveNumber('RETENTION_DAYS', env.RETENTION_DAYS, 0) : 0,
    // The demo always keeps its data in memory, so it can never touch a real database.
    dataDir: demo ? '' : (env.DATA_DIR ?? './data'),
    logLevel: env.LOG_LEVEL || 'info',
  };

  if (config.setupCode && config.setupCode.toUpperCase().replace(/[^A-Z0-9]/g, '').length < 8) {
    throw new Error('SETUP_CODE needs at least 8 letters or digits');
  }

  for (const [key, variable] of Object.entries(EDITABLE)) {
    const value = env[variable]?.trim();
    if (value) {
      config[key] = value;
      config.envLocked.add(key);
    } else {
      config[key] = (demo ? DEMO_VALUES[key] : undefined) ?? DEFAULTS[key] ?? '';
    }
  }
  return config;
}
