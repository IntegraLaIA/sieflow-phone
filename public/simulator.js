// The WhatsApp user, simulated in a browser tab (demo mode only).

import { applyI18n, t } from './i18n.js';
import { $, formatTime, h, hydrateIcons, icon, initTheme } from './ui.js';

const sim = { pc: null, stream: null, callId: null, phase: 'idle', detail: '', statsTimer: null, ctx: null, lastBytes: 0 };
const chat = []; // { id, from: 'me' | 'business', kind, body, at, answer }

const me = () => ({ from: $('#sim-number').value, name: $('#sim-name').value });

function renderChat() {
  const box = $('#sim-chat');
  if (!chat.length) return box.replaceChildren(h('p', { class: 'small-print', text: t('simChatEmpty') }));
  box.replaceChildren(
    ...chat.map((item) => {
      const mine = item.from === 'me';
      const parts = [];
      if (item.kind === 'call_permission_request' || item.permission) {
        parts.push(h('span', { class: 'chip small accent' }, icon('phone', 11), t('kinds.call_permission_request')));
      }
      if (item.body) parts.push(h('span', { class: 'text', text: item.body }));
      if (item.permission && !item.answer) {
        parts.push(
          h(
            'span',
            { class: 'sim-row' },
            h('button', { class: 'btn small primary', type: 'button', onclick: () => answerPermission(item, 'accept') }, t('simAllow')),
            h('button', { class: 'btn small', type: 'button', onclick: () => answerPermission(item, 'reject') }, t('simDeny')),
          ),
        );
      }
      if (item.answer) parts.push(h('em', { text: item.answer === 'accept' ? t('simAllowed') : t('simDenied') }));
      return h(
        'div',
        { class: `msg ${mine ? 'out' : 'in'}` },
        h('div', { class: 'bubble' }, ...parts),
        h('div', { class: 'meta' }, h('span', { text: formatTime(item.at) })),
      );
    }),
  );
  box.scrollTop = box.scrollHeight;
}

async function answerPermission(item, response) {
  item.answer = response;
  renderChat();
  await post('/demo/sim/permission', { ...me(), context: item.id, response }).catch(() => {});
}

async function sendText(event) {
  event.preventDefault();
  const input = $('#sim-text');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    const { id } = await post('/demo/sim/message', { ...me(), text });
    chat.push({ id, from: 'me', kind: 'text', body: text, at: Date.now() });
    renderChat();
  } catch (error) {
    setPhase(sim.phase, t('simError', { error: error.message }));
  }
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
  return data;
}

async function audioSource() {
  if ($('#sim-source').value === 'mic') return navigator.mediaDevices.getUserMedia({ audio: true });
  sim.ctx ??= new AudioContext();
  const osc = sim.ctx.createOscillator();
  osc.frequency.value = 660;
  const gain = sim.ctx.createGain();
  gain.gain.value = 0.08;
  const destination = sim.ctx.createMediaStreamDestination();
  osc.connect(gain).connect(destination);
  osc.start();
  destination.stream.stopTone = () => osc.stop();
  return destination.stream;
}

function newPeer() {
  const pc = new RTCPeerConnection();
  pc.ontrack = (event) => {
    const audio = $('#sim-audio');
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    audio.play().catch(() => {});
  };
  pc.onconnectionstatechange = render;
  return pc;
}

