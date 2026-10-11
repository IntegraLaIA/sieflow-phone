import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword } from '../src/auth.js';
import { loadConfig, parseUsers } from '../src/config.js';
import { iceServersFor } from '../src/ice.js';

const hash = hashPassword('password-ana');

test('an empty environment loads: the setup wizard asks for the rest', () => {
  const config = loadConfig({}, []);
  assert.equal(config.demo, false);
  assert.equal(config.port, 8080);
  assert.equal(config.phoneNumberId, '');
  assert.equal(config.graphVersion, 'v24.0');
  assert.equal(config.dataDir, './data');
  assert.equal(config.envUsers.size, 0);
  assert.equal(config.envLocked.size, 0);
});

test('Meta settings from the environment are locked for the wizard', () => {
  const config = loadConfig({ WA_PHONE_NUMBER_ID: '123', WA_ACCESS_TOKEN: 'token', USERS: `ana:${hash}` }, []);
  assert.equal(config.phoneNumberId, '123');
  assert.equal(config.accessToken, 'token');
  assert.deepEqual([...config.envLocked].sort(), ['accessToken', 'phoneNumberId']);
  assert.deepEqual([...config.envUsers.keys()], ['ana']);
});

test('demo mode needs nothing and creates a demo login', () => {
  const config = loadConfig({}, ['--demo', '--port=9000']);
  assert.equal(config.demo, true);
  assert.equal(config.port, 9000);
  assert.equal(config.demoLogin.username, 'demo');
  assert.equal(config.phoneNumberId, 'demo-phone-number-id');
  assert.equal(config.dataDir, '', 'the demo keeps its data in memory');
  assert.equal(config.envLocked.size, 0, 'demo values stay editable');
});

test('a weak SETUP_CODE is refused, demo data always stays in memory', () => {
  assert.throws(() => loadConfig({ SETUP_CODE: '----' }, []), /SETUP_CODE/);
  assert.throws(() => loadConfig({ SETUP_CODE: 'ABC-123' }, []), /SETUP_CODE/);
  assert.equal(loadConfig({ SETUP_CODE: 'ABCD-1234' }, []).setupCode, 'ABCD-1234');
  assert.equal(loadConfig({ DEMO_MODE: 'true', DATA_DIR: '/data' }, []).dataDir, '');
  assert.equal(loadConfig({ RETENTION_DAYS: '90' }, []).retentionDays, 90);
});

test('USERS entries must carry a scrypt hash', () => {
  assert.throws(() => parseUsers('ana:plaintext'), /scrypt hash/);
  assert.throws(() => parseUsers('bad name:scrypt:a:b'), /name:scrypt/);
  assert.deepEqual([...parseUsers(`ana:${hash}\n# comment\nluis:${hash}`).keys()], ['ana', 'luis']);
});

test('ICE_SERVERS must be a JSON array', () => {
  assert.throws(() => loadConfig({ ICE_SERVERS: '{nope' }, []), /JSON array/);
  const config = loadConfig({ ICE_SERVERS: '[{"urls":"stun:stun.example.com:3478"}]' }, []);
  assert.deepEqual(config.iceServers, [{ urls: 'stun:stun.example.com:3478' }]);
});

test('TURN credentials are short-lived and per operator with TURN_SECRET', () => {
  const config = loadConfig({ TURN_URLS: 'turn:turn.example.com:3478', TURN_SECRET: 's3cret' }, []);
  const [turn] = iceServersFor(config, 'ana', 1_000_000);
  assert.deepEqual(turn.urls, ['turn:turn.example.com:3478']);
  assert.equal(turn.username, `${1000 + 3600}:ana`);
  assert.ok(turn.credential.length > 10);
});
