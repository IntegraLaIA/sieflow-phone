// The softphone: incoming calls, dialer, call controls and recent calls.
// It builds its own DOM inside one root element so the whole phone can move
// into a floating always-on-top window (Document Picture-in-Picture) and back.
// Media: one RTCPeerConnection straight to WhatsApp, no media server.

import { api, errorText, prefs } from './api.js';
import { t } from './i18n.js';
import { formatDuration, formatWhen, h, icon, initials, setToastHost, toast } from './ui.js';

const BAD_OUTCOMES = new Set(['missed', 'failed']);
const PHASE_LABEL = { dialing: 'phaseDialing', ringing: 'phaseRinging', connecting: 'phaseConnecting', active: 'phaseActive' };

let ctx = null; // { me(), openConversation(peer, options), onChange() }
let root = null;
let home = null; // where the phone lives when it is not floating
let placeholder = null;
let pipWindow = null;

const q = (selector) => root.querySelector(selector);

const state = {
  calls: new Map(), // live calls, as the server sees them
  history: [],
  session: null, // the call handled by this browser
  pendingAnswers: new Map(), // SDP answers that arrived before the dial request returned
  permissionFor: null, // number that still needs a call permission
};

const formatNumber = (digits) => (digits ? `+${digits}` : t('unknownNumber'));
const displayName = (call) => call.peerName || formatNumber(call.peer);

// ---------------------------------------------------------------- sound

const sound = {
  ctx: null,
  ringTimer: null,
  ringGain: null,

  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return;
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().then(() => ctx?.onChange(), () => {});
  },

  get ready() {
    return this.ctx?.state === 'running';
  },

  startRing() {
    if (this.ringTimer || !this.ready) return;
    const burst = () => {
      const now = this.ctx.currentTime;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.05);
      gain.gain.setValueAtTime(0.12, now + 1.9);
      gain.gain.linearRampToValueAtTime(0, now + 2);
      gain.connect(this.ctx.destination);
      for (const frequency of [440, 480]) {
        const osc = this.ctx.createOscillator();
        osc.frequency.value = frequency;
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 2);
      }
      this.ringGain = gain;
    };
    burst();
    this.ringTimer = setInterval(burst, 4000);
  },

  stopRing() {
    clearInterval(this.ringTimer);
    this.ringTimer = null;
    this.ringGain?.disconnect();
    this.ringGain = null;
  },
};

// A test tone instead of a microphone, offered in demo mode.
function toneStream() {
  const audioCtx = sound.ctx ?? new AudioContext();
  const osc = audioCtx.createOscillator();
  osc.frequency.value = 523;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.08;
  const destination = audioCtx.createMediaStreamDestination();
  osc.connect(gain).connect(destination);
  osc.start();
  destination.stream.stopTone = () => osc.stop();
  return destination.stream;
}

export async function getMicrophone() {
  const choice = prefs.read('mic');
  if (choice === 'tone') return toneStream();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('micHttps'));
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (choice) audio.deviceId = { exact: choice };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio });
  } catch (error) {
    if (choice && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
      prefs.write('mic', '');
      delete audio.deviceId;
      return navigator.mediaDevices.getUserMedia({ audio });
    }
    if (error.name === 'NotAllowedError') throw new Error(t('micBlocked'));
    if (error.name === 'NotFoundError') throw new Error(t(ctx.me()?.demo ? 'micMissingDemo' : 'micMissing'));
    throw error;
  }
}

export function applySpeaker() {
  const audio = document.querySelector('#remote-audio');
  const id = prefs.read('speaker');
  if (audio && id && typeof audio.setSinkId === 'function') audio.setSinkId(id).catch(() => {});
}

// ---------------------------------------------------------------- WebRTC

// WhatsApp takes the SDP in a single request (no trickle ICE), so wait for
// candidate gathering to finish, with a cap so a slow STUN/TURN server
// cannot eat the 30 to 60 s Meta gives us to answer.
function waitForIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && finish();
    timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function waitForConnection(pc, timeoutMs) {
  const connected = () =>
    pc.connectionState === 'connected' || ['connected', 'completed'].includes(pc.iceConnectionState);
  if (connected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    const finish = (value) => {
      clearTimeout(timer);
      pc.removeEventListener('connectionstatechange', check);
      pc.removeEventListener('iceconnectionstatechange', check);
      resolve(value);
    };
    const check = () => {
      if (connected()) finish(true);
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') finish(false);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    pc.addEventListener('connectionstatechange', check);
    pc.addEventListener('iceconnectionstatechange', check);
  });
}

