# ==================== Build Stage ====================
FROM node:22-bookworm-slim AS build

# Toolchain is only used if better-sqlite3 has no prebuilt binary and must compile
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ==================== Runtime Stage ====================
FROM node:22-bookworm-slim AS runtime

ARG EDGE_TTS_VERSION=7.3.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    tini \
    && pip3 install --no-cache-dir --break-system-packages "edge-tts==${EDGE_TTS_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Application code stays root-owned (read-only for the app user)
COPY --from=build /app/node_modules ./node_modules
COPY . .

# Writable locations. World-writable so the container can run as any PUID/PGID
# (docker-compose sets user: to match the owner of the host ./data directory).
RUN mkdir -p /app/data /app/public/news \
    && chown node:node /app/data /app/public/news \
    && chmod 0777 /app/data /app/public/news

ENV NODE_ENV=production
ENV PORT=6767

EXPOSE 6767

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT||6767), r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]

# Built-in "node" user (uid/gid 1000) — the usual owner of ./data on a single-user Linux host
USER node

# --max-old-space-size=768 limits V8 heap to 768MB (75% of typical 1GB container)
# --max-semi-space-size=32 doubles young generation for short-lived audio chunks
CMD ["node", "--max-old-space-size=768", "--max-semi-space-size=32", "server.js"]
