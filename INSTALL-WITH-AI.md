# Instalar SieFlow Phone con un agente de IA

**Español** · [English](INSTALL-WITH-AI.en.md)

Esta guía está escrita para agentes de IA (Claude Code, Codex, Cursor, Copilot, Gemini CLI...) a los que una persona les pide instalar SieFlow Phone en un servidor. También la puede seguir una persona: cada paso es un comando de terminal.

**Mensaje para darle a tu agente:**

> Instala SieFlow Phone en este servidor siguiendo https://raw.githubusercontent.com/IntegraLaIA/sieflow-phone/main/INSTALL-WITH-AI.md

El resultado: SieFlow Phone corriendo en Docker detrás de HTTPS en tu dominio, y un código de configuración de un solo uso. Después la persona abre el sitio y termina la configuración guiada (app de Meta, webhook, llamadas y equipo) en el navegador.

## Reglas para el agente

1. **Habla en el idioma de la persona.** Si escribe en español, responde en español.
2. **Pregunta antes** de instalar software, usar `sudo`, abrir puertos en el firewall, detener servicios que usen los puertos 80/443 o tocar una instalación existente.
3. **Nunca muestres secretos** (token de acceso de Meta, App Secret, secreto de TURN) en el chat ni en la salida de un comando. Escríbelos solo en `.env` y déjalo en modo `600`.
4. **Nunca pongas `DEMO_MODE=true`** en un servidor al que se llega desde internet.
5. **Usa la última versión publicada** y fíjala en `.env` (`SIEFLOW_PHONE_VERSION`), para que las actualizaciones sean deliberadas.
6. Si un paso falla dos veces, detente y reporta el comando exacto y su salida en vez de improvisar.

## 1. Pídele a la persona

| Dato | Obligatorio | Ejemplo |
| --- | --- | --- |
| Dominio con un registro DNS A/AAAA apuntando a este servidor | sí | `telefono.tuempresa.com` |
| HTTPS: el Caddy incluido (recomendado) o un proxy inverso que ya exista | sí | Caddy incluido |
| Carpeta de instalación | no | `/opt/sieflow-phone` |
| Operadores detrás de firewalls estrictos que bloquean UDP (necesita TURN) | no | no |

Las credenciales de Meta **no** hacen falta ahora: la persona las escribe en la configuración guiada, que verifica cada dato en vivo. Si prefiere variables de entorno, ver el paso 4.

## 2. Revisa el servidor

```bash
uname -sm
docker --version && docker compose version
```

- Se necesita Docker Engine 24 o superior con el plugin de Compose (v2.24 o superior). Si falta, pregúntale a la persona e instálalo con la guía oficial: https://docs.docker.com/engine/install/
- Funciona en Linux con amd64 o arm64. Con 1 vCPU y 1 GB de RAM sobra.

Con el Caddy incluido, los puertos 80 y 443 deben estar libres y abiertos desde internet:

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
```

Comprueba que el dominio apunte aquí (los dos comandos deben mostrar la misma dirección):

```bash
curl -fsS https://api.ipify.org; echo
getent ahosts telefono.tuempresa.com | awk 'NR==1 {print $1}'
```

## 3. Descarga los archivos de la versión

```bash
VERSION="$(curl -fsS https://api.github.com/repos/IntegraLaIA/sieflow-phone/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')"
echo "Instalando SieFlow Phone $VERSION"
sudo mkdir -p /opt/sieflow-phone && sudo chown "$USER" /opt/sieflow-phone && cd /opt/sieflow-phone
curl -fsSLO "https://raw.githubusercontent.com/IntegraLaIA/sieflow-phone/v$VERSION/docker-compose.yml"
curl -fsSLO "https://raw.githubusercontent.com/IntegraLaIA/sieflow-phone/v$VERSION/Caddyfile"
```

## 4. Configura

```bash
cat > .env <<EOF
DOMAIN=telefono.tuempresa.com
SIEFLOW_PHONE_VERSION=$VERSION
EOF
chmod 600 .env
```

Líneas opcionales para `.env` (cada una también se puede definir después en el navegador; las que se definan aquí aparecen allí como de solo lectura):

```bash
# App de Meta, si la persona te dio los valores
WA_APP_ID=...
WA_APP_SECRET=...
WA_ACCESS_TOKEN=...
WA_WABA_ID=...
WA_PHONE_NUMBER_ID=...
# Un código de configuración fijo en vez de uno aleatorio
SETUP_CODE=...
```

## 5. Arranca

Con el Caddy incluido (saca un certificado de Let's Encrypt automáticamente):

```bash
docker compose --profile https up -d
```

Con un proxy inverso que ya exista, arranca solo la aplicación y apunta el proxy a `http://127.0.0.1:8080`:

