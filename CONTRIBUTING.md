# Contribuir a SieFlow Phone · Contributing

[Español](#español) · [English](#english)

## Español

Gracias por ayudar. Los issues y pull requests se reciben en español o en inglés.

### Desarrollo

Necesitas Node 22.13 o superior. No hay dependencias de npm que instalar.

```bash
npm run demo   # http://localhost:8080 (demo / demo1234) y el simulador en /simulator
npm test       # node:test, unos 3 segundos
```

La demo corre el servidor real contra una simulación de la API de WhatsApp, así que puedes trabajar en las llamadas, la bandeja y la configuración guiada sin cuenta de Meta. Fuera de producción, los archivos del navegador se leen del disco en cada petición: recarga para ver los cambios.

### Reglas básicas

- **Sin dependencias.** La biblioteca estándar de Node (incluido `node:sqlite`) y módulos de navegador simples. Si crees que hace falta una dependencia, proponla primero en un issue.
- **El audio de las llamadas nunca toca el servidor.** Lo que necesite el audio en el servidor (grabación, transferencia, transcripción) requiere un servidor de medios y una discusión de diseño antes.
- **Cada texto de la interfaz va en los dos idiomas** en `public/i18n.js`.
- **La documentación también va en los dos idiomas.** `README.md`, `INSTALL-WITH-AI.md` y `CHANGELOG.md` están en español y sus gemelos `*.en.md` en inglés; si cambias uno, cambia el otro. Este archivo, `SECURITY.md` y `CODE_OF_CONDUCT.md` llevan los dos idiomas.
- **El texto que no es de confianza nunca es HTML.** Construye el DOM con `h()` de `public/ui.js`; nunca asignes datos del usuario a `innerHTML`.
- **Las pruebas vienen con el cambio.** El comportamiento del servidor se prueba por HTTP contra la simulación de la demo (`test/server.test.js`).
- Los problemas de seguridad van por [SECURITY.md](SECURITY.md), no en issues públicos.

### Pull requests

1. Haz un fork y saca una rama desde `main`.
2. Mantén el cambio enfocado; describe qué cambia y cómo lo probaste.
3. Asegúrate de que `npm test` pase y de que la demo siga funcionando.
4. Si los usuarios van a notar el cambio, agrega una línea en la sección `Sin publicar` de [CHANGELOG.md](CHANGELOG.md) y en `Unreleased` de [CHANGELOG.en.md](CHANGELOG.en.md).

### Publicar una versión (mantenedores)

1. Pasa las notas de `Sin publicar` / `Unreleased` a una sección de versión nueva en los dos registros de cambios y sube `version` en `package.json`.
2. Mergea a `main` y crea la etiqueta: `git tag v0.2.0 && git push origin v0.2.0`.
3. El flujo de release comprueba que la etiqueta coincida con `package.json`, corre las pruebas, publica `ghcr.io/integralaia/sieflow-phone` (amd64 y arm64) y crea el release de GitHub con las notas de los dos registros de cambios, en español y en inglés.

## English

Thanks for helping. Issues and pull requests are welcome in Spanish or English.

### Development

You need Node 22.13 or newer. There are no npm dependencies to install.

```bash
npm run demo   # http://localhost:8080 (demo / demo1234) and the simulator at /simulator
npm test       # node:test, about 3 seconds
```

The demo runs the real server against a mock of the WhatsApp API, so you can work on calls, the inbox and the guided setup without a Meta account. Outside production the browser files are read from disk on every request: reload to see changes.

### Ground rules

- **No dependencies.** Node's standard library (including `node:sqlite`) and plain browser modules. Propose a dependency in an issue first.
- **Call audio never touches the server.** Features that need the audio on the server (recording, transfer, transcription) need a media server and a design discussion first.
- **Every UI string goes in both languages** in `public/i18n.js`.
- **Docs go in both languages too.** `README.md`, `INSTALL-WITH-AI.md` and `CHANGELOG.md` are in Spanish and their `*.en.md` twins in English; change both together. This file, `SECURITY.md` and `CODE_OF_CONDUCT.md` carry both languages.
- **Untrusted text is never HTML.** Build DOM with `h()` from `public/ui.js`; never assign user data to `innerHTML`.
- **Tests come with the change.** Server behavior is tested through HTTP against the demo mock (`test/server.test.js`).
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

### Pull requests

1. Fork and branch from `main`.
2. Keep the change focused; describe what changes and how you tested it.
3. Make sure `npm test` passes and the demo still works.
4. If users will notice the change, add a line to `Sin publicar` in [CHANGELOG.md](CHANGELOG.md) and to `Unreleased` in [CHANGELOG.en.md](CHANGELOG.en.md).

### Releasing (maintainers)

1. Move the `Sin publicar` / `Unreleased` notes into a new version section in both changelogs and bump `version` in `package.json`.
2. Merge to `main`, then tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. The release workflow checks that the tag matches `package.json`, runs the tests, publishes `ghcr.io/integralaia/sieflow-phone` (amd64 and arm64) and creates the GitHub release with the notes from both changelogs, in Spanish and English.
