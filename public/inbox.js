// Shared inbox: conversation list, thread with messages and calls, composer,
// templates, call permission requests, assignment.

import { api, errorText, prefs } from './api.js';
import { t } from './i18n.js';
import { $, formatDate, formatDuration, formatTime, formatWhen, h, icon, initials, toast } from './ui.js';

let ctx = null; // { me(), dial(number, options), onChange() }

const st = {
  filter: prefs.read('inbox.filter', 'all'),
  status: 'open',
  q: '',
  list: [],
  counts: { mine: 0, unassigned: 0, total: 0, unread: 0 },
  current: null,
  messages: [],
  hasMore: false,
  permission: null,
  templates: null,
  templatesEnabled: true,
};

const formatNumber = (digits) => (digits ? `+${digits}` : t('unknownNumber'));
const nameOf = (conversation) => conversation.name || formatNumber(conversation.waId);

let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 250);
}

let readTimer = null;
function scheduleRead() {
  clearTimeout(readTimer);
  readTimer = setTimeout(markRead, 400);
}

// ---------------------------------------------------------------- data

export async function load() {
  const params = new URLSearchParams({ filter: st.filter, status: st.status, q: st.q });
  try {
    const data = await api(`/api/conversations?${params}`);
    st.list = data.conversations;
    st.counts = data.counts;
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
  renderList();
  ctx?.onChange();
}

export async function select(id) {
  try {
    const data = await api(`/api/conversations/${id}`);
    st.current = data.conversation;
    st.messages = data.messages;
    st.hasMore = data.hasMore;
    st.permission = null;
  } catch (error) {
    return toast(errorText(error), { tone: 'error' });
  }
  renderList();
  renderThread({ scroll: 'bottom' });
  if (st.current.unread > 0) markRead({ force: true });
  loadPermission();
}

export async function openByPeer(waId, { requestPermission = false } = {}) {
  if (!waId) return;
  try {
    const { conversation } = await api('/api/conversations', { to: waId });
    if (st.current?.id !== conversation.id) await select(conversation.id);
    if (requestPermission) openPermissionDialog();
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

async function loadOlder() {
  if (!st.current || !st.messages.length) return;
  const body = $('#thread-body');
  const before = body.scrollHeight;
  const data = await api(`/api/conversations/${st.current.id}/messages?before=${st.messages[0].id}`);
  st.messages = [...data.messages, ...st.messages];
  st.hasMore = data.hasMore;
  renderMessages();
  body.scrollTop = body.scrollHeight - before;
}

// Opening a conversation marks it read; messages arriving later only count
// as read while the page is actually visible.
async function markRead({ force = false } = {}) {
  if (!st.current || (!force && document.hidden)) return;
  try {
    await api(`/api/conversations/${st.current.id}/read`, {});
  } catch {
    // Not important enough to bother the operator.
  }
}

async function loadPermission() {
  const conversation = st.current;
  if (!conversation) return;
  try {
    const permission = await api(`/api/conversations/${conversation.id}/permission`);
    if (st.current?.id === conversation.id) st.permission = permission;
  } catch {
    if (st.current?.id === conversation.id) st.permission = { status: 'unknown' };
  }
  renderHeader();
}

async function loadTemplates(refresh = false) {
  if (st.templates && !refresh) return st.templates;
  const data = await api(`/api/templates${refresh ? '?refresh=1' : ''}`);
  st.templatesEnabled = data.enabled;
  st.templates = data.templates;
  if (data.error) toast(data.error, { tone: 'error' });
  return st.templates;
}

// ---------------------------------------------------------------- actions

async function sendText(textarea) {
  const text = textarea.value.trim();
  if (!text || !st.current) return;
  textarea.disabled = true;
  try {
    const { message } = await api(`/api/conversations/${st.current.id}/messages`, { text });
    textarea.value = '';
    autoGrow(textarea);
    addMessage(message);
  } catch (error) {
    toast(t('sendFailed', { error: errorText(error) }), { tone: 'error' });
  } finally {
    textarea.disabled = false;
    textarea.focus();
  }
}

async function assign(agent) {
  try {
    const { conversation } = await api(`/api/conversations/${st.current.id}/assign`, { agent: agent || null });
    st.current = conversation;
    renderHeader();
    scheduleReload();
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

async function deleteConversation() {
  if (!st.current || !confirm(t('deleteConversationConfirm', { name: nameOf(st.current) }))) return;
  try {
    await api(`/api/conversations/${st.current.id}`, undefined, 'DELETE');
    close();
    scheduleReload();
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

async function setStatus(status) {
  try {
    const { conversation } = await api(`/api/conversations/${st.current.id}/status`, { status });
    st.current = conversation;
    renderHeader();
    scheduleReload();
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
}

function addMessage(message) {
  if (!st.current || message.conversationId !== st.current.id) return;
  if (st.messages.some((item) => item.id === message.id)) return;
  const body = $('#thread-body');
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
  st.messages.push(message);
  renderMessages();
  if (nearBottom || message.direction === 'out') body.scrollTop = body.scrollHeight;
}

// ---------------------------------------------------------------- dialogs

function dialog(id) {
  const el = $(id);
  el.querySelector('.js-dialog-close')?.addEventListener('click', () => el.close(), { once: true });
  return el;
}

function openNewConversation() {
  const el = dialog('#new-conversation-dialog');
  const input = el.querySelector('input');
  input.value = '';
  el.showModal();
  input.focus();
}

function templateCard(template, selected, onSelect) {
  return h(
    'label',
    { class: `choice ${template.supported ? '' : 'disabled'} ${selected ? 'selected' : ''}` },
    h('input', {
      type: 'radio',
      name: 'template',
      disabled: !template.supported,
      checked: selected,
      onchange: () => onSelect(template),
    }),
    h(
      'span',
      { class: 'choice-body' },
      h(
        'span',
        { class: 'choice-title' },
        h('strong', { text: template.name }),
        h('span', { class: 'chip', text: template.language }),
        template.callPermission && h('span', { class: 'chip accent' }, icon('phone', 12), t('kinds.call_permission_request')),
      ),
      h('span', { class: 'choice-text', text: template.supported ? template.body : t('templateUnsupported') }),
    ),
  );
}

async function openTemplateDialog({ permissionOnly = false } = {}) {
  const el = dialog('#template-dialog');
  const list = el.querySelector('.js-template-list');
  const fields = el.querySelector('.js-template-fields');
  const preview = el.querySelector('.js-template-preview');
  const sendButton = el.querySelector('.js-template-send');
  const note = el.querySelector('.js-template-note');
  let chosen = null;
  let inputs = { header: [], body: [] };

  el.querySelector('.js-template-title').textContent = permissionOnly ? t('requestPermissionTitle') : t('templates');
  note.textContent = permissionOnly ? t('requestPermissionTemplate') : t('templateHint');
  list.replaceChildren(h('p', { class: 'empty', text: '…' }));
  fields.replaceChildren();
  preview.hidden = true;
  sendButton.disabled = true;
  el.showModal();

  let templates;
  try {
    templates = await loadTemplates();
  } catch (error) {
    list.replaceChildren(h('p', { class: 'form-error', text: errorText(error) }));
    return;
  }
  if (!st.templatesEnabled) return list.replaceChildren(h('p', { class: 'empty', text: t('templatesOff') }));
  const shown = permissionOnly ? templates.filter((tpl) => tpl.callPermission) : templates;
  if (!shown.length) {
    return list.replaceChildren(h('p', { class: 'empty', text: permissionOnly ? t('noPermissionTemplates') : t('noTemplates') }));
  }

  const updatePreview = () => {
    if (!chosen) return;
    const fill = (text, names, values) =>
      names.reduce((out, name, i) => out.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g'), values[i] || `{{${name}}}`), text ?? '');
    const header = fill(chosen.header, chosen.headerParams, inputs.header.map((input) => input.value));
    const body = fill(chosen.body, chosen.bodyParams, inputs.body.map((input) => input.value));
    preview.replaceChildren(
      h('span', { class: 'preview-label', text: t('preview') }),
      h('div', { class: 'bubble out' }, header && h('strong', { text: header }), h('span', { text: body }), chosen.footer && h('small', { text: chosen.footer })),
    );
    preview.hidden = false;
    sendButton.disabled = [...inputs.header, ...inputs.body].some((input) => !input.value.trim());
  };

  const choose = (template) => {
    chosen = template;
    let n = 0;
    const make = (name) => {
      n += 1;
      return h('input', { placeholder: /^\d+$/.test(name) ? t('templateField', { n }) : name, oninput: updatePreview });
    };
    inputs = { header: template.headerParams.map(make), body: template.bodyParams.map(make) };
    fields.replaceChildren(...inputs.header, ...inputs.body);
    for (const card of list.querySelectorAll('.choice')) card.classList.toggle('selected', card.querySelector('input').checked);
    updatePreview();
    inputs.header[0]?.focus() ?? inputs.body[0]?.focus();
  };

  list.replaceChildren(...shown.map((template) => templateCard(template, false, choose)));
  const firstUsable = shown.find((template) => template.supported);
  if (shown.length === 1 && firstUsable) {
    list.querySelector('input:not([disabled])').checked = true;
    choose(firstUsable);
  }

  sendButton.onclick = async (event) => {
    event.preventDefault();
    if (!chosen) return;
    const payload = {
      name: chosen.name,
      language: chosen.language,
      params: { header: inputs.header.map((input) => input.value), body: inputs.body.map((input) => input.value) },
    };
    sendButton.disabled = true;
    try {
      const path = permissionOnly ? 'permission-request' : 'template';
      const { message } = await api(`/api/conversations/${st.current.id}/${path}`, permissionOnly ? { template: payload } : payload);
      addMessage(message);
      el.close();
      if (permissionOnly) toast(t('requestSent'));
    } catch (error) {
      toast(t('sendFailed', { error: errorText(error) }), { tone: 'error' });
      sendButton.disabled = false;
    }
  };
}

function openPermissionDialog() {
  if (!st.current) return;
  if (!st.current.windowOpen) return openTemplateDialog({ permissionOnly: true });
  const el = dialog('#permission-dialog');
  const textarea = el.querySelector('textarea');
  textarea.value = ctx.me().permissionRequestText || t('defaultPermissionText');
  const button = el.querySelector('.js-permission-send');
  button.disabled = false;
  button.onclick = async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      const { message } = await api(`/api/conversations/${st.current.id}/permission-request`, { text: textarea.value });
      addMessage(message);
      el.close();
      toast(t('requestSent'));
      loadPermission();
    } catch (error) {
      toast(t('sendFailed', { error: errorText(error) }), { tone: 'error' });
      button.disabled = false;
    }
  };
  el.showModal();
}

// ---------------------------------------------------------------- rendering: list

function previewText(conversation) {
  if (!conversation.lastKind) return '';
  if (conversation.lastKind === 'text' || conversation.lastKind === 'reply') return conversation.lastPreview ?? '';
  const label = t(`kinds.${conversation.lastKind}`);
  return conversation.lastPreview && conversation.lastKind !== 'call' ? `${label}: ${conversation.lastPreview}` : label;
}

function renderList() {
  const list = $('#conversation-list');
  for (const tab of document.querySelectorAll('[data-filter]')) {
    tab.classList.toggle('active', tab.dataset.filter === st.filter);
    const count = { mine: st.counts.mine, unassigned: st.counts.unassigned, all: st.counts.total }[tab.dataset.filter];
    tab.querySelector('.count').textContent = count || '';
  }
  for (const button of document.querySelectorAll('[data-status]')) {
    button.classList.toggle('active', button.dataset.status === st.status);
  }
  $('#conversation-empty').hidden = st.list.length > 0;
  list.replaceChildren(
    ...st.list.map((conversation) =>
      h(
        'li',
        {},
        h(
          'button',
          {
            class: `conversation ${st.current?.id === conversation.id ? 'active' : ''} ${conversation.unread ? 'unread' : ''}`,
            type: 'button',
            onclick: () => select(conversation.id),
          },
          h('span', { class: 'tile small', text: initials(nameOf(conversation)) }),
          h(
            'span',
            { class: 'who' },
            h('span', { class: 'line' }, h('span', { class: 'name', text: nameOf(conversation) }), h('span', { class: 'when', text: conversation.lastMessageAt ? formatWhen(conversation.lastMessageAt) : '' })),
            h(
              'span',
              { class: 'line' },
              h('span', { class: 'sub', text: `${conversation.lastDirection === 'out' ? `${t('you')}: ` : ''}${previewText(conversation)}` }),
              conversation.unread > 0 && h('span', { class: 'badge', text: conversation.unread > 99 ? '99+' : conversation.unread }),
            ),
            conversation.assignee && h('span', { class: 'assignee' }, icon('user', 11), conversation.assignee),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- rendering: thread

function remaining(endsAt) {
  const minutes = Math.max(0, Math.round((endsAt - Date.now()) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h` : `${minutes} min`;
}

function permissionChip() {
  const permission = st.permission;
  if (!permission) return h('span', { class: 'chip muted' }, icon('phone', 12), '…');
  if (permission.status === 'permanent') return h('span', { class: 'chip ok' }, icon('phone', 12), t('permissionPermanent'));
  if (permission.status === 'temporary') {
    const date = permission.expiresAt ? formatDate(permission.expiresAt * 1000) : '';
    return h('span', { class: 'chip ok' }, icon('phone', 12), t('permissionTemporary', { date }));
  }
  if (permission.status === 'unknown') return h('span', { class: 'chip muted' }, icon('phone', 12), t('permissionUnknown'));
  return h('span', { class: 'chip warn' }, icon('phone', 12), t('permissionNone'));
}

function renderHeader() {
  const head = $('#thread-head');
  const conversation = st.current;
  if (!conversation) return head.replaceChildren();
  const me = ctx.me();
  const canCall = st.permission && ['permanent', 'temporary'].includes(st.permission.status);
  const needsPermission = st.permission && !canCall && st.permission.status !== 'unknown';
  const select = h(
    'select',
    { class: 'compact', 'aria-label': t('assignTo'), onchange: (event) => assign(event.target.value) },
    h('option', { value: '' }, t('unassigned')),
    ...me.agents.map((agent) => h('option', { value: agent }, agent)),
  );
  select.value = conversation.assignee ?? '';

  head.replaceChildren(
    h(
      'div',
      { class: 'thread-title' },
      h('button', { class: 'icon-btn small back-btn', type: 'button', title: t('back'), onclick: () => close() }, icon('arrowLeft', 16)),
      h('span', { class: 'tile', text: initials(nameOf(conversation)) }),
      h('div', { class: 'who' }, h('div', { class: 'name', text: nameOf(conversation) }), h('div', { class: 'sub', text: formatNumber(conversation.waId) })),
      h('span', { class: 'grow' }),
      h(
        'button',
        { class: 'btn small primary', type: 'button', onclick: () => ctx.dial(conversation.waId, { name: conversation.name }) },
        icon('phone', 15),
        h('span', { class: 'btn-label', text: t('call') }),
      ),
      conversation.status === 'open'
        ? h('button', { class: 'btn small', type: 'button', onclick: () => setStatus('resolved') }, icon('check', 15), h('span', { class: 'btn-label', text: t('resolve') }))
        : h('button', { class: 'btn small', type: 'button', onclick: () => setStatus('open') }, icon('refresh', 15), h('span', { class: 'btn-label', text: t('reopen') })),
      me.role === 'admin' &&
        h('button', { class: 'icon-btn small', type: 'button', title: t('deleteConversation'), 'aria-label': t('deleteConversation'), onclick: deleteConversation }, icon('trash', 15)),
    ),
    h(
      'div',
      { class: 'thread-meta' },
      conversation.windowOpen
        ? h('span', { class: 'chip ok' }, icon('msg', 12), t('windowOpen', { time: remaining(conversation.windowEndsAt) }))
        : h('span', { class: 'chip muted' }, icon('msg', 12), t('windowClosed')),
      permissionChip(),
      needsPermission &&
        h(
          'button',
          {
            class: 'link-btn',
            type: 'button',
            disabled: st.permission.canRequest === false,
            title: st.permission.canRequest === false ? t('requestLimit') : null,
            onclick: openPermissionDialog,
          },
          t('requestPermission'),
        ),
      h('span', { class: 'grow' }),
      h('label', { class: 'inline-field' }, icon('user', 13), select),
      !conversation.assignee &&
        h('button', { class: 'link-btn', type: 'button', onclick: () => assign(me.user) }, t('takeIt')),
    ),
  );
}

function statusIcon(message) {
  const map = { pending: 'clock', sent: 'check', delivered: 'checkCheck', read: 'checkCheck', failed: 'alert' };
  const name = map[message.status];
  if (!name) return null;
  return h(
    'span',
    { class: `status ${message.status}`, title: message.error || t(`statusLabels.${message.status}`) },
    icon(name, 13),
  );
}

function mediaBlock(message) {
  const src = `/api/media/${encodeURIComponent(message.mediaId)}`;
  switch (message.kind) {
    case 'image':
    case 'sticker':
      return h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { class: `media ${message.kind}`, src, alt: message.body || t(`kinds.${message.kind}`), loading: 'lazy' }));
    case 'audio':
      return h('audio', { class: 'media', controls: true, preload: 'none', src });
    case 'video':
      return h('video', { class: 'media', controls: true, preload: 'none', src });
    default:
      return h('a', { class: 'file', href: src, download: message.filename || 'file' }, icon('file', 16), message.filename || t('download'));
  }
}

function systemLine(message) {
  if (message.kind === 'call') {
    const data = message.data ?? {};
    const missed = ['missed', 'failed'].includes(data.outcome);
    const parts = [t(message.direction === 'in' ? 'callIn' : 'callOut'), t(`outcomes.${data.outcome}`)];
    if (data.duration) parts.push(formatDuration(data.duration));
    if (message.agent) parts.push(message.agent);
    parts.push(formatTime(message.createdAt));
    return h(
      'div',
      { class: `msg-system ${missed ? 'bad' : ''}` },
      icon(missed ? 'phoneMissed' : message.direction === 'in' ? 'phoneIncoming' : 'phoneOutgoing', 14),
      parts.join(' · '),
    );
  }
  const data = message.data ?? {};
  const accepted = data.response === 'accept';
  const label = accepted
    ? data.expiresAt
      ? t('permissionReplyAcceptUntil', { date: formatDate(data.expiresAt * 1000) })
      : t('permissionReplyAccept')
    : t('permissionReplyReject');
  return h('div', { class: `msg-system ${accepted ? 'ok' : 'bad'}` }, icon(accepted ? 'check' : 'x', 14), `${label} · ${formatTime(message.createdAt)}`);
}

function bubble(message) {
  if (message.kind === 'call' || message.kind === 'call_permission_reply') return systemLine(message);
  const out = message.direction === 'out';
  const parts = [];
  if (message.kind === 'template') parts.push(h('span', { class: 'chip small', text: t('templateLabel', { name: message.data?.template ?? '' }) }));
  if (message.kind === 'call_permission_request') parts.push(h('span', { class: 'chip small accent' }, icon('phone', 11), t('kinds.call_permission_request')));
  if (message.kind === 'reply') parts.push(h('span', { class: 'chip small', text: t('kinds.reply') }));
  if (message.mediaId) parts.push(mediaBlock(message));
  if (message.kind === 'location' && message.data?.latitude != null) {
    const { latitude, longitude } = message.data;
    parts.push(
      h('a', { class: 'file', href: `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`, target: '_blank', rel: 'noopener noreferrer' }, icon('mapPin', 16), t('openMap')),
    );
  }
  if (message.kind === 'unsupported') parts.push(h('em', { class: 'muted', text: t('kinds.unsupported') }));
  if (message.body) parts.push(h('span', { class: 'text', text: message.body }));

  const meta = [h('span', { text: formatTime(message.createdAt) })];
  if (out && message.agent) meta.push(h('span', { text: message.agent }));
  if (out) meta.push(statusIcon(message));

  return h(
    'div',
    { class: `msg ${out ? 'out' : 'in'} ${message.status === 'failed' ? 'failed' : ''}`, 'data-id': message.id },
    h('div', { class: 'bubble' }, ...parts, message.reaction && h('span', { class: 'reaction', text: message.reaction })),
    h('div', { class: 'meta' }, ...meta),
    message.status === 'failed' && message.error && h('div', { class: 'error-line', text: message.error }),
  );
}

function dayLabel(ms) {
  const date = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return t('today');
  if (date.toDateString() === yesterday.toDateString()) return t('yesterday');
  return formatDate(ms);
}

function renderMessages() {
  const body = $('#thread-body');
  const items = [];
  if (st.hasMore) items.push(h('button', { class: 'link-btn load-older', type: 'button', onclick: loadOlder }, t('loadOlder')));
  let lastDay = '';
  for (const message of st.messages) {
    const day = new Date(message.createdAt).toDateString();
    if (day !== lastDay) {
      items.push(h('div', { class: 'day', text: dayLabel(message.createdAt) }));
      lastDay = day;
    }
    items.push(bubble(message));
  }
  body.replaceChildren(...items);
}

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
}

function renderComposer() {
  const composer = $('#composer');
  const conversation = st.current;
  if (!conversation) return composer.replaceChildren();
  if (!conversation.windowOpen) {
    composer.replaceChildren(
      h(
        'div',
        { class: 'note' },
        h('p', { text: t('windowClosedNote') }),
        h('button', { class: 'btn small primary', type: 'button', onclick: () => openTemplateDialog() }, icon('file', 15), t('sendTemplate')),
      ),
    );
    return;
  }
  const textarea = h('textarea', {
    rows: 1,
    placeholder: t('writeMessage'),
    'aria-label': t('writeMessage'),
    oninput: (event) => autoGrow(event.target),
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendText(textarea);
      }
    },
  });
  composer.replaceChildren(
    h(
      'div',
      { class: 'composer-box' },
      h('button', { class: 'ghost-btn', type: 'button', title: t('templates'), onclick: () => openTemplateDialog() }, icon('file', 17)),
      textarea,
      h('button', { class: 'send-btn', type: 'button', title: t('send'), onclick: () => sendText(textarea) }, icon('send', 16)),
    ),
  );
}

function renderThread({ scroll } = {}) {
  const has = Boolean(st.current);
  $('#thread-empty').hidden = has;
  $('#thread').hidden = !has;
  $('#workspace').classList.toggle('show-thread', has);
  if (!has) return;
  renderHeader();
  renderMessages();
  renderComposer();
  if (scroll === 'bottom') {
    const body = $('#thread-body');
    body.scrollTop = body.scrollHeight;
  }
}

function close() {
  st.current = null;
  st.messages = [];
  renderList();
  renderThread();
}

// ---------------------------------------------------------------- events

export function onEvent(name, data) {
  switch (name) {
    case 'conversation.updated':
      if (st.current?.id === data.id) {
        const windowChanged = st.current.windowOpen !== data.windowOpen;
        st.current = data;
        renderHeader();
        if (windowChanged) renderComposer();
      }
      scheduleReload();
      break;
    case 'message.created':
      if (st.current?.id === data.conversationId) {
        addMessage(data.message);
        if (data.message.direction === 'in') scheduleRead();
      }
      break;
    case 'message.updated':
      if (st.current?.id === data.conversationId) {
        st.messages = st.messages.map((message) => (message.id === data.message.id ? data.message : message));
        const existing = $(`#thread-body [data-id="${data.message.id}"]`);
        if (existing) existing.replaceWith(bubble(data.message));
      }
      break;
    case 'permission.reply':
      if (st.current?.waId === data.peer) loadPermission();
      break;
    case 'conversation.deleted':
      if (st.current?.id === data.id) close();
      scheduleReload();
      break;
  }
}

export const unreadTotal = () => st.counts.unread ?? 0;

export function init(context) {
  ctx = context;
  const search = $('#conversation-search');
  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      st.q = search.value;
      load();
    }, 250);
  });
  for (const tab of document.querySelectorAll('[data-filter]')) {
    tab.addEventListener('click', () => {
      st.filter = tab.dataset.filter;
      prefs.write('inbox.filter', st.filter);
      load();
    });
  }
  for (const button of document.querySelectorAll('[data-status]')) {
    button.addEventListener('click', () => {
      st.status = button.dataset.status;
      load();
    });
  }
  $('#new-conversation-btn').addEventListener('click', openNewConversation);
  $('#new-conversation-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = event.target.querySelector('input');
    $('#new-conversation-dialog').close();
    await openByPeer(input.value);
    scheduleReload();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && st.current?.unread) markRead();
  });
  // Refresh the "time left" of the chat window now and then.
  setInterval(() => st.current && renderHeader(), 60_000);
  load();
}

export function refreshLabels() {
  renderList();
  if (st.current) renderThread();
}
