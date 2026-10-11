// SieFlow Phone: bootstrap, views, server events and the shared header.
// Plain browser modules, no build step.

import { api, errorText, prefs } from './api.js';
import { applyI18n, languageSetting, setLanguage, t } from './i18n.js';
import * as inbox from './inbox.js';
import * as phone from './phone.js';
import { $, h, hydrateIcons, initials, initTheme, toast } from './ui.js';
import * as wizard from './wizard.js';

const app = { me: null, events: null, online: false, agents: [], started: false };

const VIEWS = ['#login-view', '#waiting-view', '#wizard-view', '#app-view'];
const PHONE_EVENTS = new Set(['snapshot', 'call.ringing', 'call.updated', 'call.answer', 'call.ended', 'permission.reply']);
const INBOX_EVENTS = new Set(['conversation.updated', 'conversation.deleted', 'message.created', 'message.updated', 'permission.reply']);

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
  document.querySelector('.theme-float').hidden = view === '#app-view';
}

// ---------------------------------------------------------------- chrome

function setPhoneOpen(open) {
  document.body.classList.toggle('phone-open', open);
}

function updateChrome() {
  const unread = inbox.unreadTotal();
  if (phone.hasIncoming()) document.title = t('titleIncoming');
  else document.title = unread > 0 ? `(${unread}) SieFlow Phone` : 'SieFlow Phone';
  $('#sound-btn').hidden = phone.soundReady();
  $('#phone-toggle .ping').hidden = !phone.hasIncoming();
  // On narrow screens the phone floats; a call brings it up by itself.
  if (phone.hasIncoming() || phone.isBusy()) setPhoneOpen(true);
}

function renderStatus() {
  const pill = $('#link-status');
  pill.classList.toggle('online', app.online);
  pill.classList.toggle('offline', !app.online);
  $('#link-label').textContent = app.online ? t('online', { n: Math.max(1, app.agents.length) }) : t('reconnecting');
  pill.title = app.agents.join(', ');
}

function renderHeader() {
  const user = app.me?.user ?? '';
  $('#me').replaceChildren(h('span', { class: 'initials', text: initials(user) }), h('span', { class: 'name', text: user }));
  $('#business-number').textContent = app.me?.displayNumber ?? '';
  $('#admin-btn').hidden = app.me?.role !== 'admin';
  $('#demo-banner').hidden = !app.me?.demo;
  renderStatus();
  updateChrome();
}

// ---------------------------------------------------------------- events

function notifyMessage(data) {
  if (data.message.direction !== 'in' || !document.hidden) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // No message text: notifications show up on locked screens.
  const notification = new Notification(t('newMessage'), { tag: `conversation-${data.conversationId}` });
  notification.onclick = () => {
    window.focus();
    inbox.select(data.conversationId);
    notification.close();
  };
}

function connectEvents() {
  app.events?.close();
  const events = new EventSource('/api/events');
  app.events = events;
  const names = [...new Set([...PHONE_EVENTS, ...INBOX_EVENTS, 'agents'])];
  for (const name of names) {
    events.addEventListener(name, (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      try {
        if (name === 'agents') {
          app.agents = data.agents;
          renderStatus();
          return;
        }
        if (PHONE_EVENTS.has(name)) phone.onEvent(name, data);
        if (INBOX_EVENTS.has(name)) inbox.onEvent(name, data);
        if (name === 'message.created') notifyMessage(data);
        if (name === 'snapshot') inbox.load();
      } catch (error) {
        console.error(`event ${name} failed`, error);
      }
    });
  }
  events.onopen = () => {
    app.online = true;
    renderStatus();
  };
  events.onerror = async () => {
    app.online = false;
    renderStatus();
    if (events.readyState !== EventSource.CLOSED) return; // the browser is already retrying
    try {
      const me = await api('/api/me');
      if (!me.ready) return location.reload();
      setTimeout(connectEvents, 3000);
    } catch (error) {
      if (error.status === 401) showLogin();
      else setTimeout(connectEvents, 5000);
    }
  };
}

// ---------------------------------------------------------------- views

async function showLogin(info = null) {
  app.events?.close();
  app.events = null;
  app.me = null;
  show('#login-view');
  try {
    const data = info ?? (await api('/api/info'));
    const hint = $('#demo-hint');
    if (data.demo && data.login) {
      hint.textContent = t('demoHint', { user: data.login.username, password: data.login.password });
      hint.hidden = false;
    }
  } catch {
    // The hint is optional.
  }
}

