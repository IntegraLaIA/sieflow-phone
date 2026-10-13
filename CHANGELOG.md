# Registro de cambios

**Español** · [English](CHANGELOG.en.md)

Aquí se documentan los cambios relevantes de SieFlow Phone. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [Sin publicar]

## [1.0.0] - 2026-10-12

### Registro de mensajes
- Desde el 1 de octubre de 2026 Meta cobra cada mensaje entregado, también las respuestas dentro de la ventana de 24 horas (mensajes de servicio, con 1.000 gratis al mes por número). La regla de la ventana no cambia: fuera de ella WhatsApp solo deja enviar plantillas.
- Registro de mensajes para administradores (ícono de gráfica en el encabezado): por mes, lo recibido, los mensajes de servicio frente a los 1.000 gratis, las plantillas por categoría, lo que Meta reporta como facturable, las llamadas y quién envió qué. Detalle del mes con filtros y descarga en CSV, sin el texto de los mensajes.
- El compositor avisa que cada respuesta es un mensaje de servicio y cuántos van del mes; el diálogo de plantillas muestra la categoría de cada una y que Meta las cobra.
- Se guarda lo que Meta informa en cada estado de entrega (`pricing`: facturable, categoría y tipo), y el modo demo lo simula.
- Los conteos por mes se conservan aunque `RETENTION_DAYS` o el borrado de un contacto eliminen los mensajes (solo conteos, sin datos personales).

### Añadido
- En Ajustes, un bloque «Acerca de» con el enlace al código y a la lista de espera de SieFlow Phone Cloud. Son enlaces estáticos: la app no hace ninguna llamada de red nueva.

### Cambiado
- El sitio del proyecto es ahora [phone.sieflow.ai](https://phone.sieflow.ai), en español y en inglés.
- La imagen declara `org.opencontainers.image.source` y su ficha (título, descripción, licencia y sitio) desde el `Dockerfile`, así que también un build local queda ligado al repositorio.
- Las versiones se publican desde un borrador: el workflow `release`, lanzado a mano con la versión, comprueba `package.json` y los dos changelogs y crea el borrador con las notas; al publicarlo se construye y se sube la imagen para amd64 y arm64.

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

[Sin publicar]: https://github.com/IntegraLaIA/sieflow-phone/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/IntegraLaIA/sieflow-phone/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/IntegraLaIA/sieflow-phone/releases/tag/v0.1.0