class CallSession {
  constructor({ id = null, direction, peer, peerName = null }) {
    this.id = id;
    this.direction = direction;
    this.peer = peer;
    this.peerName = peerName;
    this.phase = direction === 'inbound' ? 'connecting' : 'dialing'; // dialing | ringing | connecting | active
    this.claimed = false; // the server knows this browser owns the call
    this.muted = false;
    this.keypad = false;
    this.startedAt = null;
    this.pc = null;
    this.mic = null;
    this.sender = null;
    this.clock = null;
    this.ended = false;
  }

  createPeer() {
    const pc = new RTCPeerConnection({ iceServers: ctx.me().iceServers, bundlePolicy: 'max-bundle' });
    pc.ontrack = (event) => {
      const audio = document.querySelector('#remote-audio');
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      applySpeaker();
      audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && !this.ended && this.phase === 'active') {
        toast(t('audioDropped'), { tone: 'error' });
        hangup();
      }
      updateDiagnostics();
    };
    this.pc = pc;
    return pc;
  }

  stopMedia() {
    this.mic?.getTracks().forEach((track) => track.stop());
    this.mic?.stopTone?.();
  }

  cleanup() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.clock);
    this.stopMedia();
    this.pc?.close();
    document.querySelector('#remote-audio').srcObject = null;
  }
}

function startTalking(session) {
  if (session.phase === 'active') return;
  session.phase = 'active';
  session.startedAt = Date.now();
  session.clock = setInterval(updateClock, 1000);
  // Outgoing calls attach the microphone only once the person picks up.
  const track = session.mic?.getAudioTracks()[0];
  if (track && session.sender && !session.sender.track) {
    track.enabled = !session.muted;
    session.sender.replaceTrack(track).catch((error) => toast(t('audioSetupFailed', { error: error.message }), { tone: 'error' }));
  }
  render();
}

function endSession(session) {
  session.cleanup();
  if (state.session === session) state.session = null;
  render();
}

const callUrl = (id, action) => `/api/calls/${encodeURIComponent(id)}/${action}`;

async function answer(call) {
  if (state.session) return toast(t('hangUpFirst'));
  sound.stopRing();
  const session = new CallSession({ ...call, direction: 'inbound' });
  state.session = session;
  render();
  ctx.openConversation(call.peer);
  try {
    session.mic = await getMicrophone();
    if (session.ended) return session.stopMedia();
    const pc = session.createPeer();
    await pc.setRemoteDescription({ type: 'offer', sdp: call.offerSdp });
    const transceiver = pc.getTransceivers().find((tr) => tr.receiver.track?.kind === 'audio');
    if (!transceiver) throw new Error(t('noAudioInOffer'));
    transceiver.direction = 'sendrecv';
    session.sender = transceiver.sender;
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIceGathering(pc, 2000);
    if (session.ended) return;

    await api(callUrl(call.id, 'pre-accept'), { sdp: pc.localDescription.sdp });
    session.claimed = true;
    await waitForConnection(pc, 10_000);
    if (session.ended) return;
    await api(callUrl(call.id, 'accept'), {});
    // WhatsApp asks for media only after accept returns 200 OK.
    const track = session.mic.getAudioTracks()[0];
    track.enabled = !session.muted;
    await session.sender.replaceTrack(track);
    startTalking(session);
  } catch (error) {
    if (session.claimed) api(callUrl(call.id, 'hangup'), {}).catch(() => {});
    endSession(session);
    toast(error.code === 'taken' ? errorText(error) : t('couldNotAnswer', { error: errorText(error) }), { tone: 'error' });
  }
}

async function decline(call) {
  try {
    await api(callUrl(call.id, 'reject'), {});
  } catch (error) {
    if (error.status !== 404) toast(t('couldNotDecline', { error: errorText(error) }), { tone: 'error' });
  }
}

async function applyAnswer(session, sdp) {
  if (session.ended || session.pc?.signalingState !== 'have-local-offer') return;
  await session.pc.setRemoteDescription({ type: 'answer', sdp });
}

