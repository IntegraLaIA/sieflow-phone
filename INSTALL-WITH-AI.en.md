# Install SieFlow Phone with an AI agent

[Español](INSTALL-WITH-AI.md) · **English**

This guide is written for AI agents (Claude Code, Codex, Cursor, Copilot, Gemini CLI...) that a person asks to install SieFlow Phone on a server. People can follow it too: every step is a plain shell command.

**Prompt to give your agent:**

> Install SieFlow Phone on this server following https://raw.githubusercontent.com/IntegraLaIA/sieflow-phone/main/INSTALL-WITH-AI.en.md

The result: SieFlow Phone running in Docker behind HTTPS on your domain, and a one-time setup code. The person then opens the site and finishes the guided setup (Meta app, webhook, calling, team) in the browser.

## Rules for the agent

1. **Speak the person's language.** If they write in Spanish, answer in Spanish ([Spanish version of this guide](INSTALL-WITH-AI.md)).
2. **Ask before** installing software, using `sudo`, opening firewall ports, stopping services that use ports 80/443, or touching an existing installation.
3. **Never echo secrets** (Meta access token, app secret, TURN secret) in the chat or in command output. Write them only to `.env` and keep it at mode `600`.
4. **Never set `DEMO_MODE=true`** on a server reachable from the internet.
5. **Prefer the latest release** and pin it in `.env` (`SIEFLOW_PHONE_VERSION`), so upgrades are deliberate.
6. If a step fails twice, stop and report the exact command and output instead of improvising.

## 1. Gather from the person

| Input | Required | Example |
| --- | --- | --- |
| Domain with a DNS A/AAAA record pointing to this server | yes | `phone.example.com` |
| HTTPS: the bundled Caddy (recommended) or an existing reverse proxy | yes | bundled Caddy |
| Install directory | no | `/opt/sieflow-phone` |
| Operators behind strict firewalls that block UDP (needs TURN) | no | no |

Meta credentials are **not** needed now: the person enters them in the guided setup, which checks each value live. If they prefer environment variables, see step 4.

## 2. Check the server

```bash
uname -sm
docker --version && docker compose version
```

- Docker Engine 24+ with the Compose plugin (v2.24+) is required. If it is missing, ask the person and install it from the official guide: https://docs.docker.com/engine/install/
- Linux on amd64 or arm64 works. 1 vCPU and 1 GB of RAM are plenty.

With the bundled Caddy, ports 80 and 443 must be free and reachable from the internet:

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
```

Check that the domain points here (both commands should print the same address):

```bash
curl -fsS https://api.ipify.org; echo
getent ahosts phone.example.com | awk 'NR==1 {print $1}'
```

## 3. Download the release files

```bash
VERSION="$(curl -fsS https://api.github.com/repos/IntegraLaIA/sieflow-phone/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')"
echo "Installing SieFlow Phone $VERSION"
sudo mkdir -p /opt/sieflow-phone && sudo chown "$USER" /opt/sieflow-phone && cd /opt/sieflow-phone
curl -fsSLO "https://raw.githubusercontent.com/IntegraLaIA/sieflow-phone/v$VERSION/docker-compose.yml"
curl -fsSLO "https://raw.githubusercontent.com/IntegraLaIA/sieflow-phone/v$VERSION/Caddyfile"
```

## 4. Configure

```bash
cat > .env <<EOF
DOMAIN=phone.example.com
SIEFLOW_PHONE_VERSION=$VERSION
EOF
chmod 600 .env
```

Optional lines for `.env` (every one of them can also be set later in the browser; values set here show as read-only there):

```bash
# Meta app, if the person gave you the values
WA_APP_ID=...
WA_APP_SECRET=...
WA_ACCESS_TOKEN=...
WA_WABA_ID=...
WA_PHONE_NUMBER_ID=...
# A fixed setup code instead of a random one
SETUP_CODE=...
```

## 5. Start

With the bundled Caddy (gets a Let's Encrypt certificate automatically):

```bash
docker compose --profile https up -d
```

With an existing reverse proxy, start only the app and point the proxy at `http://127.0.0.1:8080`:

```bash
docker compose up -d
```

The app uses Server-Sent Events, so the proxy must not buffer responses. For nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

## 6. Verify

```bash
docker compose ps
curl -fsS http://127.0.0.1:8080/healthz; echo
curl -fsSI "https://phone.example.com/" | head -n 5
```

Expected: the `sieflow-phone` service is `healthy`, `/healthz` answers `{"ok":true,"version":"..."}` and the domain answers `HTTP/2 200` with a `strict-transport-security` header. Caddy may need up to a minute for the first certificate.

## 7. Hand over to the person

```bash
docker compose logs sieflow-phone | grep -m1 "Setup code"
```

Give the person:

1. The URL `https://phone.example.com`.
2. The setup code (it is one-time: whoever uses it first becomes the administrator).
3. What the guided setup will ask for: the Meta App ID and App Secret, a permanent system user token with `whatsapp_business_messaging` and `whatsapp_business_management`, then the webhook (it can configure it in Meta automatically), calling and the team.

Requirements on the Meta side they should know: the number must be on the WhatsApp Cloud API (not shared with the WhatsApp Business app), with a messaging limit of 2,000 or more for calling, and SIP calling turned off.

## Optional: TURN for strict networks

Only if some operators sit behind firewalls that block outbound UDP:

```bash
echo "TURN_SECRET=$(openssl rand -hex 32)" >> .env
echo "TURN_URLS=turn:phone.example.com:3478?transport=udp,turn:phone.example.com:3478?transport=tcp" >> .env
docker compose --profile https --profile turn up -d
```

Open UDP and TCP 3478 and UDP 49160-49200 in the firewall (ask first).

## Upgrade

```bash
cd /opt/sieflow-phone
sed -i "s/^SIEFLOW_PHONE_VERSION=.*/SIEFLOW_PHONE_VERSION=NEW_VERSION/" .env
docker compose --profile https pull && docker compose --profile https up -d
```

Read the [changelog](CHANGELOG.en.md) first. Database migrations run on start.

## Backup and restore

Everything (settings, operators, conversations) is in the `sieflow-phone_sieflow-phone-data` volume:

```bash
docker compose stop sieflow-phone
docker run --rm -v sieflow-phone_sieflow-phone-data:/data -v "$PWD":/backup alpine \
  tar czf "/backup/sieflow-phone-$(date +%F).tgz" -C /data .
docker compose start sieflow-phone
```

The archive contains the WhatsApp access token: store it like a secret. Restore by extracting it into an empty volume with the service stopped.

## Uninstall

```bash
docker compose --profile https --profile turn down      # keeps the data volume
docker volume rm sieflow-phone_sieflow-phone-data       # deletes all data, ask first
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No certificate, Caddy logs ACME errors | DNS points to this server; ports 80/443 open; no other service on them. |
| Page loads but "Reconnecting" never ends | The reverse proxy buffers SSE: disable buffering (see nginx above). |
| Meta cannot verify the webhook | The URL must be public HTTPS ending in `/webhook`; the verify token must match the one shown in the guided setup. |
| Calls ring but there is no audio | The operator's network blocks UDP: enable TURN. The phone shows the audio link state during a call. |
| Lost the setup code | `docker compose restart sieflow-phone` prints a new one while no administrator exists. |
