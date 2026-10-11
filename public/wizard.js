// Guided setup: administrator account, Meta app, webhook, calling and team.
// Every Meta value is checked live before it is saved.

import { api, errorText } from './api.js';
import { currentLanguage, t } from './i18n.js';
import { $, formatDate, h, icon, initials, toast } from './ui.js';

const STEPS = ['account', 'meta', 'webhook', 'calling', 'team', 'done'];
const STEP_LABEL = {
  account: 'stepAccount',
  meta: 'stepMeta',
  webhook: 'stepWebhook',
  calling: 'stepCalling',
  team: 'stepTeam',
  done: 'stepDone',
};
const ENGLISH_DEFAULT_PERMISSION = 'We would like to call you on WhatsApp about your request. Is that OK?';

const ws = {
  step: 'meta',
  needsAccount: false,
  status: null,
  user: null,
  draft: null,
  verify: null,
  selected: null,
  webhook: null,
  webhookResults: null,
  calling: null,
  users: null,
  visited: new Set(),
  poll: null,
  onSignedIn: null,
};

// ---------------------------------------------------------------- helpers

function stateIcon(state) {
  const name = { ok: 'check', warn: 'alert', fail: 'x', unknown: 'info', wait: 'clock' }[state] ?? 'info';
  return h('span', { class: `state-dot ${state}` }, icon(name, 13, 2.4));
}

function checkRow(state, label, detail = null) {
  return h('li', { class: `check ${state}` }, stateIcon(state), h('span', { class: 'check-label', text: label }), detail && h('span', { class: 'check-detail', text: detail }));
}

function field(key, { label, type = 'text', placeholder = '', autocomplete = 'off' } = {}) {
  const info = ws.status?.fields?.[key] ?? {};
  const secret = type === 'password';
  const input = h('input', { name: key, type, autocomplete, spellcheck: 'false' });
  if (info.locked) {
    input.value = info.value;
    input.disabled = true;
  } else if (ws.draft?.[key]) {
    input.value = ws.draft[key]; // typed but not saved yet: survives a re-render
  } else if (secret && info.set) {
    input.placeholder = t('savedValue', { value: info.value });
  } else {
    input.value = info.value ?? '';
    input.placeholder = placeholder;
  }
  return h(
    'label',
    {},
    h('span', { text: label }),
    input,
    info.locked && h('small', { class: 'hint-left', text: t('lockedBy', { variable: info.variable }) }),
  );
}

function copyButton(getText) {
  return h(
    'button',
    {
      class: 'icon-btn small',
      type: 'button',
      title: t('copy'),
      onclick: async (event) => {
        try {
          await navigator.clipboard.writeText(getText());
          event.currentTarget.title = t('copied');
          toast(t('copied'));
        } catch {
          // Clipboard blocked: the value is visible and selectable anyway.
        }
      },
    },
    icon('copy', 15),
  );
}

const values = (form) => Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, String(v).trim()]));

function stepDone(step) {
  const status = ws.status;
  switch (step) {
    case 'account':
      return !ws.needsAccount;
    case 'meta':
      return Boolean(status) && !['phoneNumberId', 'accessToken', 'appSecret'].some((key) => status.missing?.includes(key));
    case 'webhook':
      return Boolean(status?.webhook?.verifiedAt || ws.webhook?.verifiedAt);
    case 'calling':
      return ws.visited.has('calling-saved');
    case 'team':
      return (ws.users?.length ?? 0) > 1 || ws.visited.has('team');
    default:
      return Boolean(status?.ready);
  }
}

async function refreshStatus() {
  ws.status = await api('/api/setup');
}

function go(step) {
  clearInterval(ws.poll);
  ws.poll = null;
  ws.visited.add(ws.step);
  ws.step = step;
  render();
}

const next = () => go(STEPS[STEPS.indexOf(ws.step) + 1] ?? 'done');

// ---------------------------------------------------------------- steps