export async function dial(rawNumber, { name = null } = {}) {
  const to = String(rawNumber ?? '').replace(/\D/g, '');
  if (to.length < 7 || to.length > 15) return toast(t('errors.bad_number'), { tone: 'error' });
  if (state.session) return toast(t('hangUpFirst'));
  state.permissionFor = null;
  const session = new CallSession({ direction: 'outbound', peer: to, peerName: name });
  state.session = session;
  render();
  try {
    session.mic = await getMicrophone();
    if (session.ended) return session.stopMedia();
    const pc = session.createPeer();
    // No microphone on the line until the person answers (see startTalking).
    session.sender = pc.addTransceiver('audio', { direction: 'sendrecv', streams: [session.mic] }).sender;
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc, 2000);
    if (session.ended) return;

    const result = await api('/api/calls', { to, sdp: pc.localDescription.sdp });
    session.id = result.callId;
    session.claimed = true;
    if (session.ended) return void api(callUrl(result.callId, 'hangup'), {}).catch(() => {});
    const answerSdp = result.answerSdp ?? state.pendingAnswers.get(result.callId)?.sdp;
    state.pendingAnswers.delete(result.callId);
    if (answerSdp) await applyAnswer(session, answerSdp);
    const live = state.calls.get(result.callId);
    if (live) syncSession(live);
    render();
  } catch (error) {
    endSession(session);
    if (error.code === 'no_permission') {
      state.permissionFor = to;
      render();
    } else {
      toast(t('couldNotCall', { error: errorText(error) }), { tone: 'error' });
    }
  }
}

export async function hangup() {
  const session = state.session;
  if (!session) return;
  endSession(session);
  if (!session.claimed || !session.id) return;
  try {
    await api(callUrl(session.id, 'hangup'), {});
  } catch (error) {
    if (error.status !== 404) toast(t('hangUpFailed', { error: errorText(error) }), { tone: 'error' });
  }
}

function toggleMute() {
  const session = state.session;
  if (!session) return;
  session.muted = !session.muted;
  session.mic?.getAudioTracks().forEach((track) => (track.enabled = !session.muted));
  render();
}

function sendTone(digit) {
  const dtmf = state.session?.sender?.dtmf;
  if (!dtmf || !dtmf.canInsertDTMF) return toast(t('dtmfUnavailable'));
  dtmf.insertDTMF(digit, 120, 70);
}

// Keep the server's view in step with this browser's call.
function syncSession(call) {
  const session = state.session;
  if (!session || session.id !== call.id) return;
  if (call.state === 'ringing' && session.direction === 'outbound') session.phase = 'ringing';
  if (call.state === 'active' && session.direction === 'outbound') startTalking(session);
}

export async function changeMicrophone(value) {
  prefs.write('mic', value);
  const session = state.session;
  if (!session || session.phase !== 'active' || !session.sender) return;
  try {
    const stream = await getMicrophone();
    const track = stream.getAudioTracks()[0];
    track.enabled = !session.muted;
    await session.sender.replaceTrack(track);
    session.stopMedia();
    session.mic = stream;
  } catch (error) {
    toast(t('switchMicFailed', { error: error.message }), { tone: 'error' });
  }
}

// ---------------------------------------------------------------- server events

export function onEvent(name, data) {
  switch (name) {
    case 'snapshot': {
      state.calls = new Map(data.calls.map((call) => [call.id, call]));
      state.history = data.history;
      const session = state.session;
      if (session?.id && !state.calls.has(session.id)) endSession(session);
      break;
    }
    case 'call.ringing':
      state.calls.set(data.id, data);
      notifyIncoming(data);
      break;
    case 'call.updated':
      state.calls.set(data.id, data);
      syncSession(data);
      break;
    case 'call.answer': {
      const session = state.session;
      if (session?.id === data.callId) {
        applyAnswer(session, data.sdp).catch((error) => toast(t('audioSetupFailed', { error: error.message }), { tone: 'error' }));
        return;
      }
      const now = Date.now();
      for (const [id, entry] of state.pendingAnswers) if (now - entry.at > 30_000) state.pendingAnswers.delete(id);
      state.pendingAnswers.set(data.callId, { sdp: data.sdp, at: now });
      return;
    }
    case 'call.ended': {
      state.calls.delete(data.id);
      const entry = {
        id: data.id,
        conversationId: data.conversationId,
        direction: data.direction,
        peer: data.peer,
        peerName: data.peerName,
        agent: data.agent,
        outcome: data.outcome,
        duration: data.duration,
        createdAt: data.createdAt,
      };
      state.history = [entry, ...state.history.filter((item) => item.id !== data.id)].slice(0, 100);
      const session = state.session;
      if (session?.id === data.id) {
        endSession(session);
        if (data.outcome !== 'completed') toast(t('callEnded', { outcome: t(`outcomes.${data.outcome}`) }));
      }
      break;
    }
    case 'permission.reply': {
      const who = data.peerName || formatNumber(data.peer);
      const accepted = data.response === 'accept';
      toast(t(accepted ? 'permissionAccepted' : 'permissionDeclined', { who }), {
        action: accepted ? { label: t('callNow'), run: () => dial(data.peer) } : null,
      });
      if (state.permissionFor === data.peer) state.permissionFor = null;
      break;
    }
    default:
      return;
  }
  render();
}