```bash
docker compose up -d
```

La aplicación usa Server-Sent Events, así que el proxy no debe almacenar en búfer las respuestas. Para nginx:

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

## 6. Verifica

```bash
docker compose ps
curl -fsS http://127.0.0.1:8080/healthz; echo
curl -fsSI "https://telefono.tuempresa.com/" | head -n 5
```

Lo esperado: el servicio `sieflow-phone` aparece `healthy`, `/healthz` responde `{"ok":true,"version":"..."}` y el dominio responde `HTTP/2 200` con la cabecera `strict-transport-security`. Caddy puede tardar hasta un minuto en sacar el primer certificado.

## 7. Entrégaselo a la persona

```bash
docker compose logs sieflow-phone | grep -m1 "Setup code"
```

Entrégale a la persona:

1. La URL `https://telefono.tuempresa.com`.
2. El código de configuración (es de un solo uso: quien lo use primero queda como administrador).
3. Lo que le va a pedir la configuración guiada: el App ID y el App Secret de Meta, un token permanente de usuario del sistema con `whatsapp_business_messaging` y `whatsapp_business_management`, y después el webhook (lo puede configurar en Meta automáticamente), las llamadas y el equipo.

Requisitos del lado de Meta que debe conocer: el número tiene que estar en la Cloud API de WhatsApp (no compartido con la app de WhatsApp Business), con un límite de mensajería de 2.000 o más para llamar, y con las llamadas por SIP apagadas.

## Opcional: TURN para redes estrictas

Solo si algunos operadores están detrás de firewalls que bloquean el UDP de salida:

```bash
echo "TURN_SECRET=$(openssl rand -hex 32)" >> .env
echo "TURN_URLS=turn:telefono.tuempresa.com:3478?transport=udp,turn:telefono.tuempresa.com:3478?transport=tcp" >> .env
docker compose --profile https --profile turn up -d
```

Abre en el firewall UDP y TCP 3478 y UDP 49160-49200 (pregunta primero).

## Actualizar

```bash
cd /opt/sieflow-phone
sed -i "s/^SIEFLOW_PHONE_VERSION=.*/SIEFLOW_PHONE_VERSION=NUEVA_VERSION/" .env
docker compose --profile https pull && docker compose --profile https up -d
```

Lee primero el [registro de cambios](CHANGELOG.md). Las migraciones de la base de datos corren al arrancar.

## Respaldo y restauración

Todo (ajustes, operadores, conversaciones) está en el volumen `sieflow-phone_sieflow-phone-data`:

```bash
docker compose stop sieflow-phone
docker run --rm -v sieflow-phone_sieflow-phone-data:/data -v "$PWD":/backup alpine \
  tar czf "/backup/sieflow-phone-$(date +%F).tgz" -C /data .
docker compose start sieflow-phone
```

El archivo contiene el token de acceso de WhatsApp: guárdalo como un secreto. Para restaurar, descomprímelo en un volumen vacío con el servicio detenido.

## Desinstalar

```bash
docker compose --profile https --profile turn down      # conserva el volumen de datos
docker volume rm sieflow-phone_sieflow-phone-data       # borra todos los datos, pregunta primero
```

## Solución de problemas

| Síntoma | Qué revisar |
| --- | --- |
| No hay certificado y Caddy muestra errores de ACME | Que el DNS apunte a este servidor, que los puertos 80/443 estén abiertos y que ningún otro servicio los use. |
| La página carga pero "Reconectando" no termina | El proxy inverso almacena el SSE en búfer: desactívalo (ver nginx arriba). |
| Meta no puede verificar el webhook | La URL debe ser HTTPS pública y terminar en `/webhook`; el token de verificación debe coincidir con el que muestra la configuración guiada. |
| Las llamadas timbran pero no hay audio | La red del operador bloquea UDP: activa TURN. El teléfono muestra el estado del enlace de audio durante la llamada. |
| Se perdió el código de configuración | `docker compose restart sieflow-phone` imprime uno nuevo mientras no exista un administrador. |
