# Contributing to SieFlow Phone

Thanks for helping. Issues and pull requests are welcome in English or Spanish.

## Development

You need Node 22.13 or newer. There are no npm dependencies to install.

```bash
npm run demo   # http://localhost:8080 (demo / demo1234) and the simulator at /simulator
npm test       # node:test, about 3 seconds
```

The demo runs the real server against a mock of the WhatsApp API, so you can work on calls, the inbox and the guided setup without a Meta account. Outside production the browser files are read from disk on every request: reload to see changes.

## Ground rules

- **No dependencies.** Node's standard library (including `node:sqlite`) and plain browser modules. Propose a dependency in an issue first.
- **Call audio never touches the server.** Features that need the audio on the server (recording, transfer, transcription) need a media server and a design discussion first.
- **Every UI string goes in both languages** in `public/i18n.js`.
- **Untrusted text is never HTML.** Build DOM with `h()` from `public/ui.js`; never assign user data to `innerHTML`.
- **Tests come with the change.** Server behavior is tested through HTTP against the demo mock (`test/server.test.js`).
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Pull requests

1. Fork and branch from `main`.
2. Keep the change focused; describe what changes and how you tested it.
3. Make sure `npm test` passes and the demo still works.
4. Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) if users will notice the change.

## Releasing (maintainers)

1. Move the `Unreleased` notes into a new version section in `CHANGELOG.md` and bump `version` in `package.json`.
2. Merge to `main`, then tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. The release workflow checks that the tag matches `package.json`, runs the tests, publishes `ghcr.io/integralaia/sieflow-phone` (amd64 and arm64) and creates the GitHub release from the changelog.
