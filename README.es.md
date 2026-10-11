# SieFlow Phone

**Llamadas y chat de WhatsApp para tu equipo, en tu propio servidor.** Contesta y haz llamadas de voz de WhatsApp desde el navegador y responde los mensajes desde una bandeja compartida. Sin Asterisk, sin troncal SIP y sin servidor de medios: un contenedor pequeño y sin dependencias.

[![CI](https://github.com/IntegraLaIA/sieflow-phone/actions/workflows/ci.yml/badge.svg)](https://github.com/IntegraLaIA/sieflow-phone/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/IntegraLaIA/sieflow-phone)](https://github.com/IntegraLaIA/sieflow-phone/releases)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-green)](LICENSE)

Parte de [SieFlow](https://sieflow.ai), de INTEGRALAIA. · [English](README.md)

![SieFlow Phone: bandeja compartida, conversación y una llamada de WhatsApp en curso](docs/images/workspace.png)

## Qué hace

- **Teléfono en el navegador.** Las llamadas entrantes de WhatsApp timbran en todos los operadores conectados y la toma el primero que conteste. Llamadas salientes con el permiso que exige WhatsApp. Silenciar, tonos del teclado, micrófono y altavoz.
- **Teléfono flotante.** Saca el teléfono del navegador a una ventana siempre encima, como un minirreproductor (Chrome y Edge).
- **Bandeja compartida.** Mensajes y llamadas en un solo hilo por cliente: texto, fotos, notas de voz, documentos, ubicaciones. Respuestas dentro de la ventana de 24 horas, plantillas aprobadas fuera de ella, estados de entrega.
- **Permiso de llamada desde el chat.** Solicitud interactiva dentro de la ventana de 24 horas, plantilla con botón de permiso fuera de ella, y la respuesta aparece en el hilo.
- **Multiagente sin complicaciones.** Mías / Sin asignar / Todas, la primera respuesta toma la conversación, asignar a un compañero, resolver y reabrir.
- **Configuración guiada.** Una instancia vacía pide todo en el navegador y verifica cada dato en vivo contra Meta, hasta configurar el webhook por ti.
- Español e inglés, tema claro y oscuro, instalable como app de escritorio. Un modo demo simula WhatsApp para probar todo sin cuenta de Meta.

## Pruébalo en un minuto

```bash
docker run --rm -p 8080:8080 -e DEMO_MODE=true ghcr.io/integralaia/sieflow-phone
```

Abre http://localhost:8080 (usuario `demo`, contraseña `demo1234`) y, en otra pestaña, http://localhost:8080/simulator. El simulador hace de usuario de WhatsApp: escríbele al negocio, llámalo, acepta la solicitud de permiso de llamada. Corre el flujo real del webhook firmado contra una simulación de la API de WhatsApp, y el audio es WebRTC de verdad.

## Instálalo en tu servidor

Necesitas Docker con Compose, un dominio apuntando al servidor y los puertos 80/443 libres.

```bash
mkdir sieflow-phone && cd sieflow-phone
curl -fsSLO https://raw.githubusercontent.com/IntegraLaIA/sieflow-phone/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/IntegraLaIA/sieflow-phone/main/Caddyfile
echo "DOMAIN=telefono.tuempresa.com" > .env
docker compose --profile https up -d
docker compose logs sieflow-phone | grep "Setup code"
```

Abre `https://telefono.tuempresa.com`, escribe el código de configuración y sigue la configuración guiada. ¿Ya tienes nginx, Traefik u otro proxy? Arranca sin el perfil (`docker compose up -d`) y apunta el proxy a `127.0.0.1:8080`.

### O deja que tu asistente de IA lo instale

Dale este mensaje a Claude Code, Codex, Cursor o cualquier agente con acceso a la terminal:

> Install SieFlow Phone on this server following https://raw.githubusercontent.com/IntegraLaIA/sieflow-phone/main/INSTALL-WITH-AI.md

[INSTALL-WITH-AI.md](INSTALL-WITH-AI.md) guía al agente por las verificaciones, la instalación, las pruebas, las actualizaciones y los respaldos, con reglas sobre qué preguntar antes de hacer.

## Configuración guiada

![Configuración guiada verificando la app de Meta y el token en vivo](docs/images/setup.png)

| Paso | Qué hace |
| --- | --- |
| Tu cuenta | Crea el primer administrador con el código de un solo uso de los logs, así nadie más reclama la instancia. |
| App de Meta | Verifica en vivo App ID, App Secret y token: válido, de usuario del sistema, que no venza, permisos y misma app. Luego lista tus cuentas y números de WhatsApp para elegir uno. |
| Webhook | Muestra la URL de devolución y un token de verificación generado, y puede configurar el webhook de la app (`calls`, `messages`) y suscribir tu cuenta por ti. Las revisiones en vivo muestran cuando Meta verifica la URL y cuando llegan eventos. |
| Llamadas | Revisa Cloud API, calidad, límite de mensajería, SIP apagado y restricciones; activa las llamadas y el botón de llamada; define el texto de la solicitud de permiso. |
| Equipo | Agrega operadores y administradores. |

Lo que pide Meta: un número en la **Cloud API** de WhatsApp (las llamadas no funcionan en números compartidos con la app de WhatsApp Business), un límite de mensajería de 2.000 o más para llamar, y una app de Meta con un token permanente de usuario del sistema (`whatsapp_business_messaging`, `whatsapp_business_management`).

## Cómo funciona

La API de WhatsApp Cloud negocia las llamadas con SDP de WebRTC estándar y termina el audio en los servidores de medios de Meta. Un navegador es un extremo WebRTC, así que puede hablar directo con WhatsApp. SieFlow Phone transporta la señalización y guarda la bandeja:

```
 Navegador del operador                 SieFlow Phone (Node)             API de WhatsApp Cloud
 ----------------------                 --------------------             ---------------------
 RTCPeerConnection   <-- eventos SSE --  webhook /webhook  <-- llamadas, mensajes, estados
 bandeja             -- POST JSON ---->  cliente Graph API -- pre_accept/accept, mensajes -->
        |                                                                         |
        +===================== audio: WebRTC (Opus, DTLS-SRTP) ==================+
                        directo a Meta, nunca pasa por SieFlow Phone
```

<img src="docs/images/mobile-dark.png" alt="SieFlow Phone en un celular, tema oscuro" width="300" align="right">

## Variables

No hace falta ninguna: la configuración guiada guarda todo. Si defines alguna, manda sobre la configuración guiada y allí aparece como de solo lectura. La tabla completa está en el [README en inglés](README.md#settings) y cada variable viene comentada en [.env.example](.env.example). Destacan `RETENTION_DAYS` (borra mensajes y llamadas más viejos que esos días) y `WEBHOOK_FORWARD_URL` (reenvía cada webhook, con su firma, a otro backend si ya recibes ahí los mensajes de WhatsApp).

**Firewalls estrictos.** Los servidores de medios de WhatsApp tienen IP pública, así que la mayoría de redes conecta directo. Para operadores en redes que bloquean UDP, `docker compose --profile turn up -d` agrega coturn (define `TURN_SECRET` y `TURN_URLS`).

<br clear="right">

## Privacidad y seguridad

- **Tus datos se quedan en tu servidor**: ajustes, operadores, conversaciones y registros de llamadas viven en un archivo SQLite dentro del volumen de datos. El audio de las llamadas nunca llega al servidor.
- **Retención y borrado**: `RETENTION_DAYS` borra los mensajes viejos solo, y un administrador puede eliminar un contacto con todos sus mensajes y llamadas (útil para la Ley 1581 y el RGPD).
- **Seguro por defecto**: solo webhooks firmados, código de configuración de un solo uso, contraseñas scrypt, sesiones que terminan al cambiar la contraseña, límite de intentos, CSP estricta, HSTS y un contenedor sin privilegios con sistema de archivos de solo lectura.
- La única petición a terceros desde el navegador es la fuente Quicksand de Google Fonts.

Detalles y cómo reportar una vulnerabilidad en [SECURITY.md](SECURITY.md).

## Límites

- Solo llamadas de audio, una por operador a la vez. Los operadores responden con texto y plantillas; enviar archivos aún no está.
- Sin transferencia, grabación ni transcripción en el servidor: el audio nunca llega al servidor, y eso es lo que lo mantiene liviano.
- Una instancia y un número de WhatsApp por instancia.

## Desarrollo

```bash
npm run demo      # http://localhost:8080 y /simulator, sin cuenta de Meta
npm test          # node:test, sin dependencias
```

Ver [CONTRIBUTING.md](CONTRIBUTING.md). Agentes de IA que programan: lean [AGENTS.md](AGENTS.md).

## Créditos y licencia

Íconos de [Lucide](https://lucide.dev) (ISC). Tipografía [Quicksand](https://fonts.google.com/specimen/Quicksand) (OFL).

[MIT](LICENSE) © 2026 INTEGRALAIA SAS. WhatsApp es una marca de Meta Platforms, Inc. SieFlow Phone es un proyecto independiente, sin afiliación ni respaldo de Meta.
