# Registro de cambios

**Español** · [English](CHANGELOG.en.md)

Aquí se documentan los cambios relevantes de SieFlow Phone. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [Sin publicar]

### Documentación
- El español pasa a ser el idioma principal del repositorio: `README.md`, `INSTALL-WITH-AI.md` y `CHANGELOG.md` en español, con sus versiones en inglés en `*.en.md`. La política de seguridad, la guía para contribuir, el código de conducta y las plantillas de issues y pull requests quedan en los dos idiomas.
- Las notas de cada versión se publican en español y en inglés.

## [0.1.0] - 2026-10-11

Primera versión pública.

### Teléfono
- Contesta en el navegador las llamadas entrantes de WhatsApp: timbran en todos los operadores conectados y la toma el primero que conteste.
- Llama a usuarios de WhatsApp, con el flujo de permiso de llamada que exige WhatsApp.
- Silenciar, tonos del teclado (DTMF), elección de micrófono y parlante, llamadas recientes.
- Teléfono flotante en una ventana siempre encima (Document Picture-in-Picture, Chrome y Edge).
- El audio va directo entre el navegador y WhatsApp por WebRTC: sin servidor SIP ni servidor de medios.

### Bandeja compartida
- Conversaciones con mensajes y llamadas en un solo hilo: texto, fotos, notas de voz, video, documentos, ubicaciones, contactos, respuestas y reacciones.
- Respuestas dentro de la ventana de atención de 24 horas y plantillas aprobadas fuera de ella (parámetros posicionales y con nombre).
- Solicitudes de permiso de llamada desde el chat: mensaje interactivo dentro de la ventana y plantilla con el botón de permiso fuera de ella.
- Mías / Sin asignar / Todas, búsqueda, asignación, resolver y reabrir, conteo de no leídos y confirmaciones de lectura.

### Configuración y operación
- Configuración guiada en el navegador: cuenta de administrador protegida por un código de los logs del servidor, verificación en vivo de la app y el token de Meta, búsqueda de cuentas y números de WhatsApp, configuración automática del webhook, requisitos de llamadas y equipo.
- Ajustes guardados en SQLite (`node:sqlite`); las variables de entorno siguen funcionando y bloquean el campo correspondiente.
- Un solo contenedor sin dependencias de npm, con perfiles opcionales de Caddy (HTTPS) y coturn (TURN).
- Modo demo con una API de WhatsApp simulada y un simulador del usuario.
- Español e inglés, tema claro y oscuro, instalable como app de escritorio.

### Seguridad y privacidad
- Solo webhooks firmados, código de configuración de un solo uso con límite de intentos, contraseñas scrypt, sesiones atadas a la contraseña y revocadas al cerrar sesión, inicio de sesión con límite de intentos que un `X-Forwarded-For` falsificado no puede saltar.
- CSP estricta, HSTS, cookies `__Host-` sobre HTTPS, proxy de medios limitado a los hosts de Meta.
- El contenedor corre sin privilegios, con sistema de archivos de solo lectura y sin capacidades; la base de datos solo la puede leer su dueño.
- `RETENTION_DAYS`, borrado de un contacto con todo su historial, sin texto de los mensajes en los logs ni en las notificaciones.

[Sin publicar]: https://github.com/IntegraLaIA/sieflow-phone/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/IntegraLaIA/sieflow-phone/releases/tag/v0.1.0
