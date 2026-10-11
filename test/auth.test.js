import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkCredentials,
  hashPassword,
  LoginLimiter,
  parseCookies,
  signSession,
  verifyPassword,
  verifySession,
} from '../src/auth.js';

test('password hashes verify the right password only', async () => {
  const hash = hashPassword('correct horse');
  assert.match(hash, /^scrypt:[\w-]+:[\w-]+$/);
  assert.doesNotMatch(hash, /\$/, 'hashes must survive docker compose interpolation');
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong horse', hash), false);
  assert.equal(await verifyPassword('correct horse', 'not-a-hash'), false);
});

test('short passwords are refused', () => {
  assert.throws(() => hashPassword('short'), /at least 8/);
});

test('checkCredentials rejects unknown users and wrong passwords', async () => {
  const users = new Map([['ana', hashPassword('password-ana')]]);
  const lookup = (name) => users.get(name);
  assert.equal(await checkCredentials(lookup, 'ana', 'password-ana'), true);
  assert.equal(await checkCredentials(lookup, 'ana', 'password-luis'), false);
  assert.equal(await checkCredentials(lookup, 'luis', 'password-ana'), false);
});

test('session tokens expire and cannot be forged', () => {
  const token = signSession('ana', 'secret', 1000, 0);
  assert.equal(verifySession(token, 'secret', 500), 'ana');
  assert.equal(verifySession(token, 'secret', 1001), null, 'expired');
  assert.equal(verifySession(token, 'other-secret', 500), null, 'wrong secret');

  const [, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'admin', exp: 10_000 })).toString('base64url');
  assert.equal(verifySession(`${forged}.${signature}`, 'secret', 500), null, 'tampered payload');
  assert.equal(verifySession('garbage', 'secret'), null);
  assert.equal(verifySession(undefined, 'secret'), null);
});

test('parseCookies reads multiple cookies', () => {
  assert.deepEqual(parseCookies('a=1; sieflow_phone_session=abc.def; empty='), { a: '1', sieflow_phone_session: 'abc.def', empty: '' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('LoginLimiter blocks after repeated failures until the window passes', () => {
  let now = 0;
  const limiter = new LoginLimiter({ max: 3, windowMs: 1000, now: () => now });
  for (let i = 0; i < 3; i += 1) limiter.fail('ip|ana');
  assert.equal(limiter.blocked('ip|ana'), true);
  assert.equal(limiter.blocked('ip|luis'), false);
  now = 1001;
  assert.equal(limiter.blocked('ip|ana'), false);
  limiter.fail('ip|ana');
  limiter.reset('ip|ana');
  assert.equal(limiter.blocked('ip|ana'), false);
});
