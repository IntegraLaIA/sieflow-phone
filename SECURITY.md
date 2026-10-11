# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the [Security tab](https://github.com/IntegraLaIA/sieflow-phone/security) of this repository and choose **Report a vulnerability**. Do not open a public issue for security problems.

Include the version (`/healthz` shows it), what an attacker can do, and the steps to reproduce it. We acknowledge reports within 3 business days and keep you posted until a fix is released. We are happy to credit you in the release notes.

## Supported versions

Security fixes go into the latest release. Upgrade by pulling the new image: `docker compose pull && docker compose up -d`.

## How SieFlow Phone protects your data

- **Webhooks** are accepted only with a valid `X-Hub-Signature-256` signed with your Meta App Secret.
- **The first administrator** needs a one-time setup code printed in the server logs; guessing it is rate limited.
- **Passwords** are stored as scrypt hashes. Sessions are HMAC-signed `HttpOnly`, `SameSite=Strict` cookies (`__Host-` prefixed and `Secure` over HTTPS), tied to the user's password: changing it or removing the user ends their sessions and live event streams, and signing out revokes the token. Failed sign-ins are rate limited per address and per user, and password checks are capped so a flood of sign-ins cannot delay calls.
- **Requests that change data** from other origins are refused.
- **Pages** ship with a strict Content Security Policy, `X-Frame-Options: DENY`, `nosniff` and, over HTTPS, HSTS.
- **Media** from WhatsApp is proxied only for signed-in operators and only for media SieFlow Phone received; the access token is sent only to Meta's media hosts (redirects included), nothing is cached by the browser, and anything that is not a plain image, audio or video downloads instead of opening.
- **Secrets** saved by the setup wizard (access token, app secret) live in the SQLite database in the data volume, readable only by the container user, and are never sent back to the browser.
- **The container** runs as an unprivileged user with a read-only filesystem, no Linux capabilities and `no-new-privileges` in the provided compose file.
- **Call audio never reaches the server**: it flows over WebRTC (DTLS-SRTP) between the browser and WhatsApp.
- **Privacy**: logs carry no message text or phone numbers, desktop notifications show no message text, `RETENTION_DAYS` deletes old messages and call records, and administrators can delete a contact with all its history.

## Hardening checklist for operators

- Serve it only over HTTPS (the `https` compose profile does it for you).
- Never enable `DEMO_MODE` on a reachable server: the simulator endpoints have no authentication and the demo login is public (demo data always stays in memory).
- Protect and back up the data volume: it holds your WhatsApp access token and conversations.
- Use a WhatsApp system user token with only the permissions SieFlow Phone needs.
- Keep `TRUST_PROXY` on only when the app is reachable exclusively through your reverse proxy (the compose file binds it to `127.0.0.1`), and make the proxy append the client address to `X-Forwarded-For` (Caddy and nginx do).
- Set `RETENTION_DAYS` to what your privacy policy promises.
- If you run coturn, keep `TURN_SECRET` long and random; coturn will not start without it.
