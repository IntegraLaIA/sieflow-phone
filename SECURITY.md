# Política de seguridad · Security policy

[Español](#español) · [English](#english)

## Español

### Reportar una vulnerabilidad

Repórtala en privado por GitHub: abre la [pestaña Security](https://github.com/IntegraLaIA/sieflow-phone/security) de este repositorio y elige **Report a vulnerability**. No abras un issue público para problemas de seguridad.

Incluye la versión (la muestra `/healthz`), qué puede hacer un atacante y los pasos para reproducirlo. Confirmamos el reporte en un máximo de 3 días hábiles y te mantenemos al tanto hasta publicar la corrección. Con gusto te damos crédito en las notas de la versión.

### Versiones con soporte

Las correcciones de seguridad van en la última versión. Para actualizar, descarga la imagen nueva: `docker compose pull && docker compose up -d`.

### Cómo protege SieFlow Phone tus datos

- **Los webhooks** solo se aceptan con un `X-Hub-Signature-256` válido, firmado con el App Secret de tu app de Meta.
- **El primer administrador** necesita un código de configuración de un solo uso que aparece en los logs del servidor; adivinarlo tiene límite de intentos.
- **Las contraseñas** se guardan como hashes scrypt. Las sesiones son cookies `HttpOnly` y `SameSite=Strict` firmadas con HMAC (con prefijo `__Host-` y `Secure` sobre HTTPS), atadas a la contraseña del usuario: cambiarla o eliminar al usuario termina sus sesiones y sus flujos de eventos en vivo, y cerrar sesión revoca el token. Los inicios de sesión fallidos tienen límite por dirección y por usuario, y las verificaciones de contraseña tienen un tope para que una avalancha de intentos no demore las llamadas.
- **Las peticiones que cambian datos** desde otros orígenes se rechazan.
- **Las páginas** salen con una Content Security Policy estricta, `X-Frame-Options: DENY`, `nosniff` y, sobre HTTPS, HSTS.
- **Los archivos de WhatsApp** (fotos, audios, documentos) se sirven por un proxy solo a operadores con sesión y solo si SieFlow Phone los recibió; el token de acceso se envía únicamente a los hosts de medios de Meta (redirecciones incluidas), el navegador no guarda nada en caché, y lo que no sea una imagen, un audio o un video simple se descarga en vez de abrirse.
- **Los secretos** que guarda la configuración guiada (token de acceso, App Secret) viven en la base SQLite del volumen de datos, que solo puede leer el usuario del contenedor, y nunca vuelven al navegador.
- **El contenedor** corre con un usuario sin privilegios, sistema de archivos de solo lectura, sin capacidades de Linux y con `no-new-privileges` en el compose incluido.
- **El audio de las llamadas nunca llega al servidor**: viaja por WebRTC (DTLS-SRTP) entre el navegador y WhatsApp.
- **Privacidad**: los logs no llevan el texto de los mensajes ni números de teléfono, las notificaciones de escritorio no muestran el texto de los mensajes, `RETENTION_DAYS` borra los mensajes y registros de llamadas viejos, y un administrador puede eliminar un contacto con todo su historial (útil para la Ley 1581 de 2012 y el RGPD).
- **Registro de mensajes**: guarda conteos por mes sin datos personales. El detalle y la descarga en CSV traen números, nombres y estados de entrega, nunca el texto de los mensajes, y solo los pueden ver los administradores; trata ese archivo como datos personales.

### Lista de endurecimiento para quien lo opera

- Sírvelo solo por HTTPS (el perfil `https` del compose lo hace por ti).
- Nunca actives `DEMO_MODE` en un servidor al que se llegue desde internet: los endpoints del simulador no tienen autenticación y el usuario de la demo es público (los datos de la demo siempre quedan en memoria).
- Protege y respalda el volumen de datos: guarda tu token de acceso de WhatsApp y las conversaciones.
- Usa un token de usuario del sistema de WhatsApp con solo los permisos que SieFlow Phone necesita.
- Deja `TRUST_PROXY` activo solo si la aplicación se alcanza únicamente a través de tu proxy inverso (el compose la publica en `127.0.0.1`), y haz que el proxy agregue la dirección del cliente a `X-Forwarded-For` (Caddy y nginx lo hacen).
- Define `RETENTION_DAYS` según lo que promete tu política de privacidad.
- Si usas coturn, deja `TURN_SECRET` largo y aleatorio; coturn no arranca sin él.

## English

### Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the [Security tab](https://github.com/IntegraLaIA/sieflow-phone/security) of this repository and choose **Report a vulnerability**. Do not open a public issue for security problems.

Include the version (`/healthz` shows it), what an attacker can do, and the steps to reproduce it. We acknowledge reports within 3 business days and keep you posted until a fix is released. We are happy to credit you in the release notes.

### Supported versions

Security fixes go into the latest release. Upgrade by pulling the new image: `docker compose pull && docker compose up -d`.

### How SieFlow Phone protects your data

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
- **Message log**: keeps monthly counts without personal data. The detail and the CSV download carry numbers, names and delivery statuses, never message text, and only administrators can see them; treat that file as personal data.

### Hardening checklist for operators

- Serve it only over HTTPS (the `https` compose profile does it for you).
- Never enable `DEMO_MODE` on a reachable server: the simulator endpoints have no authentication and the demo login is public (demo data always stays in memory).
- Protect and back up the data volume: it holds your WhatsApp access token and conversations.
- Use a WhatsApp system user token with only the permissions SieFlow Phone needs.
- Keep `TRUST_PROXY` on only when the app is reachable exclusively through your reverse proxy (the compose file binds it to `127.0.0.1`), and make the proxy append the client address to `X-Forwarded-For` (Caddy and nginx do).
- Set `RETENTION_DAYS` to what your privacy policy promises.
- If you run coturn, keep `TURN_SECRET` long and random; coturn will not start without it.
