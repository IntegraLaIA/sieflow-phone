// Thin client for the WhatsApp Cloud API (Graph API): calling, messaging,
// templates, media and the account checks the setup wizard runs.

export class GraphError extends Error {
  constructor(status, body) {
    const error = body?.error ?? {};
    super(error.error_user_msg || error.message || `Graph API returned HTTP ${status}`);
    this.name = 'GraphError';
    this.status = status;
    this.code = error.code ?? null;
    this.subcode = error.error_subcode ?? null;
    this.details = error.error_data?.details ?? null;
  }
}

// Meta error 138006: the user has not granted call permission to this business.
export const NO_CALL_PERMISSION = 138006;

const PHONE_FIELDS =
  'id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status,throughput,messaging_limit_tier';
const PHONE_FIELDS_MINIMAL = 'id,display_phone_number,verified_name,quality_rating';

// `options` is read on every request, so settings saved in the setup wizard
// (or the demo's mock URL) take effect immediately.
export function createGraph(options, { timeoutMs = 10_000 } = {}) {
  // path starts with "/": "/{phone-number-id}/calls", "/debug_token", ...
  async function request(method, path, { body, query, token } = {}) {
    const url = new URL(`${options.graphBaseUrl}/${options.graphVersion}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
    const headers = { authorization: `Bearer ${token ?? options.accessToken}` };
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new GraphError(res.status, data);
    return data;
  }

  const phone = (path) => `/${options.phoneNumberId}${path}`;
  const appToken = () => `${options.appId}|${options.appSecret}`;

  const callAction = (callId, action, extra = {}) =>
    request('POST', phone('/calls'), { body: { messaging_product: 'whatsapp', call_id: callId, action, ...extra } });

  async function send(to, message) {
    const data = await request('POST', phone('/messages'), {
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message },
    });
    const wamid = data?.messages?.[0]?.id;
    if (!wamid) throw new GraphError(502, { error: { message: 'The Graph API did not return a message id' } });
    return wamid;
  }

  return {
    // A client with some values replaced, e.g. to check credentials before saving them.
    withOptions: (overrides) =>
      createGraph(
        { ...options, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value)) },
        { timeoutMs },
      ),

    // ---- calling ----
    preAccept: (callId, sdp) => callAction(callId, 'pre_accept', { session: { sdp_type: 'answer', sdp } }),
    accept: (callId, sdp) => callAction(callId, 'accept', { session: { sdp_type: 'answer', sdp } }),
    reject: (callId) => callAction(callId, 'reject'),
    terminate: (callId) => callAction(callId, 'terminate'),

    async connect(to, sdp) {
      const data = await request('POST', phone('/calls'), {
        body: { messaging_product: 'whatsapp', to, action: 'connect', session: { sdp_type: 'offer', sdp } },
      });
      const callId = data?.calls?.[0]?.id;
      if (!callId) throw new GraphError(502, { error: { message: 'The Graph API did not return a call id' } });
      return callId;
    },

    callPermissions: (waId) => request('GET', phone('/call_permissions'), { query: { user_wa_id: waId } }),

    // ---- messaging ----
    sendText: (to, text) => send(to, { type: 'text', text: { body: text, preview_url: false } }),

    sendTemplate: (to, name, language, components) =>
      send(to, { type: 'template', template: { name, language: { code: language }, components } }),

    sendPermissionRequest: (to, text) =>
      send(to, {
        type: 'interactive',
        interactive: { type: 'call_permission_request', action: { name: 'call_permission_request' }, body: { text } },
      }),

    markRead: (wamid) =>
      request('POST', phone('/messages'), { body: { messaging_product: 'whatsapp', status: 'read', message_id: wamid } }),

    listTemplates: () =>
      request('GET', `/${options.wabaId}/message_templates`, {
        query: { fields: 'name,language,status,category,components,parameter_format', limit: 200 },
      }),

    mediaInfo: (mediaId) => request('GET', `/${mediaId}`),

    // Follows at most 3 redirects, each one checked by `allow(url)`: the request
    // carries the access token.
    async downloadMedia(url, allow = () => true) {
      let next = new URL(url);
      for (let hop = 0; hop < 4; hop += 1) {
        if (!allow(next)) throw new GraphError(502, { error: { message: 'Unexpected media URL from WhatsApp' } });
        const res = await fetch(next, {
          headers: { authorization: `Bearer ${options.accessToken}` },
          redirect: 'manual',
          signal: AbortSignal.timeout(60_000),
        });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          next = new URL(location, next);
          continue;
        }
        if (!res.ok) throw new GraphError(res.status, null);
        return res;
      }
      throw new GraphError(502, { error: { message: 'Too many redirects downloading media' } });
    },

    // ---- calling settings ----
    getSettings: () => request('GET', phone('/settings')),
    updateCallingSettings: (calling) => request('POST', phone('/settings'), { body: { calling } }),

    // ---- setup wizard checks ----
    debugToken: (token = options.accessToken) =>
      request('GET', '/debug_token', { query: { input_token: token }, token: appToken() }),

    waba: (wabaId) => request('GET', `/${wabaId}`, { query: { fields: 'id,name' } }),

    async phoneNumbers(wabaId) {
      try {
        return await request('GET', `/${wabaId}/phone_numbers`, { query: { fields: PHONE_FIELDS } });
      } catch (error) {
        if (error.code !== 100) throw error; // a field this API version does not know
        return request('GET', `/${wabaId}/phone_numbers`, { query: { fields: PHONE_FIELDS_MINIMAL } });
      }
    },

    async phoneNumber(phoneNumberId = options.phoneNumberId) {
      try {
        return await request('GET', `/${phoneNumberId}`, { query: { fields: PHONE_FIELDS } });
      } catch (error) {
        if (error.code !== 100) throw error;
        return request('GET', `/${phoneNumberId}`, { query: { fields: PHONE_FIELDS_MINIMAL } });
      }
    },

    // Point the app's WhatsApp webhook at SieFlow Phone (needs the app secret).
    subscribeAppWebhook: (callbackUrl, verifyToken) =>
      request('POST', `/${options.appId}/subscriptions`, {
        token: appToken(),
        query: {
          object: 'whatsapp_business_account',
          callback_url: callbackUrl,
          verify_token: verifyToken,
          fields: 'messages,calls',
          include_values: 'true',
        },
      }),

    appSubscriptions: () => request('GET', `/${options.appId}/subscriptions`, { token: appToken() }),

    // Deliver this WhatsApp Business Account's events to the app.
    subscribeWaba: () => request('POST', `/${options.wabaId}/subscribed_apps`),
  };
}

// WhatsApp ids are digits only (country code + number, no "+").
export function normalizeNumber(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}
