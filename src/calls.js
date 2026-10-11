// In-memory call state. One process, one source of truth: SieFlow Phone is meant to
// run as a single container, so there is no shared store to keep in sync.
//
// Inbound:  ringing -> connecting (an operator pre-accepted) -> active -> ended
// Outbound: dialing -> ringing (user's phone rings) -> active -> ended

import { EventEmitter } from 'node:events';

export class CallError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const DEFAULTS = {
  // Meta gives the business 30 to 60 s to answer. This timer only cleans up
  // if the terminate webhook never arrives (lost delivery, server restart).
  ringTimeoutMs: 120_000,
  maxCallMs: 4 * 3_600_000,
  endedRetentionMs: 60_000,
  answerBufferMs: 30_000,
};

export class CallStore extends EventEmitter {
  #calls = new Map();
  #pendingAnswers = new Map();
  #timers = new Map();

  constructor({ now = () => Date.now(), ...options } = {}) {
    super();
    this.now = now;
    this.options = { ...DEFAULTS, ...options };
  }

  get(callId) {
    return this.#calls.get(callId) ?? null;
  }

  live() {
    return [...this.#calls.values()].filter((call) => call.state !== 'ended');
  }

  #require(callId) {
    const call = this.#calls.get(callId);
    if (!call) throw new CallError(404, 'not_found', 'Call not found or already finished');
    return call;
  }

  #timer(callId, ms, fn) {
    clearTimeout(this.#timers.get(callId));
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    this.#timers.set(callId, timer);
  }

  #changed(call) {
    this.emit('update', call);
  }

  addInbound({ callId, peer, peerName, sdp }) {
    if (!callId || this.#calls.has(callId)) return null; // Meta may deliver a webhook twice.
    const call = {
      id: callId,
      direction: 'inbound',
      peer,
      peerName: peerName ?? null,
      state: 'ringing',
      agent: null,
      offerSdp: sdp,
      answerSdp: null,
      outcome: null,
      createdAt: this.now(),
      answeredAt: null,
      endedAt: null,
      duration: null,
    };
    this.#calls.set(callId, call);
    this.#timer(callId, this.options.ringTimeoutMs, () => {
      if (call.state === 'ringing' || call.state === 'connecting') this.end(callId, { outcome: 'missed' });
    });
    this.emit('ringing', call);
    return call;
  }

  claim(callId, agent, sdp) {
    const call = this.#require(callId);
    if (call.direction !== 'inbound') throw new CallError(409, 'not_inbound', 'Only incoming calls can be answered');
    if (call.state === 'connecting' && call.agent === agent) {
      call.answerSdp = sdp; // Same operator retrying, e.g. after a page reload.
      return call;
    }
    if (call.agent && call.agent !== agent) throw new CallError(409, 'taken', `${call.agent} already answered this call`);
    if (call.state !== 'ringing') throw new CallError(409, 'not_ringing', 'This call can no longer be answered');
    call.state = 'connecting';
    call.agent = agent;
    call.answerSdp = sdp;
    this.#changed(call);
    return call;
  }

  release(callId, agent) {
    const call = this.#calls.get(callId);
    if (!call || call.state !== 'connecting' || call.agent !== agent) return;
    call.state = 'ringing';
    call.agent = null;
    call.answerSdp = null;
    this.#changed(call);
  }

  activate(callId) {
    const call = this.#require(callId);
    if (call.state === 'ended') throw new CallError(409, 'ended', 'The call already ended');
    if (call.state !== 'active') {
      call.state = 'active';
      call.answeredAt = this.now();
      // Safety net in case both the terminate webhook and the hangup are lost.
      this.#timer(callId, this.options.maxCallMs, () => this.end(callId));
      this.#changed(call);
    }
    return call;
  }

  addOutbound({ callId, agent, peer }) {
    const call = {
      id: callId,
      direction: 'outbound',
      peer,
      peerName: null,
      state: 'dialing',
      agent,
      offerSdp: null,
      answerSdp: null,
      outcome: null,
      createdAt: this.now(),
      answeredAt: null,
      endedAt: null,
      duration: null,
    };
    this.#calls.set(callId, call);
    this.#timer(callId, this.options.ringTimeoutMs, () => {
      if (call.state === 'dialing' || call.state === 'ringing') this.end(callId, { outcome: 'no_answer' });
    });
    // The connect webhook with the SDP answer can beat the Graph API response.
    const buffered = this.#pendingAnswers.get(callId);
    this.#pendingAnswers.delete(callId);
    if (buffered) call.answerSdp = buffered.sdp;
    this.#changed(call);
    return call;
  }

  outboundAnswer(callId, sdp) {
    const call = this.#calls.get(callId);
    if (!call) {
      const now = this.now();
      for (const [id, entry] of this.#pendingAnswers) {
        if (now - entry.at > this.options.answerBufferMs) this.#pendingAnswers.delete(id);
      }
      this.#pendingAnswers.set(callId, { sdp, at: now });
      return null;
    }
    if (call.direction !== 'outbound' || call.state === 'ended') return null;
    call.answerSdp = sdp;
    this.emit('answer', call);
    return call;
  }

  status(callId, status) {
    const call = this.#calls.get(callId);
    if (!call || call.state === 'ended') return null;
    if (status === 'RINGING' && call.state === 'dialing') {
      call.state = 'ringing';
    } else if (status === 'ACCEPTED') {
      return this.activate(callId);
    } else if (status === 'REJECTED') {
      call.outcome = 'rejected'; // The terminate webhook follows and ends the call.
    } else {
      return call;
    }
    this.#changed(call);
    return call;
  }

  end(callId, { outcome, duration, agent } = {}) {
    const call = this.#calls.get(callId);
    if (!call || call.state === 'ended') return null;
    clearTimeout(this.#timers.get(callId));
    const now = this.now();
    if (agent && !call.agent) call.agent = agent;
    call.outcome =
      outcome ?? call.outcome ?? (call.answeredAt ? 'completed' : call.direction === 'inbound' ? 'missed' : 'no_answer');
    call.state = 'ended';
    call.endedAt = now;
    call.duration = duration ?? (call.answeredAt ? Math.round((now - call.answeredAt) / 1000) : 0);
    this.emit('ended', call);
    this.#timer(callId, this.options.endedRetentionMs, () => {
      this.#calls.delete(callId);
      this.#timers.delete(callId);
    });
    return call;
  }
}

// What operators see. SDPs stay out, except the offer of a ringing inbound
// call: the browser that answers needs it.
export function publicCall(call) {
  const view = {
    id: call.id,
    direction: call.direction,
    peer: call.peer,
    peerName: call.peerName,
    state: call.state,
    agent: call.agent,
    outcome: call.outcome,
    createdAt: call.createdAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    duration: call.duration,
  };
  if (call.direction === 'inbound' && call.state === 'ringing') view.offerSdp = call.offerSdp;
  return view;
}
