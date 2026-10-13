// Message log for administrators: what went in and out each month, how much of
// the free service messages is used, what Meta reports as billable, who sent
// what, and the detail of the month (no message text) with a CSV download.

import { api, errorText } from './api.js';
import { currentLanguage, t } from './i18n.js';
import { $, formatCount, formatDate, formatDuration, formatTime, h, icon, nodes, toast } from './ui.js';

let ctx = null; // { openConversation(id) }

const st = { months: [], month: null, filter: 'all', entries: [], hasMore: false };

const FILTERS = ['all', 'received', 'sent', 'calls'];

function monthLabel(month) {
  const [year, index] = month.split('-').map(Number);
  const label = new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString(document.documentElement.lang || undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const summary = () => st.months.find((item) => item.month === st.month);

// ---------------------------------------------------------------- data

export async function open() {
  const dialog = $('#usage-dialog');
  $('#usage-body').replaceChildren(h('p', { class: 'empty', text: '…' }));
  if (!dialog.open) dialog.showModal();
  try {
    st.months = (await api('/api/usage?months=12')).months;
  } catch (error) {
    $('#usage-body').replaceChildren(h('p', { class: 'form-error', text: errorText(error) }));
    return;
  }
  if (!st.months.some((item) => item.month === st.month)) st.month = st.months[0].month;
  renderMonths();
  await selectMonth(st.month);
}

async function selectMonth(month) {
  st.month = month;
  $('#usage-export').href = `/api/usage/export?month=${month}&lang=${currentLanguage()}`;
  render();
  await loadEntries();
}

async function loadEntries({ more = false } = {}) {
  const params = new URLSearchParams({ month: st.month });
  if (st.filter !== 'all') params.set('filter', st.filter);
  if (more && st.entries.length) params.set('before', st.entries.at(-1).id);
  try {
    const data = await api(`/api/usage/messages?${params}`);
    st.entries = more ? [...st.entries, ...data.messages] : data.messages;
    st.hasMore = data.hasMore;
  } catch (error) {
    toast(errorText(error), { tone: 'error' });
  }
  renderDetail();
}

// ---------------------------------------------------------------- rendering

function renderMonths() {
  const select = $('#usage-month');
  select.replaceChildren(...st.months.map((item) => h('option', { value: item.month }, monthLabel(item.month))));
  select.value = st.month;
}

function card(title, value, note, extra = null, tone = '') {
  return h(
    'div',
    { class: `usage-card ${tone}` },
    h('span', { class: 'usage-card-title', text: title }),
    h('strong', { class: 'usage-card-value', text: formatCount(value) }),
    extra,
    note && h('span', { class: 'usage-card-note', text: note }),
  );
}

function serviceCard(month) {
  const { delivered, free, overFree } = month.service;
  const used = Math.min(100, Math.round((delivered / free) * 100));
  const fill = h('span');
  fill.style.width = `${used}%`; // CSSOM, not a style attribute: the CSP blocks those
  const bar = h('span', { class: `usage-bar ${overFree ? 'over' : ''}`, role: 'img', 'aria-label': `${used}%` }, fill);
  const note = overFree
    ? t('usageServiceOver', { over: formatCount(overFree), free: formatCount(free) })
    : t('usageServiceNote', { used: formatCount(delivered), free: formatCount(free) });
  return card(t('usageService'), delivered, note, bar, overFree ? 'warn' : '');
}

function render() {
  const month = summary();
  if (!month) return;
  const templates = month.delivered.total - month.delivered.service;
  const cards = h(
    'div',
    { class: 'usage-cards' },
    card(t('usageReceived'), month.received, t('usageReceivedNote')),
    serviceCard(month),
    card(
      t('usageTemplates'),
      templates,
      t('usageTemplatesNote', {
        marketing: formatCount(month.delivered.marketing),
        utility: formatCount(month.delivered.utility),
        authentication: formatCount(month.delivered.authentication),
      }),
    ),
    card(t('usageBillable'), month.billable, t('usageBillableNote')),
    card(
      t('usageCalls'),
      month.calls.in + month.calls.out,
      t('usageCallsNote', {
        in: formatCount(month.calls.in),
        out: formatCount(month.calls.out),
        minutes: formatCount(Math.ceil(month.calls.outSeconds / 60)),
      }),
    ),
  );

  const failed = month.failed > 0 && h('p', { class: 'chip warn usage-failed' }, icon('alert', 12), t('usageFailed', { n: formatCount(month.failed) }));

  const agents =
    month.agents.length > 0 &&
    h(
      'section',
      { class: 'usage-section' },
      h('h3', { text: t('usageAgents') }),
      h(
        'table',
        { class: 'usage-table' },
        h('thead', {}, h('tr', {}, h('th', { text: t('usageAgent') }), h('th', { text: t('usageAgentMessages') }), h('th', { text: t('usageAgentCalls') }))),
        h(
          'tbody',
          {},
          ...month.agents.map((agent) =>
            h('tr', {}, h('td', { text: agent.agent }), h('td', { text: formatCount(agent.messages) }), h('td', { text: formatCount(agent.calls) })),
          ),
        ),
      ),
    );

  const tabs = h(
    'div',
    { class: 'tabs usage-tabs', role: 'tablist' },
    ...FILTERS.map((filter) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: st.filter === filter ? 'active' : null,
          'aria-selected': String(st.filter === filter),
          onclick: () => {
            st.filter = filter;
            render();
            loadEntries();
          },
        },
        t(`usageFilters.${filter}`),
      ),
    ),
  );

  $('#usage-body').replaceChildren(
    ...nodes([
      cards,
      failed,
      agents,
      h('section', { class: 'usage-section' }, h('h3', { text: t('usageDetail') }), tabs, h('ul', { id: 'usage-entries', class: 'usage-entries' })),
    ]),
  );
  renderDetail();
}