function accountStep() {
  const error = h('p', { class: 'form-error', hidden: true });
  const form = h(
    'form',
    {
      class: 'wizard-form',
      onsubmit: async (event) => {
        event.preventDefault();
        const data = values(event.target);
        error.hidden = true;
        const fail = (text) => {
          error.textContent = text;
          error.hidden = false;
        };
        if (data.password.length < 8) return fail(t('passwordShort'));
        if (data.password !== data.confirm) return fail(t('passwordsDiffer'));
        try {
          const me = await api('/api/setup/account', { code: data.code, username: data.username, password: data.password });
          ws.needsAccount = false;
          ws.user = me.user;
          await refreshStatus();
          ws.onSignedIn?.(me);
          go('meta');
        } catch (err) {
          fail(errorText(err));
        }
      },
    },
    h('label', {}, h('span', { text: t('setupCode') }), h('input', { name: 'code', required: true, autocomplete: 'off', class: 'code-input', placeholder: 'XXXX-XXXX' })),
    h('p', { class: 'hint-left' }, icon('info', 13), h('code', { text: t('accountCodeHelp') })),
    h('label', {}, h('span', { text: t('username') }), h('input', { name: 'username', required: true, autocomplete: 'username' })),
    h('label', {}, h('span', { text: t('password') }), h('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password' })),
    h('label', {}, h('span', { text: t('confirmPassword') }), h('input', { name: 'confirm', type: 'password', required: true, autocomplete: 'new-password' })),
    error,
    h('div', { class: 'wizard-actions' }, h('button', { class: 'btn primary', type: 'submit' }, t('continue'))),
  );
  return [h('h2', { text: t('accountTitle') }), h('p', { class: 'lead', text: t('accountText') }), form];
}

function tokenReport(report) {
  const token = report.token ?? {};
  const rows = [];
  if (token.appSecretRejected) rows.push(checkRow('fail', t('appRejected'), token.error));
  else if (token.needsApp) rows.push(checkRow('unknown', t('needsAppForCheck')));
  else {
    rows.push(checkRow(token.valid ? 'ok' : 'fail', token.valid ? t('tokenValid') : t('tokenInvalid'), token.error));
    if (token.valid) {
      rows.push(checkRow(token.type === 'SYSTEM_USER' ? 'ok' : 'warn', token.type === 'SYSTEM_USER' ? t('tokenSystemUser') : t('tokenUserType')));
      rows.push(
        token.expiresAt
          ? checkRow('warn', t('tokenExpires', { date: formatDate(token.expiresAt) }))
          : checkRow('ok', t('tokenNeverExpires')),
      );
      rows.push(
        token.missingScopes?.length
          ? checkRow('fail', t('tokenScopesMissing', { scopes: token.missingScopes.join(', ') }))
          : checkRow('ok', t('tokenScopesOk')),
      );
      rows.push(token.appMatches ? checkRow('ok', t('tokenAppMatches')) : checkRow('warn', t('tokenAppOther', { app: token.appName ?? '?' })));
    }
  }
  return h('ul', { class: 'checks' }, rows);
}

function numberPicker(report) {
  const phones = report.wabas.flatMap((waba) => waba.phones.map((phone) => ({ ...phone, wabaId: waba.id, wabaName: waba.name })));
  const current = ws.status?.fields?.phoneNumberId?.value;
  if (!ws.selected) ws.selected = phones.find((phone) => phone.id === current) ?? (phones.length === 1 ? phones[0] : null);
  const errors = report.wabas.filter((waba) => waba.error).map((waba) => h('p', { class: 'form-error', text: `${waba.id}: ${waba.error}` }));
  if (!phones.length) return [h('p', { class: 'empty', text: t('noNumbers') }), ...errors];
  return [
    h('h3', { text: t('pickNumber') }),
    h(
      'div',
      { class: 'choices' },
      phones.map((phone) =>
        h(
          'label',
          { class: `choice ${ws.selected?.id === phone.id ? 'selected' : ''}` },
          h('input', {
            type: 'radio',
            name: 'phone',
            checked: ws.selected?.id === phone.id,
            onchange: (event) => {
              ws.draft = values(event.target.form);
              ws.selected = phone;
              render();
            },
          }),
          h(
            'span',
            { class: 'choice-body' },
            h('span', { class: 'choice-title' }, h('strong', { text: phone.displayNumber ?? phone.id }), phone.verifiedName && h('span', { class: 'muted', text: phone.verifiedName })),
            h(
              'span',
              { class: 'choice-chips' },
              phone.quality && h('span', { class: `chip ${phone.quality === 'GREEN' ? 'ok' : phone.quality === 'RED' ? 'bad' : 'muted'}`, text: t('quality', { value: phone.quality }) }),
              phone.platform && h('span', { class: 'chip muted', text: phone.platform }),
              phone.limitTier && h('span', { class: 'chip muted', text: t('tier', { value: phone.limitTier }) }),
              h('span', { class: 'chip muted', text: phone.wabaName ?? phone.wabaId }),
            ),
          ),
        ),
      ),
    ),
    ...errors,
  ];
}