function notifyIncoming(call) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const notification = new Notification(t('incoming'), { body: displayName(call), tag: call.id });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

// ---------------------------------------------------------------- rendering

const incomingCalls = () =>
  [...state.calls.values()].filter((call) => call.direction === 'inbound' && call.state === 'ringing');

export const hasIncoming = () => incomingCalls().length > 0;
export const isBusy = () => Boolean(state.session);
export const isPoppedOut = () => Boolean(pipWindow);

function clockText(session) {
  return session.phase === 'active' ? formatDuration((Date.now() - session.startedAt) / 1000) : '';
}

function updateClock() {
  const el = root && q('.js-call-clock');
  if (el && state.session) el.textContent = clockText(state.session);
}

function updateDiagnostics() {
  const el = root && q('.js-call-diag');
  if (!el || !state.session) return;
  const raw = state.session.pc?.connectionState ?? 'new';
  el.textContent = t('audioLink', { state: t('linkStates')[raw] ?? raw });
}

function roundButton({ label, iconName, onclick, variant = '', disabled = false, pressed = null }) {
  return h(
    'button',
    {
      class: `round ${variant} ${pressed ? 'on' : ''}`,
      type: 'button',
      title: label,
      disabled,
      'aria-pressed': pressed === null ? null : String(pressed),
      onclick,
    },
    h('span', { class: 'disc' }, icon(iconName, variant ? 21 : 18, 1.9)),
    h('span', { class: 'label', text: label }),
  );
}

function keypadButtons(onPress) {
  const letters = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ', 0: '+' };
  return [...'123456789*0#'].map((key) =>
    h(
      'button',
      { type: 'button', 'aria-label': key, onclick: () => onPress(key) },
      h('span', { class: 'digit', text: key }),
      h('span', { class: 'letters', text: letters[key] ?? '' }),
    ),
  );
}

function contactBlock(name, number, ringing = false) {
  return h(
    'div',
    { class: 'contact' },
    h('span', { class: `tile ${ringing ? 'ringing' : ''}`, text: initials(name) }),
    h('div', { class: 'who' }, h('div', { class: 'name', text: name }), h('div', { class: 'sub', text: number })),
  );
}

function renderCallPanel() {
  const panel = q('.js-call-panel');
  const session = state.session;
  panel.hidden = !session;
  if (!session) return panel.replaceChildren();
  const name = session.peerName || formatNumber(session.peer);
  const number = session.peerName ? formatNumber(session.peer) : t('whatsappCall');
  const active = session.phase === 'active';
  panel.replaceChildren(
    h(
      'div',
      { class: 'call' },
      h(
        'div',
        { class: `call-strip ${active ? 'live' : ''}` },
        h('span', { class: 'dot' }),
        h('span', { class: 'state', text: t(PHASE_LABEL[session.phase]) }),
        h('span', { class: 'clock js-call-clock', text: clockText(session) }),
        h('span', { class: 'diag' }, icon('waves', 13), h('span', { class: 'js-call-diag' })),
      ),
      h(
        'div',
        { class: 'call-body' },
        contactBlock(name, number),
        session.keypad && h('div', { class: 'keypad' }, keypadButtons(sendTone)),
        h(
          'div',
          { class: 'controls' },
          roundButton({
            label: session.muted ? t('unmute') : t('mute'),
            iconName: session.muted ? 'micOff' : 'mic',
            onclick: toggleMute,
            disabled: !active,
            pressed: session.muted,
          }),
          roundButton({
            label: t('keypad'),
            iconName: 'keypad',
            disabled: !active,
            pressed: session.keypad,
            onclick: () => {
              session.keypad = !session.keypad;
              render();
            },
          }),
          roundButton({ label: t('openChat'), iconName: 'msg', onclick: () => ctx.openConversation(session.peer) }),
          roundButton({ label: t('hangUp'), iconName: 'hangup', variant: 'danger', onclick: hangup }),
        ),
      ),
    ),
  );
  updateDiagnostics();
}

