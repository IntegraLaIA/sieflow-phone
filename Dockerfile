# syntax=docker/dockerfile:1
# SieFlow Phone has no dependencies: the image is Node plus the source.
# Pinned by digest; Dependabot proposes updates.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# Links the GHCR package to the repository (local builds too) and fills in its details.
LABEL org.opencontainers.image.source="https://github.com/IntegraLaIA/sieflow-phone" \
      org.opencontainers.image.url="https://phone.sieflow.ai" \
      org.opencontainers.image.title="SieFlow Phone" \
      org.opencontainers.image.description="Self-hosted WhatsApp calls and chat for teams" \
      org.opencontainers.image.vendor="INTEGRALAIA SAS" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    UV_THREADPOOL_SIZE=8

WORKDIR /app
COPY package.json LICENSE ./
COPY src ./src
COPY public ./public

# Nothing is installed at runtime, so the package managers can go.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn* /opt/yarn* \
 && mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# node:sqlite still prints an experimental warning on start; it is stable enough here.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