function showWorkspace() {
  show('#app-view');
  if (app.me.demo && !prefs.read('mic') && !navigator.mediaDevices?.getUserMedia) prefs.write('mic', 'tone');
  if (!app.started) {
    app.started = true;
    phone.mount($('#phone-col'), $('#phone-floating-note'), {
      me: () => app.me,
      openConversation: (peer, options) => inbox.openByPeer(peer, options),
      onChange: updateChrome,
      closePhone: () => setPhoneOpen(false),
    });
    inbox.init({
      me: () => app.me,
      dial: (number, options) => {
        setPhoneOpen(true);
        phone.dial(number, options);
      },
      onChange: updateChrome,
    });
  }
  renderHeader();
  connectEvents();
}

function enter(me) {
  app.me = me;
  const wantsSetup = location.pathname === '/setup';
  if (me.role === 'admin' && (!me.ready || wantsSetup)) {
    if (!wantsSetup) history.replaceState(null, '', '/setup');
    show('#wizard-view');
    wizard.start({ me });
    return;
  }
  if (wantsSetup) history.replaceState(null, '', '/');
  if (!me.ready) return show('#waiting-view');
  showWorkspace();
}

async function signOut() {
  if (phone.isBusy() && !confirm(t('confirmSignOut'))) return;
  await phone.hangup();
  await api('/api/logout', {}).catch(() => {});
  location.href = '/';
}

// ---------------------------------------------------------------- settings dialog

async function fillDeviceSelects() {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    devices = [];
  }
  const fill = (select, kind, key, labelKey, extra = []) => {
    const current = prefs.read(key);
    const options = [h('option', { value: '' }, t('systemDefault')), ...extra];
    let index = 1;
    for (const device of devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default')) {
      options.push(h('option', { value: device.deviceId }, device.label || t(labelKey, { n: index })));
      index += 1;
    }
    select.replaceChildren(...options);
    select.value = current;
    if (select.value !== current) select.value = '';
  };
  const extra = app.me?.demo ? [h('option', { value: 'tone' }, t('testTone'))] : [];
  fill($('#mic-select'), 'audioinput', 'mic', 'deviceMic', extra);
  const canPickSpeaker = typeof HTMLMediaElement.prototype.setSinkId === 'function';
  $('#speaker-field').hidden = !canPickSpeaker;
  if (canPickSpeaker) fill($('#speaker-select'), 'audiooutput', 'speaker', 'deviceSpeaker');
  $('#lang-select').value = languageSetting();
  $('#notify-btn').hidden = !('Notification' in window) || Notification.permission !== 'default';
}

function bindStatic() {
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const error = $('#login-error');
    error.hidden = true;
    try {
      const me = await api('/api/login', { username: form.get('username'), password: form.get('password') });
      event.target.reset();
      enter(me);
    } catch (err) {
      error.textContent = errorText(err);
      error.hidden = false;
    }
  });

  $('#settings-btn').addEventListener('click', async () => {
    await fillDeviceSelects();
    $('#settings').showModal();
  });
  $('#mic-select').addEventListener('change', (event) => phone.changeMicrophone(event.target.value));
  $('#speaker-select').addEventListener('change', (event) => {
    prefs.write('speaker', event.target.value);
    phone.applySpeaker();
  });
  $('#lang-select').addEventListener('change', async (event) => {
    setLanguage(event.target.value);
    await fillDeviceSelects();
    phone.relabel();
    inbox.refreshLabels();
    wizard.relabel();
    if (app.me) renderHeader();
  });
  $('#notify-btn').addEventListener('click', async () => {
    await Notification.requestPermission();
    $('#notify-btn').hidden = Notification.permission !== 'default';
  });
  $('#sound-btn').addEventListener('click', () => {
    phone.unlockSound();
    updateChrome();
  });
  $('#phone-toggle').addEventListener('click', () => setPhoneOpen(!document.body.classList.contains('phone-open')));
  $('#admin-btn').addEventListener('click', () => {
    location.href = '/setup';
  });
  $('#logout-btn').addEventListener('click', signOut);
  $('#waiting-logout').addEventListener('click', signOut);

  window.addEventListener('beforeunload', (event) => {
    if (phone.isBusy()) event.preventDefault();
  });
  window.addEventListener('pagehide', () => phone.leave());
}

async function boot() {
  hydrateIcons();
  applyI18n();
  initTheme();
  bindStatic();
  let info;
  try {
    info = await api('/api/info');
  } catch (error) {
    return toast(t('serverUnreachable', { error: error.message }), { tone: 'error' });
  }
  if (info.needsAccount) {
    if (location.pathname !== '/setup') history.replaceState(null, '', '/setup');
    show('#wizard-view');
    wizard.start({ needsAccount: true, onSignedIn: (me) => (app.me = me) });
    return;
  }
  try {
    enter(await api('/api/me'));
  } catch (error) {
    if (error.status === 401) showLogin(info);
    else toast(t('serverUnreachable', { error: error.message }), { tone: 'error' });
  }
}

boot();
