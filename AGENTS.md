# Notes for AI coding agents

These notes are for agents changing the code. To install SieFlow Phone on a server, follow [INSTALL-WITH-AI.md](INSTALL-WITH-AI.md) (Spanish) or [INSTALL-WITH-AI.en.md](INSTALL-WITH-AI.en.md) (English) instead.

## Map

- `src/server.js` entry point; `src/app.js` HTTP routes, sessions, webhook and call API.
- `src/inbox.js` conversations, messages, templates, media proxy. `src/setup.js` guided setup and team API.
- `src/db.js` SQLite (`node:sqlite`) with numbered migrations in `MIGRATIONS`: append, never edit an existing one.
- `src/settings.js` settings and operators (environment variables override and lock values).
- `src/usage.js` message log: monthly counts (`db.usage`, kept in `usage_archive` when messages are pruned or erased), the detail, the CSV and the free service messages Meta gives each number (`FREE_SERVICE_MESSAGES`).
- `src/graph.js` WhatsApp Cloud API client. `src/webhook.js` signature check and event parsing.
- `src/calls.js` live call state (in memory). `src/demo.js` mock Graph API and simulator, only with `DEMO_MODE`.
- `public/` browser app: `app.js` bootstrap, `phone.js` WebRTC phone, `inbox.js`, `usage.js` (message log dialog), `wizard.js`, `ui.js` (DOM builder, icons, theme), `i18n.js` (English and Spanish).

## Commands

```bash
npm test          # all tests, ~3 s
npm run demo      # demo on :8080 (demo / demo1234), simulator at /simulator
```

## Rules

- Zero npm dependencies; Node 22.13+.
- Call audio stays browser <-> WhatsApp (WebRTC). The server only relays signaling.
- WhatsApp rules the code depends on: send the same SDP in `pre_accept` and `accept`; media only after `accept` returns 200; free-form messages only within 24 hours of the customer's last message, templates otherwise; outgoing calls need the user's call permission. Since October 1, 2026 Meta also charges the free-form replies (service messages) past 1,000 a month per number: the window is still a sending rule, not only a price.
- Build DOM with `h()` and `textContent`; never put untrusted data in `innerHTML`.
- Add every UI string to both languages in `public/i18n.js`.
- Docs are bilingual and Spanish comes first: `README.md`, `INSTALL-WITH-AI.md` and `CHANGELOG.md` are Spanish, their `*.en.md` twins English; `SECURITY.md`, `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` carry both. Change both versions in the same commit.
- Keep the page CSP intact: no inline scripts or styles, no new third-party origins.
- Test server changes through HTTP against the demo mock in `test/server.test.js`.
