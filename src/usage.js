// The message log: what went in and out each month, what Meta reported as
// billable, and how much of the month's free service messages is used. Counts
// and metadata only, never message text. The month view, the detail list and
// the CSV are for administrators; every operator sees the service counter.

import { CallError } from './calls.js';
import { monthOf } from './db.js';
import { sendJson } from './http.js';

// From October 1, 2026 Meta charges every delivered message. Replies inside the
// 24-hour customer service window are "service" messages: each business phone
// number gets this many free a month. Templates are charged from the first one,
// and incoming messages are free.
export const FREE_SERVICE_MESSAGES = 1000;

const CATEGORIES = ['service', 'utility', 'marketing', 'authentication', 'template'];
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const FILTERS = new Set(['received', 'sent', 'calls']);
const EXPORT_PAGE = 1000;

function previousMonths(count, now = Date.now()) {
  const date = new Date(now);
  const months = [];
  for (let index = 0; index < count; index += 1) {
    months.push(monthOf(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - index, 1)));
  }
  return months;
}

const sum = (counts) => Object.values(counts).reduce((total, value) => total + value, 0);

export function summarize(month, metrics = {}) {
  const get = (key) => metrics[key] ?? 0;
  const sent = Object.fromEntries(CATEGORIES.map((category) => [category, get(`sent.${category}`)]));
  const delivered = Object.fromEntries(CATEGORIES.map((category) => [category, get(`delivered.${category}`)]));
  const agents = new Map();
  for (const [key, value] of Object.entries(metrics)) {
    const match = key.match(/^agent\.(.+)\.(messages|calls)$/);
    if (!match) continue;
    const entry = agents.get(match[1]) ?? { agent: match[1], messages: 0, calls: 0 };
    entry[match[2]] += value;
    agents.set(match[1], entry);
  }
  return {
    month,
    received: get('received'),
    sent: { ...sent, total: sum(sent) },
    delivered: { ...delivered, total: sum(delivered) },
    failed: get('failed'),
    billable: get('billable'),
    service: {
      delivered: delivered.service,
      free: FREE_SERVICE_MESSAGES,
      overFree: Math.max(0, delivered.service - FREE_SERVICE_MESSAGES),
    },
    calls: {
      in: get('calls.in'),
      out: get('calls.out'),
      inSeconds: get('calls.in_seconds'),
      outSeconds: get('calls.out_seconds'),
    },
    agents: [...agents.values()].sort((a, b) => b.messages + b.calls - (a.messages + a.calls) || a.agent.localeCompare(b.agent)),
  };
}

// ---- CSV --------------------------------------------------------------------

const COLUMNS = {
  en: ['date_utc', 'direction', 'number', 'name', 'type', 'category', 'template', 'status', 'meta_billable', 'meta_category', 'meta_type', 'operator', 'call_seconds'],
  es: ['fecha_utc', 'sentido', 'numero', 'nombre', 'tipo', 'categoria', 'plantilla', 'estado', 'facturable_meta', 'categoria_meta', 'tipo_meta', 'operador', 'segundos_llamada'],
};
const WORDS = {
  en: { in: 'received', out: 'sent', yes: 'yes', no: 'no' },
  es: { in: 'recibido', out: 'enviado', yes: 'sí', no: 'no' },
};

// Names come from WhatsApp profiles: a leading =, +, - or @ would run as a
// formula in a spreadsheet, so it gets a quote in front.
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(entry, lang) {
  const words = WORDS[lang];
  return [
    new Date(entry.createdAt).toISOString(),
    words[entry.direction] ?? entry.direction,
    entry.waId,
    entry.name,
    entry.kind,
    entry.category,
    entry.template,
    entry.status,
    entry.billable === null ? '' : entry.billable ? words.yes : words.no,
    entry.pricingCategory,
    entry.pricingType,
    entry.agent,
    entry.duration,
  ]
    .map(csvCell)
    .join(',');
}

// ---- routes -----------------------------------------------------------------

export function createUsage({ db }) {
  function month(url) {
    const value = url.searchParams.get('month') ?? monthOf(Date.now());
    if (!MONTH.test(value)) throw new CallError(400, 'bad_month', 'Use a month like 2026-10');
    return value;
  }

  function exportCsv(res, url) {
    const selected = month(url);
    const lang = url.searchParams.get('lang') === 'es' ? 'es' : 'en';
    const lines = [COLUMNS[lang].join(',')];
    let before;
    for (;;) {
      const page = db.messageLog({ month: selected, before, limit: EXPORT_PAGE });
      for (const entry of page.messages) lines.push(csvRow(entry, lang));
      if (!page.hasMore) break;
      before = page.messages.at(-1).id;
    }
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="sieflow-phone-${selected}.csv"`,
      'cache-control': 'private, no-store',
    });
    // The byte order mark makes Excel read the accents right.
    res.end(`﻿${lines.join('\r\n')}\r\n`);
  }

  async function handle(req, res, url, session) {
    const { pathname } = url;
    if (req.method !== 'GET' || (pathname !== '/api/usage' && !pathname.startsWith('/api/usage/'))) return false;

    if (pathname === '/api/usage/current') {
      const current = monthOf(Date.now());
      sendJson(res, 200, { month: current, service: summarize(current, db.usage(current).get(current)).service });
      return true;
    }

    if (session.role !== 'admin') throw new CallError(403, 'admins_only', 'Only administrators can see the message log');

    if (pathname === '/api/usage') {
      const count = Math.min(24, Math.max(1, Number(url.searchParams.get('months')) || 12));
      const months = previousMonths(count);
      const metrics = db.usage(months.at(-1));
      sendJson(res, 200, {
        freeServiceMessages: FREE_SERVICE_MESSAGES,
        months: months.map((value) => summarize(value, metrics.get(value))),
      });
      return true;
    }
    if (pathname === '/api/usage/messages') {
      const filter = url.searchParams.get('filter');
      sendJson(
        res,
        200,
        db.messageLog({
          month: month(url),
          filter: FILTERS.has(filter) ? filter : '',
          agent: url.searchParams.get('agent') ?? '',
          before: Number(url.searchParams.get('before')) || undefined,
        }),
      );
      return true;
    }
    if (pathname === '/api/usage/export') {
      exportCsv(res, url);
      return true;
    }
    return false;
  }

  return { handle };
}
