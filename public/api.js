// JSON calls to the SieFlow Phone server and small per-browser preferences.

import { has, t } from './i18n.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, body, method) {
  const options = { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'http_error', data?.error?.message ?? `HTTP ${res.status}`);
  }
  return data;
}

// Server errors carry a code; show our translation when there is one.
export const errorText = (error) =>
  error?.code && has(`errors.${error.code}`) ? t(`errors.${error.code}`) : (error?.message ?? String(error));

export const prefs = {
  read(key, fallback = '') {
    try {
      return localStorage.getItem(`sieflow-phone.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(`sieflow-phone.${key}`, value);
    } catch {
      // Private mode or blocked storage: the preference just will not stick.
    }
  },
};