function renderIncoming() {
  const panel = q('.js-incoming-panel');
  const calls = incomingCalls();
  panel.hidden = calls.length === 0;
  const busy = Boolean(state.session);
  panel.replaceChildren(
    h(
      'div',
      { class: 'incoming' },
      calls.map((call) =>
        h(
          'div',
          { class: 'call' },
          h('div', { class: 'call-strip' }, h('span', { class: 'dot' }), h('span', { class: 'state', text: t('incoming') })),
          h(
            'div',
            { class: 'call-body' },
            contactBlock(displayName(call), call.peerName ? formatNumber(call.peer) : t('whatsappCall'), true),
            h(
              'div',
              { class: 'controls' },
              roundButton({ label: t('decline'), iconName: 'hangup', variant: 'danger', onclick: () => decline(call) }),
              roundButton({ label: t('answer'), iconName: 'phone', variant: 'go', disabled: busy, onclick: () => answer(call) }),
            ),
          ),
        ),
      ),
    ),
  );
  if (calls.length && !busy) sound.startRing();
  else sound.stopRing();
}

function renderDialer() {
  q('.js-dialer-panel').hidden = Boolean(state.session);
  const value = q('.js-dial-input').value;
  q('.js-dial-back').hidden = !value;
  q('.js-dial-hint').textContent = value ? t('dialHintFull') : t('dialHintEmpty');
  const note = q('.js-permission-note');
  note.hidden = !state.permissionFor;
  if (state.permissionFor) {
    q('.js-permission-text').textContent = t('permissionText', { number: formatNumber(state.permissionFor) });
  }
}

function renderHistory() {
  const list = q('.js-recent-list');
  q('.js-recent-empty').hidden = state.history.length > 0;
  list.replaceChildren(
    ...state.history.slice(0, 30).map((call) => {
      const bad = BAD_OUTCOMES.has(call.outcome);
      const details = [t(`outcomes.${call.outcome}`)];
      if (call.duration) details.push(formatDuration(call.duration));
      if (call.agent) details.push(call.agent);
      const iconName = bad ? 'phoneMissed' : call.direction === 'inbound' ? 'phoneIncoming' : 'phoneOutgoing';
      return h(
        'li',
        { class: 'history-item' },
        h(
          'button',
          { class: 'history-open', type: 'button', title: t('openChat'), onclick: () => ctx.openConversation(call.peer) },
          h('span', { class: `tile small ${bad ? 'bad' : ''}` }, icon(iconName, 15)),
          h('span', { class: 'who' }, h('span', { class: 'name', text: displayName(call) }), h('span', { class: 'sub', text: details.join(' · ') })),
          h('span', { class: 'when', text: formatWhen(call.createdAt) }),
        ),
        h(
          'button',
          { class: 'icon-btn small', type: 'button', title: t('callBack'), 'aria-label': t('callBack'), onclick: () => dial(call.peer, { name: call.peerName }) },
          icon('phone', 15),
        ),
      );
    }),
  );
}

export function render() {
  if (!root) return;
  renderCallPanel();
  renderIncoming();
  renderDialer();
  renderHistory();
  q('.js-pip').hidden = !('documentPictureInPicture' in window);
  q('.js-pip').title = pipWindow ? t('popIn') : t('popOut');
  ctx?.onChange();
}

// ---------------------------------------------------------------- floating window

async function popOut() {
  if (pipWindow) return popIn();
  if (!('documentPictureInPicture' in window)) return;
  let pip;
  try {
    pip = await window.documentPictureInPicture.requestWindow({ width: 380, height: 660 });
  } catch {
    return toast(t('popOutFailed'), { tone: 'error' });
  }
  const doc = pip.document;
  // Same-origin stylesheets by URL: the page CSP does not allow inline styles.
  for (const sheet of document.querySelectorAll('link[rel="stylesheet"]')) {
    doc.head.append(Object.assign(doc.createElement('link'), { rel: 'stylesheet', href: sheet.href }));
  }
  doc.title = 'SieFlow Phone';
  doc.documentElement.lang = document.documentElement.lang;
  if (document.documentElement.dataset.theme) doc.documentElement.dataset.theme = document.documentElement.dataset.theme;
  doc.body.className = 'pip-body';
  const toasts = doc.createElement('div');
  toasts.className = 'toasts';
  doc.body.append(root, toasts);
  setToastHost(toasts);
  pipWindow = pip;
  placeholder.hidden = false;
  pip.addEventListener('pagehide', () => {
    home.prepend(root);
    setToastHost(null);
    pipWindow = null;
    placeholder.hidden = true;
    render();
  });
  render();
}