function metaStep() {
  const results = h('div', { class: 'wizard-results' }, ws.verify ? [tokenReport(ws.verify), ...numberPicker(ws.verify)] : []);
  const verifyButton = h('button', { class: 'btn', type: 'button' }, icon('shield', 15), t('verify'));
  const saveButton = h('button', { class: 'btn primary', type: 'submit' }, t('saveContinue'));
  const manual = h(
    'details',
    { class: 'manual', open: !ws.verify && Boolean(ws.status?.fields?.phoneNumberId?.value) },
    h('summary', { text: t('manualIds') }),
    h('div', { class: 'grid-2' }, field('wabaId', { label: t('wabaId') }), field('phoneNumberId', { label: t('phoneNumberId') })),
  );
  const form = h(
    'form',
    {
      class: 'wizard-form',
      onsubmit: async (event) => {
        event.preventDefault();
        const data = values(event.target);
        if (ws.selected) {
          data.wabaId = ws.selected.wabaId;
          data.phoneNumberId = ws.selected.id;
        }
        saveButton.disabled = true;
        try {
          const result = await api('/api/setup/meta', data);
          toast(t('savedNumber', { number: result.phone?.displayNumber ?? data.phoneNumberId }));
          ws.draft = null;
          await refreshStatus();
          next();
        } catch (error) {
          toast(errorText(error), { tone: 'error' });
          saveButton.disabled = false;
        }
      },
    },
    h('div', { class: 'grid-2' }, field('appId', { label: t('appId') }), field('appSecret', { label: t('appSecret'), type: 'password' })),
    field('accessToken', { label: t('accessToken'), type: 'password' }),
    h('div', { class: 'wizard-actions left' }, verifyButton),
    results,
    manual,
    h('div', { class: 'wizard-actions' }, saveButton),
  );
  verifyButton.addEventListener('click', async () => {
    verifyButton.disabled = true;
    verifyButton.lastChild.textContent = t('verifying');
    ws.draft = values(form);
    try {
      ws.verify = await api('/api/setup/meta/verify', ws.draft);
      ws.selected = null;
      render();
    } catch (error) {
      toast(errorText(error), { tone: 'error' });
      verifyButton.disabled = false;
      verifyButton.lastChild.textContent = t('verify');
    }
  });
  return [
    h('h2', { text: t('metaTitle') }),
    h('p', { class: 'lead', text: t('metaText') }),
    h(
      'details',
      { class: 'howto' },
      h('summary', {}, icon('info', 14), t('metaHowTo')),
      h(
        'ol',
        {},
        h('li', {}, t('metaHow1'), ' ', h('a', { href: 'https://developers.facebook.com/apps', target: '_blank', rel: 'noopener noreferrer' }, icon('external', 12))),
        h('li', { text: t('metaHow2') }),
        h('li', {}, t('metaHow3'), ' ', h('a', { href: 'https://business.facebook.com/settings/system-users', target: '_blank', rel: 'noopener noreferrer' }, icon('external', 12))),
      ),
    ),
    form,
  ];
}

function isPublicHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !/^(localhost|127\.|\[::1\]|10\.|192\.168\.)/.test(url.hostname);
  } catch {
    return false;
  }
}