function waitForIce(pc, timeoutMs = 2000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function setPhase(phase, detail = '') {
  sim.phase = phase;
  sim.detail = detail;
  render();
}

function render() {
  $('#sim-state').textContent = t(`simPhases.${sim.phase}`);
  const link = sim.pc ? t('audioLink', { state: t('linkStates')[sim.pc.connectionState] ?? sim.pc.connectionState }) : '';
  $('#sim-detail').textContent = [sim.detail, link].filter(Boolean).join(' · ');
  $('#sim-call').hidden = !['idle', 'ended'].includes(sim.phase);
  $('#sim-answer').hidden = sim.phase !== 'ringing';
  $('#sim-decline').hidden = sim.phase !== 'ringing';
  $('#sim-hangup').hidden = !['calling', 'connecting', 'active'].includes(sim.phase);
  if (!sim.statsTimer) $('#sim-stats').textContent = t('simNoAudio');
}

function cleanup() {
  clearInterval(sim.statsTimer);
  sim.statsTimer = null;
  sim.pc?.close();
  sim.pc = null;
  sim.stream?.getTracks().forEach((track) => track.stop());
  sim.stream?.stopTone?.();
  sim.stream = null;
  sim.callId = null;
  $('#sim-meter').style.width = '0';
}

function setSending(on) {
  sim.stream?.getAudioTracks().forEach((track) => (track.enabled = on));
}

function startStats() {
  clearInterval(sim.statsTimer);
  sim.lastBytes = 0;
  sim.statsTimer = setInterval(async () => {
    if (!sim.pc) return;
    let inbound = null;
    (await sim.pc.getStats()).forEach((report) => {
      if (report.type === 'inbound-rtp' && report.kind === 'audio') inbound = report;
    });
    if (!inbound) return;
    const kbps = ((inbound.bytesReceived - sim.lastBytes) * 8) / 1000;
    sim.lastBytes = inbound.bytesReceived;
    $('#sim-stats').textContent = t('simReceived', {
      packets: inbound.packetsReceived,
      kb: Math.round(inbound.bytesReceived / 1024),
    });
    $('#sim-meter').style.width = `${Math.min(100, (kbps / 40) * 100)}%`;
  }, 1000);
}

const fail = (error) => {
  cleanup();
  setPhase('idle', t('simError', { error: error.message }));
};

async function callBusiness() {
  cleanup();
  try {
    sim.stream = await audioSource();
    setSending(false); // WhatsApp only carries audio once the business accepts.
    sim.pc = newPeer();
    sim.pc.addTransceiver(sim.stream.getAudioTracks()[0], { direction: 'sendrecv', streams: [sim.stream] });
    await sim.pc.setLocalDescription(await sim.pc.createOffer());
    await waitForIce(sim.pc);
    setPhase('calling', t('simWaiting'));
    const { callId } = await post('/demo/sim/call', {
      from: $('#sim-number').value,
      name: $('#sim-name').value,
      sdp: sim.pc.localDescription.sdp,
    });
    sim.callId = callId;
    startStats();
  } catch (error) {
    fail(error);
  }
}

async function answerBusiness() {
  try {
    await post('/demo/sim/accept', { callId: sim.callId });
    setSending(true);
    setPhase('active');
  } catch (error) {
    fail(error);
  }
}

async function declineBusiness() {
  const callId = sim.callId;
  cleanup();
  setPhase('ended', t('simYouDeclined'));
  await post('/demo/sim/decline', { callId }).catch(() => {});
}

async function hangUp() {
  const callId = sim.callId;
  cleanup();
  setPhase('ended', t('simYouHungUp'));
  if (callId) await post('/demo/sim/hangup', { callId }).catch(() => {});
}

function listen() {
  const events = new EventSource('/demo/events');
  const on = (name, handler) =>
    events.addEventListener(name, (event) => {
      Promise.resolve(handler(JSON.parse(event.data))).catch(fail);
    });

  on('answer', async ({ callId, sdp }) => {
    if (callId !== sim.callId || !sim.pc) return;
    await sim.pc.setRemoteDescription({ type: 'answer', sdp });
    setPhase('connecting', t('simPickedUp'));
  });

  on('accepted', ({ callId }) => {
    if (callId !== sim.callId) return;
    setSending(true);
    setPhase('active');
  });

  on('incoming', async ({ callId, from, sdp }) => {
    if (sim.callId) return; // Busy: the business call times out, as on a real phone.
    cleanup();
    sim.callId = callId;
    sim.stream = await audioSource();
    setSending(false);
    sim.pc = newPeer();
    await sim.pc.setRemoteDescription({ type: 'offer', sdp });
    const transceiver = sim.pc.getTransceivers()[0];
    transceiver.direction = 'sendrecv';
    await transceiver.sender.replaceTrack(sim.stream.getAudioTracks()[0]);
    await sim.pc.setLocalDescription(await sim.pc.createAnswer());
    await waitForIce(sim.pc);
    await post('/demo/sim/ringing', { callId, sdp: sim.pc.localDescription.sdp });
    setPhase('ringing', t('simBusinessCalling', { from }));
    startStats();
  });

  on('ended', ({ callId }) => {
    if (callId !== sim.callId) return;
    cleanup();
    setPhase('ended', t('simBusinessEnded'));
  });

  on('message', ({ id, kind, body, permission }) => {
    chat.push({ id, from: 'business', kind, body, permission: Boolean(permission), at: Date.now() });
    renderChat();
  });
}

hydrateIcons();
applyI18n();
initTheme();
$('#sim-call').addEventListener('click', callBusiness);
$('#sim-answer').addEventListener('click', answerBusiness);
$('#sim-decline').addEventListener('click', declineBusiness);
$('#sim-hangup').addEventListener('click', hangUp);
$('#sim-send').addEventListener('submit', sendText);
listen();
render();
renderChat();
