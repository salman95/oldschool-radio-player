# ==================== Build Stage ====================
FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# ==================== Runtime Stage ====================
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    tini \
    && pip3 install edge-tts --break-system-packages \
    && rm -rf /var/lib/apt/lists/* \
    && (groupadd -g 1001 radio 2>/dev/null || true) \
    && (useradd -u 1001 -g radio -m -s /bin/bash radio 2>/dev/null || true) \
    && mkdir -p /app/data /app/public/news \
    && chown -R radio:radio /app

WORKDIR /app

COPY --from=build --chown=radio:radio /app/package.json /app/package-lock.json ./
COPY --from=build --chown=radio:radio /app/node_modules ./node_modules
COPY --from=build --chown=radio:radio /app/. .

ENV NODE_ENV=production
ENV PORT=6767

EXPOSE 6767

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT||6767), r=>{process.exit(r.statusCode===200?0:1)})"

ENTRYPOINT ["/usr/bin/tini", "--"]

USER radio

# --max-old-space-size=768 limits V8 heap to 768MB (75% of typical 1GB container)
# --max-semi-space-size=32 doubles young generation for short-lived audio chunks
CMD ["node", "--max-old-space-size=768", "--max-semi-space-size=32", "server.js"]
