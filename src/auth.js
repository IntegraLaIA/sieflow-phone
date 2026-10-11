// Operator authentication: scrypt password hashes and HMAC-signed session cookies.

import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 32;

// Format: scrypt:<salt base64url>:<hash base64url>. No "$" so it survives
// docker compose variable interpolation inside .env files.
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltText, hashText] = String(stored ?? '').split(':');
  if (scheme !== 'scrypt' || !saltText || !hashText || typeof password !== 'string') return false;
  const expected = Buffer.from(hashText, 'base64url');
  if (expected.length === 0) return false;
  const actual = await scryptAsync(password, Buffer.from(saltText, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

// Used when the username does not exist, so a failed login costs the same
// time either way and does not reveal which usernames are valid.
const DUMMY_HASH = `scrypt:${randomBytes(16).toString('base64url')}:${randomBytes(KEY_LENGTH).toString('base64url')}`;

// `lookup(username)` returns the stored hash or nothing.
export async function checkCredentials(lookup, username, password) {
  const stored = lookup(username);
  const ok = await verifyPassword(password, stored ?? DUMMY_HASH);
  return Boolean(stored) && ok;
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest();
}

export function signSession(user, secret, ttlMs, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: now + ttlMs })).toString('base64url');
  return `${payload}.${sign(payload, secret).toString('base64url')}`;
}

export function verifySession(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = sign(payload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data.u !== 'string' || typeof data.exp !== 'number' || data.exp < now) return null;
  return data.u;
}

// The username a token claims, unverified: the signing key depends on the user.
// Verify the token with verifySession before trusting it.
export function peekSessionUser(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  try {
    const data = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8'));
    return typeof data?.u === 'string' ? data.u : null;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

// Fixed-window limiter for failed logins, keyed by ip + username.
export class LoginLimiter {
  #attempts = new Map();

  constructor({ max = 10, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  blocked(key) {
    const entry = this.#attempts.get(key);
    if (!entry) return false;
    if (entry.resetAt <= this.now()) {
      this.#attempts.delete(key);
      return false;
    }
    return entry.count >= this.max;
  }

  fail(key) {
    const now = this.now();
    const entry = this.#attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      this.#attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count += 1;
    }
    if (this.#attempts.size > 10_000) this.#prune(now);
  }

  reset(key) {
    this.#attempts.delete(key);
  }

  #prune(now) {
    for (const [key, entry] of this.#attempts) if (entry.resetAt <= now) this.#attempts.delete(key);
  }
}
