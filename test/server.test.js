// End to end through HTTP: the demo's mock WhatsApp API posts signed webhooks
// to the real /webhook, so these tests run the production code path.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp, VERSION } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

function client(base) {
  const cookies = {};
  async function request(path, { method = 'GET', body, user, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (user) init.headers.cookie = cookies[user];
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    const cookie = res.headers.get('set-cookie');
    return { status: res.status, data, headers: res.headers, cookie: cookie?.split(';')[0] };
  }
  async function login(user, password) {
    const res = await request('/api/login', { method: 'POST', body: { username: user, password } });
    assert.equal(res.status, 200, `login ${user}`);
    cookies[user] = res.cookie;
    return res.data;
  }
  return { request, login, cookies };
}

// Minimal SSE client over fetch.
async function openEvents(base, cookie) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: controller.signal });
  assert.equal(res.status, 200);
  const queue = [];
  let wake = null;
  let closed = false;
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (event && data) {
            queue.push({ event, data: JSON.parse(data) });
            wake?.();
          }
        }
      }
    } catch {
      // aborted
    }
    closed = true;
  })();
  return {
    isClosed: () => closed,
    async next(name, predicate = () => true, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = queue.findIndex((item) => item.event === name && predicate(item.data));
        if (index >= 0) return queue.splice(index, 1)[0].data;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`);
        await new Promise((resolve) => {
          wake = resolve;
          setTimeout(resolve, 50);
        });
      }
    },
    close: () => controller.abort(),
  };
}

describe('demo instance', () => {
  let app;
  let base;
  let api;
  const events = (user) => openEvents(base, api.cookies[user]);
  const sim = (action, body) => api.request(`/demo/sim/${action}`, { method: 'POST', body });

  before(async () => {
    const config = loadConfig(
      { DEMO_MODE: 'true', USERS: `ana:${hashPassword('password-ana')},luis:${hashPassword('password-luis')}` },
      [],
    );
    app = await createApp(config);
    const port = await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${port}`;
    api = client(base);
    await api.login('ana', 'password-ana');
    await api.login('luis', 'password-luis');
  });

  after(async () => {
    await app.close();
  });

  test('health, UI and security headers', async () => {
    // The version comes from package.json, so a release bump does not break this test.
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
    assert.deepEqual((await api.request('/healthz')).data, { ok: true, version: VERSION });
    const page = await api.request('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await api.request('/setup')).status, 200);
    assert.equal((await api.request('/manifest.webmanifest')).status, 200);
  });

  test('webhook verification handshake', async () => {
    const ok = await api.request('/webhook?hub.mode=subscribe&hub.verify_token=demo-verify-token&hub.challenge=4242');
    assert.equal(ok.status, 200);
    assert.equal(ok.data, 4242);
    const bad = await api.request('/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=4242');
    assert.equal(bad.status, 403);
  });

  test('webhooks without a valid signature are rejected', async () => {
    const res = await api.request('/webhook', {
      method: 'POST',
      body: { object: 'whatsapp_business_account', entry: [] },
      headers: { 'x-hub-signature-256': 'sha256=00' },
    });
    assert.equal(res.status, 401);
  });

  test('the API needs a session and refuses wrong passwords and other origins', async () => {
    assert.equal((await api.request('/api/me')).status, 401);
    const wrong = await api.request('/api/login', { method: 'POST', body: { username: 'ana', password: 'nope-nope' } });
    assert.equal(wrong.status, 401);
    const crossSite = await api.request('/api/calls', {
      method: 'POST',
      user: 'ana',
      body: { to: '573009998877', sdp: 'v=0' },
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(crossSite.status, 403);
    const me = await api.request('/api/me', { user: 'ana' });
    assert.equal(me.data.user, 'ana');
    assert.equal(me.data.role, 'admin');
    assert.equal(me.data.ready, true);
    assert.deepEqual(me.data.agents, ['ana', 'luis']);
  });

  test('incoming call: ring, race between operators, accept, hang up, logged in the conversation', async () => {
    const ana = await events('ana');
    const luis = await events('luis');
    await ana.next('snapshot');

    const { data } = await sim('call', { from: '573001112233', name: 'Pablo', sdp: 'v=0 offer-from-whatsapp' });
    const ringing = await ana.next('call.ringing', (call) => call.id === data.callId);
    assert.equal(ringing.peer, '573001112233');
    assert.equal(ringing.peerName, 'Pablo');
    assert.equal(ringing.offerSdp, 'v=0 offer-from-whatsapp');
    await luis.next('call.ringing', (call) => call.id === data.callId);

    const url = `/api/calls/${encodeURIComponent(data.callId)}`;
    assert.equal((await api.request(`${url}/pre-accept`, { method: 'POST', user: 'ana', body: { sdp: 'v=0 answer-ana' } })).status, 200);
    const second = await api.request(`${url}/pre-accept`, { method: 'POST', user: 'luis', body: { sdp: 'v=0 answer-luis' } });
    assert.equal(second.status, 409);
    assert.equal(second.data.error.code, 'taken');

    // The mock WhatsApp API rejects an accept whose SDP differs from pre_accept.
    assert.equal((await api.request(`${url}/accept`, { method: 'POST', user: 'ana', body: {} })).status, 200);
    await ana.next('call.updated', (call) => call.id === data.callId && call.state === 'active');

    assert.equal((await api.request(`${url}/hangup`, { method: 'POST', user: 'luis', body: {} })).status, 403);
    assert.equal((await api.request(`${url}/hangup`, { method: 'POST', user: 'ana', body: {} })).status, 200);
    const ended = await luis.next('call.ended', (call) => call.id === data.callId);
    assert.equal(ended.outcome, 'completed');
    assert.equal(ended.agent, 'ana');
    assert.ok(ended.conversationId);

    const thread = await api.request(`/api/conversations/${ended.conversationId}`, { user: 'luis' });
    const call = thread.data.messages.find((message) => message.kind === 'call');
    assert.equal(call.data.outcome, 'completed');
    assert.equal(thread.data.conversation.assignee, 'ana', 'answering takes the conversation');
    const history = await api.request('/api/history', { user: 'luis' });
    assert.equal(history.data.calls[0].id, data.callId);
    ana.close();
    luis.close();
  });

  test('incoming call declined by an operator', async () => {
    const ana = await events('ana');
    const { data } = await sim('call', { from: '573001112244', sdp: 'v=0 offer' });
    await ana.next('call.ringing', (call) => call.id === data.callId);
    const res = await api.request(`/api/calls/${encodeURIComponent(data.callId)}/reject`, { method: 'POST', user: 'ana', body: {} });
    assert.equal(res.status, 200);
    const ended = await ana.next('call.ended', (call) => call.id === data.callId);
    assert.equal(ended.outcome, 'declined');
    ana.close();
  });

  test('outgoing call: SDP answer, ringing, answered, ended by the user', async () => {
    const ana = await events('ana');
    const dial = await api.request('/api/calls', { method: 'POST', user: 'ana', body: { to: '+57 300 999 8877', sdp: 'v=0 offer-ana' } });
    assert.equal(dial.status, 200);
    const { callId } = dial.data;

    await sim('ringing', { callId, sdp: 'v=0 answer-from-whatsapp' });
    const answer = await ana.next('call.answer', (event) => event.callId === callId);
    assert.equal(answer.sdp, 'v=0 answer-from-whatsapp');
    await ana.next('call.updated', (call) => call.id === callId && call.state === 'ringing');

    await sim('accept', { callId });
    await ana.next('call.updated', (call) => call.id === callId && call.state === 'active');

    await sim('hangup', { callId });
    const ended = await ana.next('call.ended', (call) => call.id === callId);
    assert.equal(ended.outcome, 'completed');
    assert.equal(ended.peer, '573009998877');
    ana.close();
  });

  test('chat: an incoming message opens a conversation; the first reply takes it', async () => {
    const luis = await events('luis');
    await sim('message', { from: '573005550001', name: 'Marta', text: 'Hola, ¿tienen envíos?' });
    const created = await luis.next('message.created', (event) => event.message.body === 'Hola, ¿tienen envíos?');
    const conversation = await luis.next('conversation.updated', (c) => c.id === created.conversationId);
    assert.equal(conversation.name, 'Marta');
    assert.equal(conversation.unread, 1);
    assert.equal(conversation.windowOpen, true);
    assert.equal(conversation.assignee, null);

    const unassigned = await api.request('/api/conversations?filter=unassigned', { user: 'luis' });
    assert.ok(unassigned.data.conversations.some((c) => c.id === conversation.id));

    const reply = await api.request(`/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      user: 'luis',
      body: { text: 'Sí, a todo el país.' },
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.data.message.agent, 'luis');
    const delivered = await luis.next(
      'message.updated',
      (event) => event.message.id === reply.data.message.id && event.message.status === 'delivered',
    );
    assert.equal(delivered.conversationId, conversation.id);

    const mine = await api.request('/api/conversations?filter=mine', { user: 'luis' });
    assert.ok(mine.data.conversations.some((c) => c.id === conversation.id && c.assignee === 'luis'));

    await api.request(`/api/conversations/${conversation.id}/read`, { method: 'POST', user: 'luis', body: {} });
    assert.equal((await api.request(`/api/conversations/${conversation.id}`, { user: 'luis' })).data.conversation.unread, 0);

    const resolved = await api.request(`/api/conversations/${conversation.id}/status`, {
      method: 'POST',
      user: 'luis',
      body: { status: 'resolved' },
    });
    assert.equal(resolved.data.conversation.status, 'resolved');
    const reassigned = await api.request(`/api/conversations/${conversation.id}/assign`, {
      method: 'POST',
      user: 'luis',
      body: { agent: 'ana' },
    });
    assert.equal(reassigned.data.conversation.assignee, 'ana');
    const unknown = await api.request(`/api/conversations/${conversation.id}/assign`, {
      method: 'POST',
      user: 'luis',
      body: { agent: 'nobody' },
    });
    assert.equal(unknown.status, 400);
    luis.close();
  });

  test('chat: outside the 24-hour window only templates go out', async () => {
    const opened = await api.request('/api/conversations', { method: 'POST', user: 'ana', body: { to: '573005550002' } });
    const id = opened.data.conversation.id;
    assert.equal(opened.data.conversation.windowOpen, false);

    const text = await api.request(`/api/conversations/${id}/messages`, { method: 'POST', user: 'ana', body: { text: 'hola' } });
    assert.equal(text.status, 409);
    assert.equal(text.data.error.code, 'window_closed');

    const templates = await api.request('/api/templates', { user: 'ana' });
    assert.equal(templates.data.enabled, true);
    const order = templates.data.templates.find((t) => t.name === 'seguimiento_pedido');
    assert.deepEqual(order.bodyParams, ['1', '2']);
    assert.equal(templates.data.templates.find((t) => t.name === 'promo_octubre').supported, false);

    const missing = await api.request(`/api/conversations/${id}/template`, {
      method: 'POST',
      user: 'ana',
      body: { name: 'seguimiento_pedido', language: 'es', params: { body: ['Ana'] } },
    });
    assert.equal(missing.data.error.code, 'bad_params');

    const sent = await api.request(`/api/conversations/${id}/template`, {
      method: 'POST',
      user: 'ana',
      body: { name: 'seguimiento_pedido', language: 'es', params: { body: ['Ana', '4512'] } },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.message.kind, 'template');
    assert.equal(sent.data.message.body, 'Hola Ana, tu pedido 4512 ya va en camino.');
  });

  test('call permission: blocked call, request from the chat, reply, then the call goes through', async () => {
    const ana = await events('ana');
    const number = '573001110000';
    const dial = await api.request('/api/calls', { method: 'POST', user: 'ana', body: { to: number, sdp: 'v=0 offer' } });
    assert.equal(dial.status, 409);
    assert.equal(dial.data.error.code, 'no_permission');

    const { data } = await api.request('/api/conversations', { method: 'POST', user: 'ana', body: { to: number } });
    const id = data.conversation.id;
    const permission = await api.request(`/api/conversations/${id}/permission`, { user: 'ana' });
    assert.equal(permission.data.canCall, false);
    assert.equal(permission.data.canRequest, true);

    const closed = await api.request(`/api/conversations/${id}/permission-request`, { method: 'POST', user: 'ana', body: {} });
    assert.equal(closed.data.error.code, 'window_closed');

    await sim('message', { from: number, name: 'Laura', text: '¿Me pueden llamar?' });
    await ana.next('conversation.updated', (c) => c.id === id && c.windowOpen);

    const request = await api.request(`/api/conversations/${id}/permission-request`, {
      method: 'POST',
      user: 'ana',
      body: { text: '¿Te podemos llamar?' },
    });
    assert.equal(request.status, 200);
    assert.equal(request.data.message.kind, 'call_permission_request');

    // Nobody at the simulator: the mock accepts after a moment.
    const reply = await ana.next('permission.reply', (event) => event.peer === number);
    assert.equal(reply.response, 'accept');
    const stored = await ana.next('message.created', (event) => event.message.kind === 'call_permission_reply');
    assert.equal(stored.conversationId, id);
    assert.equal(stored.message.data.response, 'accept');

    const allowed = await api.request(`/api/conversations/${id}/permission`, { user: 'ana' });
    assert.equal(allowed.data.status, 'temporary');
    const call = await api.request('/api/calls', { method: 'POST', user: 'ana', body: { to: number, sdp: 'v=0 offer' } });
    assert.equal(call.status, 200);
    await api.request(`/api/calls/${encodeURIComponent(call.data.callId)}/hangup`, { method: 'POST', user: 'ana', body: {} });
    ana.close();
  });

  test('only administrators delete a conversation, with all its messages', async () => {
    await api.request('/api/users', {
      method: 'POST',
      user: 'ana',
      body: { username: 'beto', password: 'password-beto', role: 'agent' },
    });
    await api.login('beto', 'password-beto');
    await sim('message', { from: '573005550099', name: 'Borrar', text: 'please forget me' });
    let id;
    for (let i = 0; i < 20 && !id; i += 1) {
      const list = await api.request('/api/conversations?filter=all', { user: 'ana' });
      id = list.data.conversations.find((c) => c.name === 'Borrar')?.id;
      if (!id) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(id);
    assert.equal((await api.request(`/api/conversations/${id}`, { method: 'DELETE', user: 'beto' })).status, 403);
    assert.equal((await api.request(`/api/conversations/${id}`, { method: 'DELETE', user: 'ana' })).status, 200);
    assert.equal((await api.request(`/api/conversations/${id}`, { user: 'ana' })).status, 404);
  });

  test('message log: the service counter for everyone; month, detail and CSV for administrators', async () => {
    const luis = await events('luis');
    const number = '573005550123';
    await sim('message', { from: number, name: '=Pepa', text: 'Quiero el registro' });
    const created = await luis.next('message.created', (event) => event.message.body === 'Quiero el registro');
    const before = (await api.request('/api/usage/current', { user: 'beto' })).data;
    assert.equal(before.service.free, 1000);

    const reply = await api.request(`/api/conversations/${created.conversationId}/messages`, {
      method: 'POST',
      user: 'luis',
      body: { text: 'Con gusto' },
    });
    assert.equal(reply.data.message.category, 'service');
    const delivered = await luis.next(
      'message.updated',
      (event) => event.message.id === reply.data.message.id && event.message.status === 'delivered',
    );
    assert.equal(delivered.message.billable, false);
    assert.equal(delivered.message.pricingCategory, 'service');
    assert.equal(delivered.message.pricingType, 'free_customer_service');
    const after = (await api.request('/api/usage/current', { user: 'beto' })).data;
    assert.equal(after.service.delivered, before.service.delivered + 1);

    assert.equal((await api.request('/api/usage', { user: 'beto' })).status, 403);
    assert.equal((await api.request('/api/usage/messages', { user: 'beto' })).status, 403);
    assert.equal((await api.request('/api/usage/export', { user: 'beto' })).status, 403);

    const summary = await api.request('/api/usage?months=2', { user: 'ana' });
    assert.equal(summary.data.freeServiceMessages, 1000);
    assert.equal(summary.data.months.length, 2);
    const month = summary.data.months[0];
    assert.equal(month.month, new Date().toISOString().slice(0, 7));
    assert.ok(month.received >= 1);
    assert.ok(month.delivered.service >= 1);
    assert.ok(month.agents.some((agent) => agent.agent === 'luis' && agent.messages >= 1));

    const log = await api.request(`/api/usage/messages?month=${month.month}&filter=sent&agent=luis`, { user: 'ana' });
    const entry = log.data.messages.find((item) => item.id === reply.data.message.id);
    assert.equal(entry.waId, number);
    assert.equal(entry.status, 'delivered');
    assert.equal(entry.body, undefined);
    assert.equal((await api.request('/api/usage/messages?month=2026-13', { user: 'ana' })).status, 400);

    const csv = await api.request(`/api/usage/export?month=${month.month}&lang=es`, { user: 'ana' });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /filename="sieflow-phone-\d{4}-\d{2}\.csv"/);
    const lines = csv.data.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(
      lines[0],
      'fecha_utc,sentido,numero,nombre,tipo,categoria,plantilla,estado,facturable_meta,categoria_meta,tipo_meta,operador,segundos_llamada',
    );
    assert.ok(lines.some((line) => line.includes(`,enviado,${number},'=Pepa,text,service,,delivered,no,service,`)));
    assert.ok(!csv.data.includes('Con gusto') && !csv.data.includes('Quiero el registro'), 'no message text in the export');
    luis.close();
  });

  test('non-object JSON bodies are a 400, not a crash', async () => {
    for (const body of ['null', '42', '"text"', '[1]']) {
      const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(res.status, 400, body);
    }
  });

  test('bad input is refused before reaching WhatsApp', async () => {
    const badNumber = await api.request('/api/calls', { method: 'POST', user: 'ana', body: { to: '12', sdp: 'v=0' } });
    assert.equal(badNumber.data.error.code, 'bad_number');
    const badSdp = await api.request('/api/calls', { method: 'POST', user: 'ana', body: { to: '573009998877', sdp: 'hello' } });
    assert.equal(badSdp.data.error.code, 'bad_sdp');
    const notJson = await api.request('/api/calls', { method: 'POST', user: 'ana', headers: { 'content-type': 'text/plain' } });
    assert.equal(notJson.status, 415);
    assert.equal((await api.request('/api/media/unknown-id', { user: 'ana' })).status, 404);
  });

  test('a fresh instance is set up through the wizard API', async () => {
    const fresh = await createApp(
      loadConfig({ SETUP_CODE: 'ABCD-EFGH', DATA_DIR: '', WA_GRAPH_BASE_URL: app.config.graphBaseUrl }, []),
    );
    const port = await fresh.listen(0, '127.0.0.1');
    const f = client(`http://127.0.0.1:${port}`);
    try {
      const info = await f.request('/api/info');
      assert.deepEqual([info.data.ready, info.data.needsAccount], [false, true]);

      const wrongCode = await f.request('/api/setup/account', {
        method: 'POST',
        body: { code: 'WRONG', username: 'admin', password: 'password-admin' },
      });
      assert.equal(wrongCode.data.error.code, 'bad_code');

      const created = await f.request('/api/setup/account', {
        method: 'POST',
        body: { code: 'abcd efgh', username: 'admin', password: 'password-admin' },
      });
      assert.equal(created.status, 200);
      assert.equal(created.data.role, 'admin');
      assert.equal(created.data.ready, false);
      f.cookies.admin = created.cookie;

      const again = await f.request('/api/setup/account', {
        method: 'POST',
        body: { code: 'ABCD-EFGH', username: 'other', password: 'password-other' },
      });
      assert.equal(again.status, 409, 'the instance can only be claimed once');

      assert.equal((await f.request('/api/conversations', { user: 'admin' })).status, 503);

      const values = { appId: '1234567890', appSecret: 'test-secret', accessToken: 'EAA-test-token' };
      const report = await f.request('/api/setup/meta/verify', { method: 'POST', user: 'admin', body: values });
      assert.equal(report.data.token.valid, true);
      assert.deepEqual(report.data.token.missingScopes, []);
      const phone = report.data.wabas[0].phones[0];
      assert.equal(phone.platform, 'CLOUD_API');

      const rejected = await f.request('/api/setup/meta/verify', {
        method: 'POST',
        user: 'admin',
        body: { ...values, appSecret: 'bad-secret' },
      });
      assert.equal(rejected.data.token.appSecretRejected, true);

      const saved = await f.request('/api/setup/meta', {
        method: 'POST',
        user: 'admin',
        body: { ...values, wabaId: report.data.wabas[0].id, phoneNumberId: phone.id },
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.data.ready, true);
      assert.equal(saved.data.fields.accessToken.value, '••••oken', 'secrets never come back');
      assert.ok(saved.data.fields.verifyToken.value, 'a verify token is generated');

      const webhook = await f.request('/api/setup/webhook', {
        method: 'POST',
        user: 'admin',
        body: { callbackUrl: 'http://127.0.0.1/webhook', auto: true },
      });
      assert.deepEqual(
        webhook.data.results.map((r) => [r.step, r.ok, r.code ?? null]),
        [
          ['app', false, 'https_required'],
          ['waba', true, null],
        ],
      );

      const calling = await f.request('/api/setup/calling', { user: 'admin' });
      assert.ok(calling.data.checks.every((check) => check.state === 'ok'));

      const agent = await f.request('/api/users', {
        method: 'POST',
        user: 'admin',
        body: { username: 'luisa', password: 'password-luisa', role: 'agent' },
      });
      assert.deepEqual(agent.data.users.map((u) => [u.username, u.role]), [['admin', 'admin'], ['luisa', 'agent']]);
      const demote = await f.request('/api/users/admin', { method: 'POST', user: 'admin', body: { role: 'agent' } });
      assert.equal(demote.data.error.code, 'last_admin');

      await f.login('luisa', 'password-luisa');
      assert.equal((await f.request('/api/setup/calling', { user: 'luisa' })).status, 403, 'operators cannot change setup');
      assert.equal((await f.request('/api/conversations', { user: 'luisa' })).status, 200);

      // A new password signs the old sessions out.
      await f.request('/api/users/luisa', { method: 'POST', user: 'admin', body: { password: 'another-password' } });
      assert.equal((await f.request('/api/conversations', { user: 'luisa' })).status, 401);
      await f.login('luisa', 'another-password');
      assert.equal((await f.request('/api/me', { user: 'luisa' })).status, 200);

      // Removing a user does too, and ends the live event stream right away.
      const luisaEvents = await openEvents(`http://127.0.0.1:${port}`, f.cookies.luisa);
      await luisaEvents.next('snapshot');
      await f.request('/api/users/luisa', { method: 'DELETE', user: 'admin' });
      assert.equal((await f.request('/api/me', { user: 'luisa' })).status, 401);
      for (let i = 0; i < 20 && !luisaEvents.isClosed(); i += 1) await new Promise((r) => setTimeout(r, 50));
      assert.equal(luisaEvents.isClosed(), true, 'the stream of a removed user is closed');

      // Signing out revokes the token itself, not just the cookie.
      const copy = f.cookies.admin;
      await f.request('/api/logout', { method: 'POST', user: 'admin', body: {} });
      f.cookies.admin = copy;
      assert.equal((await f.request('/api/me', { user: 'admin' })).status, 401);
    } finally {
      await fresh.close();
    }
  });

  test('a spoofed X-Forwarded-For does not get around the sign-in limit', async () => {
    const proxied = await createApp(
      loadConfig({ DATA_DIR: '', TRUST_PROXY: 'true', USERS: `ana:${hashPassword('password-ana')}` }, []),
    );
    const port = await proxied.listen(0, '127.0.0.1');
    const f = client(`http://127.0.0.1:${port}`);
    try {
      const attempt = (i) =>
        f.request('/api/login', {
          method: 'POST',
          body: { username: 'ana', password: `wrong-${i}` },
          // The client controls the first entries; the proxy appends the real address last.
          headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` },
        });
      for (let i = 0; i < 10; i += 1) assert.equal((await attempt(i)).status, 401);
      assert.equal((await attempt(99)).status, 429);
    } finally {
      await proxied.close();
    }
  });

  test('guessing the setup code is rate limited', async () => {
    const fresh = await createApp(loadConfig({ SETUP_CODE: 'ABCD-EFGH', DATA_DIR: '' }, []));
    const port = await fresh.listen(0, '127.0.0.1');
    const f = client(`http://127.0.0.1:${port}`);
    try {
      const attempt = (code) =>
        f.request('/api/setup/account', { method: 'POST', body: { code, username: 'admin', password: 'password-admin' } });
      for (let i = 0; i < 10; i += 1) assert.equal((await attempt(`WRONG-${i}`)).status, 403);
      const blocked = await attempt('ABCD-EFGH');
      assert.equal(blocked.status, 429, 'even the right code waits once the limit is hit');
    } finally {
      await fresh.close();
    }
  });
});
