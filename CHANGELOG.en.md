# Changelog

[Español](CHANGELOG.md) · **English**

All notable changes to SieFlow Phone are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-10-12

### Added
- An "About" block in Settings with links to the code and to the SieFlow Phone Cloud waitlist. They are plain links: the app makes no new network calls.

### Changed
- The project website is now [phone.sieflow.ai](https://phone.sieflow.ai/en/), in English and Spanish.
- The image declares `org.opencontainers.image.source` and its details (title, description, license and website) in the `Dockerfile`, so a local build is linked to the repository too.
- Releases start as drafts: the `release` workflow, run by hand with the version, checks `package.json` and both changelogs and creates the draft with the notes; publishing it builds and pushes the image for amd64 and arm64.

### Documentation
- Spanish becomes the repository's main language: `README.md`, `INSTALL-WITH-AI.md` and `CHANGELOG.md` are in Spanish, with English versions in `*.en.md`. The security policy, contributing guide, code of conduct and issue and pull request templates carry both languages.
- Release notes are published in Spanish and English.

## [0.1.0] - 2026-10-11

First public release.

### Phone
- Answer incoming WhatsApp calls in the browser: they ring on every signed-in operator and the first one to answer takes the call.
- Place calls to WhatsApp users, with the call permission flow WhatsApp requires.
- Mute, keypad tones (DTMF), microphone and speaker selection, recent calls.
- Floating phone in an always-on-top window (Document Picture-in-Picture, Chrome and Edge).
- Audio goes straight between the browser and WhatsApp over WebRTC: no SIP server, no media server.

### Shared inbox
- Conversations with messages and calls in one thread: text, photos, voice notes, video, documents, locations, contacts, replies and reactions.
- Replies inside the 24-hour customer service window and approved templates outside it (positional and named parameters).
- Call permission requests from the chat: interactive message inside the window, template with the permission button outside it.
- Mine / Unassigned / All, search, assignment, resolve and reopen, unread counts and read receipts.

### Setup and operations
- Guided setup in the browser: administrator account protected by a code from the server logs, live checks of the Meta app and token, discovery of WhatsApp accounts and numbers, automatic webhook configuration, calling requirements and team.
- Settings stored in SQLite (`node:sqlite`); environment variables still work and lock the matching field.
- Single container with zero npm dependencies, optional Caddy (HTTPS) and coturn (TURN) profiles.
- Demo mode with a mock WhatsApp API and a user simulator.
- English and Spanish, light and dark themes, installable as a desktop app.

### Security and privacy
- Signed webhooks only, one-time setup code with rate limiting, scrypt passwords, sessions tied to the password and revoked on sign-out, rate-limited sign-in that a spoofed `X-Forwarded-For` cannot bypass.
- Strict CSP, HSTS, `__Host-` cookies over HTTPS, media proxy limited to Meta hosts.
- Container runs unprivileged on a read-only filesystem with no capabilities; the database is readable only by its owner.
- `RETENTION_DAYS`, deletion of a contact with all its history, no message text in logs or notifications.

[Unreleased]: https://github.com/IntegraLaIA/sieflow-phone/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/IntegraLaIA/sieflow-phone/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/IntegraLaIA/sieflow-phone/releases/tag/v0.1.0