async function pollWebhook() {
  try {
    ws.webhook = await api('/api/setup/webhook');
    const live = $('#webhook-live');
    if (live) live.replaceWith(webhookLive());
  } catch {
    // Keep the last known state.
  }
}

function webhookLive() {
  const status = ws.webhook ?? {};
  const names = status.subscription?.names ?? null;
  const fieldsOk = names && names.includes('messages') && names.includes('calls');
  return h(
    'ul',
    { class: 'checks', id: 'webhook-live' },
    checkRow(status.verifiedAt ? 'ok' : 'wait', t('checkVerified'), status.verifiedAt ? new Date(status.verifiedAt).toLocaleString(document.documentElement.lang || undefined) : t('waiting')),
    checkRow(names === null ? 'unknown' : fieldsOk ? 'ok' : 'warn', t('checkFields'), names?.join(', ') ?? null),
    checkRow(status.lastEventAt ? 'ok' : 'wait', t('checkEvents'), status.lastEventAt ? new Date(status.lastEventAt).toLocaleString(document.documentElement.lang || undefined) : t('checkEventsHint')),
  );
}

function webhookStep() {
  if (!ws.poll) {
    pollWebhook();
    ws.poll = setInterval(pollWebhook, 3000);
  }
  const base = ws.webhook?.publicUrl || ws.status?.fields?.publicUrl?.value || location.origin;
  const input = h('input', { name: 'callbackUrl', value: `${base.replace(/\/+$/, '')}/webhook`, spellcheck: 'false' });
  const warning = h('p', { class: 'form-error', text: t('httpsWarning'), hidden: isPublicHttps(input.value) });
  input.addEventListener('input', () => {
    warning.hidden = isPublicHttps(input.value);
  });
  const token = () => ws.webhook?.verifyToken || '';
  const tokenBox = h('div', { class: 'secret-row' }, h('code', { class: 'js-token', text: token() || '…' }), copyButton(token));
  const results = h(
    'ul',
    { class: 'checks' },
    (ws.webhookResults ?? []).map((result) =>
      checkRow(
        result.ok ? 'ok' : 'fail',
        t(result.step === 'app' ? 'autoApp' : 'autoWaba'),
        result.code ? t(`webhookErrors.${result.code}`) : (result.error ?? null),
      ),
    ),
  );
  const autoButton = h(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const result = await api('/api/setup/webhook', { callbackUrl: input.value, auto: true });
          ws.webhookResults = result.results;
          await pollWebhook();
          render();
        } catch (error) {
          toast(errorText(error), { tone: 'error' });
          button.disabled = false;
        }
      },
    },
    icon('webhook', 15),
    t('autoConfigure'),
  );
  // Make sure a verify token exists before showing the manual steps.
  if (!token()) {
    api('/api/setup/webhook', { callbackUrl: input.value, auto: false })
      .then(() => pollWebhook())
      .then(() => {
        tokenBox.querySelector('.js-token').textContent = token() || '…';
      })
      .catch(() => {});
  }
  return [
    h('h2', { text: t('webhookTitle') }),
    h('p', { class: 'lead', text: t('webhookText') }),
    h('label', {}, h('span', { text: t('callbackUrl') }), h('div', { class: 'secret-row' }, input, copyButton(() => input.value))),
    warning,
    h('label', {}, h('span', { text: t('verifyToken') }), tokenBox),
    h('div', { class: 'wizard-actions left' }, autoButton),
    results,
    h(
      'details',
      { class: 'howto' },
      h('summary', {}, icon('info', 14), t('manualSteps')),
      h('ol', {}, h('li', { text: t('manual1') }), h('li', { text: t('manual2') }), h('li', { text: t('manual3') })),
    ),
    webhookLive(),
    h('div', { class: 'wizard-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: next }, t('continue'))),
  ];
}

function switchRow(name, label, checked) {
  return h(
    'label',
    { class: 'switch-row' },
    h('input', { type: 'checkbox', name, checked, role: 'switch' }),
    h('span', { class: 'switch' }),
    h('span', { text: label }),
  );
}

function callingStep() {
  if (!ws.calling) {
    api('/api/setup/calling')
      .then((report) => {
        ws.calling = report;
        if (ws.step === 'calling') render();
      })
      .catch((error) => toast(errorText(error), { tone: 'error' }));
    return [h('h2', { text: t('callingTitle') }), h('p', { class: 'lead', text: '…' })];
  }
  const report = ws.calling;
  const labels = {
    platform: 'checkPlatform',
    quality: 'checkQuality',
    limit: 'checkLimit',
    sip: 'checkSip',
    calling: 'checkCalling',
    restrictions: 'checkRestrictions',
  };
  const calling = report.calling ?? {};
  let text = ws.status?.fields?.permissionRequestText?.value || '';
  if (!text || (text === ENGLISH_DEFAULT_PERMISSION && currentLanguage() !== 'en')) text = t('defaultPermissionText');
  const saveButton = h('button', { class: 'btn primary', type: 'submit' }, t('saveContinue'));
  return [
    h('h2', { text: t('callingTitle') }),
    h('p', { class: 'lead', text: t('callingText') }),
    report.error && h('p', { class: 'form-error', text: report.error }),
    h('ul', { class: 'checks' }, report.checks.map((check) => checkRow(check.state, t(labels[check.id]), check.value))),
    h('p', { class: 'hint-left' }, icon('info', 13), t('coexistenceNote')),
    h(
      'form',
      {
        class: 'wizard-form',
        onsubmit: async (event) => {
          event.preventDefault();
          const form = event.target;
          saveButton.disabled = true;
          try {
            ws.calling = await api('/api/setup/calling', {
              enabled: form.enabled.checked,
              showIcon: form.showIcon.checked,
              callbackPermission: form.callbackPermission.checked,
              permissionRequestText: form.permissionRequestText.value,
            });
            ws.visited.add('calling-saved');
            await refreshStatus();
            next();
          } catch (error) {
            toast(errorText(error), { tone: 'error' });
            saveButton.disabled = false;
          }
        },
      },
      switchRow('enabled', t('enableCalling'), calling.status !== 'DISABLED'),
      switchRow('showIcon', t('showCallIcon'), calling.call_icon_visibility !== 'DISABLE_ALL'),
      switchRow('callbackPermission', t('callbackPermission'), calling.callback_permission_status !== 'DISABLED'),
      h('label', {}, h('span', { text: t('permissionMessage') }), h('textarea', { name: 'permissionRequestText', rows: 3, maxlength: 1024, text })),
      h('div', { class: 'wizard-actions' }, saveButton),
    ),
  ];
}

function teamStep() {
  if (!ws.users) {
    api('/api/users')
      .then((data) => {
        ws.users = data.users;
        if (ws.step === 'team') render();
      })
      .catch((error) => toast(errorText(error), { tone: 'error' }));
  }
  const me = ws.user;
  const rows = (ws.users ?? []).map((user) => {
    const role = h(
      'select',
      {
        class: 'compact',
        disabled: user.source === 'env',
        onchange: async (event) => {
          try {
            ws.users = (await api(`/api/users/${encodeURIComponent(user.username)}`, { role: event.target.value })).users;
          } catch (error) {
            toast(errorText(error), { tone: 'error' });
          }
          render();
        },
      },
      h('option', { value: 'admin' }, t('roleAdmin')),
      h('option', { value: 'agent' }, t('roleAgent')),
    );
    role.value = user.role;
    return h(
      'li',
      { class: 'team-row' },
      h('span', { class: 'tile small', text: initials(user.username) }),
      h('span', { class: 'name', text: user.username }),
      user.source === 'env' && h('span', { class: 'chip muted', text: t('fromEnv') }),
      h('span', { class: 'grow' }),
      role,
      user.source !== 'env' &&
        user.username !== me &&
        h(
          'button',
          {
            class: 'icon-btn small',
            type: 'button',
            title: t('remove'),
            onclick: async () => {
              try {
                ws.users = (await api(`/api/users/${encodeURIComponent(user.username)}`, undefined, 'DELETE')).users;
              } catch (error) {
                toast(errorText(error), { tone: 'error' });
              }
              render();
            },
          },
          icon('x', 14),
        ),
    );
  });
  const add = h(
    'form',
    {
      class: 'team-add',
      onsubmit: async (event) => {
        event.preventDefault();
        const data = values(event.target);
        try {
          ws.users = (await api('/api/users', data)).users;
          render();
        } catch (error) {
          toast(errorText(error), { tone: 'error' });
        }
      },
    },
    h('input', { name: 'username', placeholder: t('username'), required: true, autocomplete: 'off' }),
    h('input', { name: 'password', type: 'password', placeholder: t('password'), required: true, minlength: 8, autocomplete: 'new-password' }),
    h('select', { name: 'role', class: 'compact' }, h('option', { value: 'agent' }, t('roleAgent')), h('option', { value: 'admin' }, t('roleAdmin'))),
    h('button', { class: 'btn', type: 'submit' }, icon('plus', 15), t('addOperator')),
  );
  return [
    h('h2', { text: t('teamTitle') }),
    h('p', { class: 'lead', text: t('teamText') }),
    h('ul', { class: 'team-list' }, rows),
    add,
    h('div', { class: 'wizard-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: next }, t('continue'))),
  ];
}

function doneStep() {
  const status = ws.status ?? {};
  if (!status.ready) {
    const missing = (status.missing ?? []).map((key) => t(key)).join(', ');
    return [
      h('h2', { text: t('stepDone') }),
      h('p', { class: 'form-error', text: t('missingSettings', { list: missing || t('stepTeam') }) }),
      h('div', { class: 'wizard-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => go('meta') }, t('back'))),
    ];
  }
  return [
    h('div', { class: 'done-mark' }, icon('check', 30, 2.4)),
    h('h2', { text: t('doneTitle') }),
    h('p', { class: 'lead', text: t('doneText', { number: status.fields?.displayNumber?.value || '' }) }),
    h('div', { class: 'wizard-actions' }, h('a', { class: 'btn primary', href: '/' }, t('openApp'))),
  ];
}

// ---------------------------------------------------------------- shell

function render() {
  // The account step stays listed (as done) when this visit started with it.
  const visible = ws.withAccount ? STEPS : STEPS.filter((step) => step !== 'account');
  const index = visible.indexOf(ws.step);
  $('#wizard-progress-bar').style.width = `${Math.round(((index + 1) / visible.length) * 100)}%`;
  $('#wizard-progress-label').textContent = t('progress', { n: index + 1, total: visible.length });
  $('#wizard-steps').replaceChildren(
    ...visible.map((step, i) => {
      const done = stepDone(step) && step !== ws.step;
      return h(
        'li',
        {},
        h(
          'button',
          {
            class: `wizard-step ${step === ws.step ? 'current' : ''} ${done ? 'done' : ''}`,
            type: 'button',
            disabled: ws.needsAccount || step === 'account',
            onclick: () => go(step),
          },
          h('span', { class: 'mark' }, done ? icon('check', 13, 2.6) : String(i + 1)),
          h('span', { text: t(STEP_LABEL[step]) }),
        ),
      );
    }),
  );
  const builders = { account: accountStep, meta: metaStep, webhook: webhookStep, calling: callingStep, team: teamStep, done: doneStep };
  $('#wizard-main').replaceChildren(h('div', { class: 'wizard-card' }, ...builders[ws.step]()));
}

export async function start({ needsAccount = false, me = null, onSignedIn = null } = {}) {
  ws.needsAccount = needsAccount;
  ws.withAccount = needsAccount;
  ws.user = me?.user ?? null;
  ws.onSignedIn = onSignedIn;
  ws.step = needsAccount ? 'account' : 'meta';
  $('#wizard-view').hidden = false;
  if (!needsAccount) {
    try {
      await refreshStatus();
    } catch (error) {
      toast(errorText(error), { tone: 'error' });
    }
  }
  render();
}

export function relabel() {
  if (!$('#wizard-view').hidden) render();
}