function describe(entry) {
  if (entry.kind === 'call') {
    const parts = [t(entry.direction === 'in' ? 'callIn' : 'callOut')];
    if (entry.outcome) parts.push(t(`outcomes.${entry.outcome}`));
    if (entry.duration) parts.push(formatDuration(entry.duration));
    return parts.join(' · ');
  }
  if (entry.template) return t('templateLabel', { name: entry.template });
  return t(`kinds.${entry.kind}`);
}

function entryRow(entry) {
  const out = entry.direction === 'out';
  const name = entry.name || `+${entry.waId}`;
  const meta = [`${formatDate(entry.createdAt)} ${formatTime(entry.createdAt)}`];
  if (out && entry.kind !== 'call' && entry.status) meta.push(t(`statusLabels.${entry.status}`));
  if (entry.agent) meta.push(entry.agent);
  const iconName = entry.kind === 'call' ? (out ? 'phoneOutgoing' : 'phoneIncoming') : out ? 'send' : 'msg';
  return h(
    'li',
    {},
    h(
      'button',
      {
        type: 'button',
        class: 'usage-entry',
        title: t(`directions.${entry.direction}`),
        onclick: () => {
          $('#usage-dialog').close();
          ctx?.openConversation(entry.conversationId);
        },
      },
      h('span', { class: `usage-entry-icon ${out ? 'out' : 'in'}` }, icon(iconName, 14)),
      h(
        'span',
        { class: 'usage-entry-main' },
        h('span', { class: 'usage-entry-title' }, h('strong', { text: name }), h('span', { class: 'muted', text: describe(entry) })),
        h('span', { class: 'usage-entry-meta muted', text: meta.join(' · ') }),
      ),
      out && entry.category && entry.kind !== 'call' && h('span', { class: 'chip small', text: t(`categories.${entry.category}`) }),
      entry.billable && h('span', { class: 'chip small warn', text: t('usageBillableShort') }),
    ),
  );
}

function renderDetail() {
  const list = $('#usage-entries');
  if (!list) return;
  const rows = st.entries.map(entryRow);
  if (!rows.length) rows.push(h('li', { class: 'empty', text: t('usageEmpty') }));
  if (st.hasMore) {
    rows.push(h('li', {}, h('button', { class: 'link-btn', type: 'button', onclick: () => loadEntries({ more: true }) }, t('usageLoadMore'))));
  }
  list.replaceChildren(...rows);
}

// ---------------------------------------------------------------- setup

export function init(context) {
  ctx = context;
  $('#usage-month').addEventListener('change', (event) => selectMonth(event.target.value));
  $('#usage-dialog .js-usage-close').addEventListener('click', () => $('#usage-dialog').close());
}

export function relabel() {
  if (!$('#usage-dialog').open || !st.month) return;
  renderMonths();
  $('#usage-export').href = `/api/usage/export?month=${st.month}&lang=${currentLanguage()}`;
  render();
}