function popIn() {
  pipWindow?.close();
}

window.addEventListener('sieflow-phone:theme', (event) => {
  if (pipWindow) pipWindow.document.documentElement.dataset.theme = event.detail;
});

// ---------------------------------------------------------------- setup

function build() {
  const input = h('input', {
    class: 'js-dial-input',
    type: 'tel',
    inputmode: 'tel',
    placeholder: t('dialPlaceholder'),
    'aria-label': t('dialPlaceholder'),
    oninput: renderDialer,
  });
  const press = (key) => {
    input.value = (input.value + key).slice(0, 20);
    input.focus();
    renderDialer();
  };
  return h(
    'div',
    { class: 'phone-root' },
    h(
      'div',
      { class: 'phone-head' },
      h('span', { class: 'accent-icon' }, icon('phone', 16)),
      h('span', { class: 'section-title', text: t('phone') }),
      h('span', { class: 'grow' }),
      h('button', { class: 'icon-btn small js-pip', type: 'button', onclick: popOut }, icon('pip', 16)),
      h(
        'button',
        { class: 'icon-btn small js-phone-close', type: 'button', title: t('close'), onclick: () => ctx.closePhone() },
        icon('x', 16),
      ),
    ),
    h('div', { class: 'js-call-panel', hidden: true }),
    h('div', { class: 'js-incoming-panel', hidden: true }),
    h(
      'div',
      { class: 'js-dialer-panel' },
      h(
        'div',
        { class: 'section-head' },
        h('span', { class: 'accent-icon' }, icon('keypad', 16)),
        h('span', { class: 'section-title', text: t('keypad') }),
        h('span', { class: 'section-hint js-dial-hint' }),
      ),
      h(
        'form',
        {
          class: 'dialer',
          autocomplete: 'off',
          onsubmit: (event) => {
            event.preventDefault();
            dial(input.value);
          },
        },
        h(
          'div',
          { class: 'dial-display' },
          input,
          h(
            'button',
            {
              class: 'ghost-btn js-dial-back',
              type: 'button',
              title: t('backspace'),
              hidden: true,
              onclick: () => {
                input.value = input.value.slice(0, -1);
                input.focus();
                renderDialer();
              },
            },
            icon('back', 16),
          ),
        ),
        h('div', { class: 'keypad' }, keypadButtons(press)),
        h(
          'div',
          { class: 'dial-actions' },
          h('button', { class: 'btn primary grow', type: 'submit' }, icon('phone', 16), h('span', { text: t('call') })),
          h(
            'button',
            {
              class: 'icon-btn tall',
              type: 'button',
              title: t('clear'),
              onclick: () => {
                input.value = '';
                state.permissionFor = null;
                renderDialer();
              },
            },
            icon('x', 16),
          ),
        ),
      ),
      h(
        'div',
        { class: 'note js-permission-note', hidden: true },
        h('p', { class: 'js-permission-text' }),
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            onclick: () => ctx.openConversation(state.permissionFor, { requestPermission: true }),
          },
          h('span', { text: t('askPermission') }),
        ),
      ),
    ),
    h(
      'section',
      { class: 'recent' },
      h(
        'div',
        { class: 'section-head' },
        h('span', { class: 'accent-icon' }, icon('clock', 16)),
        h('span', { class: 'section-title', text: t('recentCalls') }),
      ),
      h('ul', { class: 'history-list js-recent-list' }),
      h('p', { class: 'empty js-recent-empty', text: t('noCalls') }),
    ),
  );
}

// `container` holds the phone; `floatingNote` is shown while it is popped out.
export function mount(container, floatingNote, context) {
  ctx = context;
  home = container;
  placeholder = floatingNote;
  root = build();
  container.prepend(root);
  document.addEventListener('pointerdown', () => sound.unlock());
  document.addEventListener('keydown', () => sound.unlock());
  floatingNote.querySelector('button')?.addEventListener('click', popIn);
  render();
}

// Rebuild after a language change, keeping the call state.
export function relabel() {
  if (!root) return;
  const fresh = build();
  root.replaceWith(fresh);
  root = fresh;
  render();
}

export const soundReady = () => sound.ready;
export const unlockSound = () => sound.unlock();

export function leave() {
  const session = state.session;
  if (!session?.claimed || !session.id) return;
  fetch(callUrl(session.id, 'hangup'), {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => {});
}
