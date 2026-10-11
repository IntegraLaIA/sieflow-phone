import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { CallStore, publicCall } from '../src/calls.js';

function store(options = {}) {
  let now = 1_000_000;
  const calls = new CallStore({ now: () => now, ...options });
  calls.tick = (ms) => (now += ms);
  return calls;
}

const inbound = { callId: 'c1', peer: '573001112233', peerName: 'Ana', sdp: 'v=0 offer' };

test('only the first operator can claim a ringing call', () => {
  const calls = store();
  calls.addInbound(inbound);
  calls.claim('c1', 'ana', 'v=0 answer');
  assert.throws(() => calls.claim('c1', 'luis', 'v=0 other'), { code: 'taken' });
  assert.equal(calls.claim('c1', 'ana', 'v=0 answer-2').answerSdp, 'v=0 answer-2', 'same operator may retry');
});

test('a released claim rings again for everyone', () => {
  const calls = store();
  calls.addInbound(inbound);
  calls.claim('c1', 'ana', 'v=0 answer');
  calls.release('c1', 'ana');
  assert.equal(calls.get('c1').state, 'ringing');
  assert.equal(calls.claim('c1', 'luis', 'v=0 answer').agent, 'luis');
});

test('duplicate connect webhooks do not create a second call', () => {
  const calls = store();
  assert.ok(calls.addInbound(inbound));
  assert.equal(calls.addInbound(inbound), null);
  assert.equal(calls.live().length, 1);
});

test('answered calls end as completed with their duration', () => {
  const calls = store();
  const ended = [];
  calls.on('ended', (call) => ended.push(call));
  calls.addInbound(inbound);
  calls.claim('c1', 'ana', 'v=0 answer');
  calls.activate('c1');
  calls.tick(65_000);
  calls.end('c1');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].outcome, 'completed');
  assert.equal(ended[0].duration, 65);
  assert.equal(calls.end('c1'), null, 'ending twice is a no-op');
  assert.equal(calls.live().length, 0);
});

test('unanswered inbound calls end as missed', () => {
  const calls = store();
  calls.addInbound(inbound);
  assert.equal(calls.end('c1').outcome, 'missed');
});

test('the offer SDP is only exposed while an inbound call rings', () => {
  const calls = store();
  const call = calls.addInbound(inbound);
  assert.equal(publicCall(call).offerSdp, 'v=0 offer');
  calls.claim('c1', 'ana', 'v=0 answer');
  assert.equal(publicCall(call).offerSdp, undefined);
  assert.equal(publicCall(call).answerSdp, undefined);
});

test('an SDP answer that beats the Graph API response is kept for the outbound call', () => {
  const calls = store();
  assert.equal(calls.outboundAnswer('c2', 'v=0 early answer'), null);
  const call = calls.addOutbound({ callId: 'c2', agent: 'ana', peer: '573009998877' });
  assert.equal(call.answerSdp, 'v=0 early answer');
});

test('outbound status webhooks drive the call state', () => {
  const calls = store();
  const answers = [];
  calls.on('answer', (call) => answers.push(call.answerSdp));
  calls.addOutbound({ callId: 'c2', agent: 'ana', peer: '573009998877' });
  calls.outboundAnswer('c2', 'v=0 answer');
  assert.deepEqual(answers, ['v=0 answer']);
  calls.status('c2', 'RINGING');
  assert.equal(calls.get('c2').state, 'ringing');
  calls.status('c2', 'ACCEPTED');
  assert.equal(calls.get('c2').state, 'active');
});

test('a rejected outbound call ends as rejected', () => {
  const calls = store();
  calls.addOutbound({ callId: 'c3', agent: 'ana', peer: '573009998877' });
  calls.status('c3', 'REJECTED');
  assert.equal(calls.end('c3').outcome, 'rejected');
});

test('a ringing call that never gets a terminate webhook is cleaned up', async () => {
  const calls = new CallStore({ ringTimeoutMs: 20 });
  calls.addInbound(inbound);
  await sleep(50);
  assert.equal(calls.get('c1').state, 'ended');
  assert.equal(calls.get('c1').outcome, 'missed');
});
