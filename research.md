# Research: Docker Best Practices for Containerizing Node.js Radio Player App

## Summary

Use Debian-slim base image (`node:22-bookworm-slim`) not Alpine — better-sqlite3 native module and edge-tts (Python) both fight musl libc on Alpine, causing `invalid ELF header` and build failures. Multi-stage build: one stage for native module compilation + Python/edge-tts install, final stage minimal with only runtime deps. Mount two volumes: one for SQLite db, one for audio output files. Use `dumb-init` to fix PID 1 signal handling for ffmpeg subprocesses. Drop all capabilities (`--cap-drop=ALL`), run as non-root `node` user, set `NODE_ENV=production`, add health check hitting Express endpoint.

---

## Findings

### 1. Base Image: Debian-slim, Not Alpine

Alpine (musl libc) causes subtle breakage with `better-sqlite3` prebuilt binaries — "invalid ELF header" errors at runtime because `.node` native addons compiled against glibc can't load against musl. [Source](https://stackoverflow.com/questions/78253744/dockerfile-for-sqlite3-solving-the-error-with-better-sqlite3) Alpine also lacks `gcc`, `make`, `python3` by default, requiring `apk add build-base` to compile native modules, bloating the image. [Source](https://stackrant.com/posts/nodejs-alpine-vs-debian-performance-differences)

**Recommendation:** Use `node:22-bookworm-slim` (Debian 12 slim). 120MB vs Alpine's 50MB but zero libc conflict risk. If minimizing size matters, use `node:22-alpine` only if you set `SQLITE_THREADSAFE=1` and compile `better-sqlite3` from source in the build stage — but this adds CI time. [Source](https://www.minimus.io/post/choosing-the-best-node-js-docker-image)

### 2. Multi-Stage Build Strategy

3-stage pattern works best:

1. **build-deps** — `node:22-bookworm-slim` with `build-essential`, `python3`, `gcc`. Runs `npm ci` to compile `better-sqlite3` native addon.
2. **python-deps** — Install `edge-tts` via `pip` in a Python-slim stage, copy site-packages to final.
3. **production** — Fresh `node:22-bookworm-slim`. Copy compiled `node_modules` from build stage, Python site-packages from python stage, app code.

Prevents build tools in final image, reduces attack surface. [Source](https://snyk.io/blog/10-best-practices-to-containerize-nodejs-web-applications-with-docker/)

Alternatively, 2-stage is fine if Python/edge-tts is installed in the same build stage as native module compilation, with `npm ci --omit=dev` in final copy.

### 3. ffmpeg in Docker

**Install directly via apt** in the final stage:
```
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
```
Do NOT use `jrottenberg/ffmpeg` as base — it's a huge image built for ffmpeg itself, not for running Node.js apps. The "copy ffmpeg from jrottenberg" trick (`COPY --from=jrottenberg/ffmpeg / /`) works but copies 300MB+ of unnecessary libs. [Source](https://gist.github.com/aberba/828601be2c7612ce03db38701951a37c)

**Key gotchas:**
- `fluent-ffmpeg` looks for `ffmpeg` in `PATH` or honors `FFMPEG_PATH` env var. On Debian apt install, ffmpeg lands in `/usr/bin/ffmpeg` — auto-detected. [Source](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg)
- ffmpeg spawned via `child_process.spawn()` — Node.js is PID 1. Use `dumb-init` or `tini` to handle signals properly, otherwise `SIGTERM` (docker stop) won't reach ffmpeg child processes. [Source](https://oneuptime.com/blog/post/2026-01-16-docker-graceful-shutdown-signals/view)
- ffmpeg writes audio output to disk — ensure output directory exists and is writable by the non-root user.
- ffmpeg needs `--cap-drop=ALL` safe — it only needs filesystem write access to mounted volume, no special capabilities.

### 4. edge-tts in Docker

**Two viable approaches:**

**A. Python subprocess (current project pattern):** Install Python + edge-tts via pip in the image. Node.js spawns `edge-tts` CLI as child process. Requires Python 3.8+ in the image.

```
# In Dockerfile, after Node install:
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && \
    pip3 install edge-tts --break-system-packages && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
```
[Source](https://pypi.org/project/edge-tts/)

**B. Pure Node.js alternative:** Use `@edge-tts/universal` npm package (v1.4.0) — a TypeScript port of edge-tts with zero Python dependency. Eliminates the need for Python in the image entirely. Works in Node.js, Deno, Bun. [Source](https://jsr.io/@edge-tts/universal)

**Recommendation:** Switch to `@edge-tts/universal` if feasible — eliminates Python dependency, reduces image size, removes subprocess orchestration complexity. If staying with Python subprocess, add `--break-system-packages` flag for pip on Debian 12+.

**Gotchas:**
- edge-tts requires internet access (calls Microsoft Edge TTS API). Ensure container has outbound HTTPS access.
- edge-tts generates .mp3/.srt files — same volume mount considerations as ffmpeg.
- Python subprocess approach: same PID 1 / signal handling concerns as ffmpeg.

### 5. Volume Mount Patterns for Persistence

Mount two host bind volumes or named volumes:

| Volume | Container Path | Purpose |
|--------|---------------|---------|
| `./data/db` | `/app/data` | SQLite database file(s) |
| `./data/audio` | `/app/public/audio` | Generated audio files served as static |

**SQLite specifics:**
- SQLite WAL mode works fine across container restarts if DB file lives on a bind mount or named volume. [Source](https://oneuptime.com/blog/post/2026-02-08-how-to-run-sqlite-in-docker-when-and-how/view)
- Do NOT declare `VOLUME` in Dockerfile — it makes later overrides impossible and can cause orphaned anonymous volumes. Mount at `docker run` or in `docker-compose.yml` instead. [Source](https://stackoverflow.com/questions/57813439/how-can-i-run-my-node-js-process-with-a-permanent-sqlite-database)
- Ensure the non-root user owns the mount point. Create dir in Dockerfile with `RUN mkdir -p /app/data /app/public/audio && chown -R node:node /app/data /app/public/audio`.
- SQLite file locking works correctly on bind mounts. No NFS/network volume for SQLite (file locking breaks).

**Performance note:** Audio transcoding writes can be large. Use bind mount (fast) not a Docker volume driver over network.

### 6. .dockerignore Best Practices

```
node_modules/
npm-debug.log
.git/
.gitignore
.env
.env.*
!.env.example
dist/
build/
.next/
coverage/
*.md
.DS_Store
docker-compose*.yml
.dockerignore
```

This prevents secrets leaking, reduces build context size, and avoids `node_modules` from host conflicting with container install. [Source](https://dev.to/nodepractices/docker-best-practices-with-node-js-4ln4)

### 7. Health Checks

**Dockerfile HEALTHCHECK instruction:**
```
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node healthcheck.js
```

**healthcheck.js** (lightweight, no external deps):
```js
const http = require('http');
const options = {
  host: 'localhost',
  port: process.env.PORT || 3000,
  path: '/health',
  timeout: 4000
};
const req = http.get(options, (res) => {
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.end();
```

Add a GET `/health` route in Express that returns `{ status: 'ok' }` and optionally checks SQLite is responsive (`db.pragma('journal_mode')`). Do NOT use `wget` or `curl` — they may not be installed in slim image. [Source](https://oneuptime.com/blog/post/2026-01-06-docker-health-checks/view)

### 8. Security Considerations

**Non-root user:**
- The official Node images ship with `node` user (UID 1000). Switch with `USER node`.
- If `node` user doesn't exist in slim variants, create it:
  ```
  RUN addgroup --system --gid 1001 nodejs && \
      adduser --system --uid 1001 --ingroup nodejs appuser
  ```
  [Source](https://dev.to/axiom_agent/dockerizing-nodejs-for-production-the-complete-2026-guide-7n3)

**Capabilities:**
```
docker run --cap-drop=ALL --cap-add=NET_BIND_SERVICE ...
```
Node.js web server only needs `NET_BIND_SERVICE` to bind to ports <1024. If binding to port 3000+ (no privileged port), drop all capabilities: `--cap-drop=ALL`. [Source](https://oneuptime.com/blog/post/2026-01-16-docker-drop-capabilities/view)

**Read-only filesystem:**
```
--read-only --tmpfs /tmp:size=64M --tmpfs /app/data:size=256M
```
Make root filesystem read-only, mount tmpfs for writable temp. Only the data volume needs writes. [Source](https://eastondev.com/blog/en/posts/dev/20251218-docker-security-nonroot/)

**Additional hardening:**
- `npm ci --only=production` in final stage — no devDependencies in runtime.
- No `.env` files in image; use Docker secrets or env vars at runtime.
- Pin specific base image digest (`node:22-bookworm-slim@sha256:...`) for reproducibility.
- Consider `dumb-init` as ENTRYPOINT for proper signal handling (especially with ffmpeg subprocesses). [Source](https://snyk.io/blog/10-best-practices-to-containerize-nodejs-web-applications-with-docker/)

### 9. Environment Variable Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `NODE_ENV` | Express production mode | `production` |
| `PORT` | HTTP server port | `3000` |
| `HOST` | Bind address | `0.0.0.0` |
| `DB_PATH` | SQLite file location | `/app/data/radio.db` |
| `AUDIO_DIR` | Audio output directory | `/app/public/audio` |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `EDGE_TTS_VOICE` | Default TTS voice | `en-US-GuyNeural` |

Set `NODE_ENV=production` in Dockerfile's `ENV` to optimize Express for production (view caching, error handling). Do NOT hardcode secrets — pass at runtime via `--env-file` or Docker secrets.

### 10. Docker Compose Pattern

```yaml
# docker-compose.yml (omit version: — deprecated since Docker Compose v2)
services:
  radio:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${PORT:-3000}:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
      - DB_PATH=/app/data/radio.db
      - AUDIO_DIR=/app/public/audio
      - LOG_LEVEL=${LOG_LEVEL:-info}
    env_file:
      - .env
    volumes:
      - ./data/db:/app/data
      - ./data/audio:/app/public/audio
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:size=64M
    user: "1001:1001"
    healthcheck:
      test: ["CMD", "node", "healthcheck.js"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    restart: unless-stopped
```

**Development override** (`docker-compose.override.yml`):
```yaml
services:
  radio:
    environment:
      - NODE_ENV=development
      - LOG_LEVEL=debug
    volumes:
      - .:/app          # live code reload
      - /app/node_modules  # don't override container node_modules
    read_only: false
    user: root
```
[Source](https://oneuptime.com/blog/post/2026-01-25-docker-compose-development-environments/view)

### 11. better-sqlite3 Docker Gotchas

- **"invalid ELF header"** — The `.node` binary is platform-specific. If you install `better-sqlite3` on an M1 Mac (arm64) and copy `node_modules` into an x86_64 container, the ELF binary won't match. **Fix:** Always run `npm ci` inside the Docker build (on the target architecture). Use `COPY package.json` first, then `RUN npm ci`, then copy source. [Source](https://github.com/WiseLibs/better-sqlite3/issues/493)
- **Prebuild detection:** `better-sqlite3` ships prebuilt binaries for common platforms (linux-x64, linux-arm64, darwin-x64, etc.). If your arch matches, no compiler needed. If not (e.g., linux-armv7 or custom musl), it falls back to compiling from source requiring `build-essential` + `python3`. [Source](https://github.com/WiseLibs/better-sqlite3/issues/1411)
- **fcntl64 symbol not found** — Common on old Alpine or misconfigured libc. Switching to Debian-slim eliminates this. [Source](https://forum.strapi.io/t/error-relocating-better-sqlite3-node-fcntl64-symbol-not-found-when-building-docker-image/24782)
- **WAL mode + Docker:** SQLite WAL mode creates `-wal` and `-shm` files alongside the DB. These persist correctly on Docker volumes but can cause "database is locked" if the container is killed without WAL checkpoint. Use `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;` for resilience. [Source](https://oneuptime.com/blog/post/2026-02-08-how-to-run-sqlite-in-docker-when-and-how/view)

### 12. ffmpeg Docker Gotchas

- **`/dev/random` blocking:** ffmpeg may block waiting for entropy. Ensure container has `--privileged`? No — use `haveged` package or mount `/dev/urandom` instead. On modern kernels, this is rarely an issue.
- **Temp space:** ffmpeg may write large temp files to `/tmp`. Set `tmpfs` size generously (256MB+) or mount a volume for temp.
- **Codec availability:** `apt-get install ffmpeg` on Debian ships most common codecs (libmp3lame, aac, etc.) but NOT `libfdk-aac` (non-free). For mp3 encoding, it's fine. If you need proprietary codecs, use `johnvansickle/ffmpeg` static builds or `jrottenberg/ffmpeg` as a multi-stage copy source.
- **GPU acceleration:** Not needed for audio-only transcoding. CPU works fine.

### 13. edge-tts Docker Gotchas

- **Internet required:** edge-tts calls Microsoft's online TTS API — no internet = no speech. Consider a fallback local TTS (e.g., `espeak`) if offline operation is needed.
- **Rate limiting:** Microsoft Edge TTS API may throttle if too many rapid requests. Implement a queue or delay between calls in Node.js.
- **Python version:** edge-tts requires Python 3.8+. Debian 12 ships Python 3.11. Alpine may ship Python 3.12. Works on both.
- **`--break-system-packages`:** On Debian 12 (bookworm), pip refuses to install system-wide without this flag (PEP 668). Either add the flag or install in a venv. For Docker, `--break-system-packages` is the simplest approach since the container is ephemeral. [Source](https://stackoverflow.com/questions/77189381/docker-multi-stage-build-package-unrecognized)
- **Node.js native alternative:** `@edge-tts/universal` (npm) eliminates Python entirely. As of v1.4.0, it has feature parity with the Python edge-tts library. Strongly consider this for simpler Docker setup. [Source](https://jsr.io/@edge-tts/universal)

---

## Sources

### Kept
- **Snyk — 10 best practices to containerize Node.js web applications with Docker** — Definitive Node.js Docker guide: multi-stage builds, dumb-init, non-root user, npm ci. [Source](https://snyk.io/blog/10-best-practices-to-containerize-nodejs-web-applications-with-docker/)
- **Minimus — Choosing the best Node.js Docker image** — Alpine vs Debian comparison for native modules. [Source](https://www.minimus.io/post/choosing-the-best-node-js-docker-image)
- **StackRant — Node.js on Alpine vs Debian: Performance differences** — Deep analysis of musl vs glibc issues with Node.js native addons. [Source](https://stackrant.com/posts/nodejs-alpine-vs-debian-performance-differences)
- **GitHub — better-sqlite3 #493: invalid ELF header** — Key issue showing platform mismatch in Docker. [Source](https://github.com/WiseLibs/better-sqlite3/issues/493)
- **Stack Overflow — Dockerfile for sqlite3 solving error with better-sqlite3** — Docker build solutions for native SQLite module. [Source](https://stackoverflow.com/questions/78253744/dockerfile-for-sqlite3-solving-the-error-with-better-sqlite3)
- **OneUptime — How to Run SQLite in Docker** — SQLite volume persistence, WAL mode, locking patterns. [Source](https://oneuptime.com/blog/post/2026-02-08-how-to-run-sqlite-in-docker-when-and-how/view)
- **OneUptime — Docker Health Checks** — Node.js healthcheck implementation with HTTP. [Source](https://oneuptime.com/blog/post/2026-01-06-docker-health-checks/view)
- **OneUptime — Docker Drop Capabilities** — Capability dropping patterns for secure containers. [Source](https://oneuptime.com/blog/post/2026-01-16-docker-drop-capabilities/view)
- **OneUptime — Docker Graceful Shutdown Signals** — PID 1 problem, dumb-init, signal handling for subprocesses. [Source](https://oneuptime.com/blog/post/2026-01-16-docker-graceful-shutdown-signals/view)
- **GitHub Gist — Node.js Docker with ffmpeg** — Working example of multi-stage ffmpeg + Node.js. [Source](https://gist.github.com/aberba/828601be2c7612ce03db38701951a37c)
- **GitHub — fluent-ffmpeg README** — FFMPEG_PATH env var, PATH detection. [Source](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg)
- **PyPI — edge-tts** — Python package docs, CLI usage, requirements. [Source](https://pypi.org/project/edge-tts/)
- **JSR — @edge-tts/universal** — Pure TypeScript edge-tts port, Node.js native alternative. [Source](https://jsr.io/@edge-tts/universal)
- **Strapi Forum — fcntl64 symbol not found better-sqlite3** — Alpine-specific linking error. [Source](https://forum.strapi.io/t/error-relocating-better-sqlite3-node-fcntl64-symbol-not-found-when-building-docker-image/24782)
- **BetterLink Blog — Docker non-root security** — Read-only fs, tmpfs, user namespace patterns. [Source](https://eastondev.com/blog/en/posts/dev/20251218-docker-security-nonroot/)
- **Talent500 — Modern Docker Best Practices 2025** — Deprecated `version:` field, healthcheck necessity, .dockerignore. [Source](https://talent500.com/blog/modern-docker-best-practices-2025/)

### Dropped
- **DEV.to generic Docker Node.js articles** — Duplicative content already covered by Snyk/OneUptime sources.
- **Old Stack Overflow threads (pre-2022)** — Outdated Alpine/musl advice, no `--break-system-packages` awareness.
- **jrottenberg/ffmpeg Docker Hub** — Not useful as a base image for Node.js apps; only relevant as multi-stage copy source.
- **Medium Docker blogspam** — Thin content, no citations, mostly introductory.

---

## Gaps

1. **edge-tts rate limiting specifics** — No reliable public data on Microsoft Edge TTS API rate limits. Suggest implementing a configurable request queue with 500ms minimum delay between calls, and monitoring for HTTP 429 responses.
2. **SQLite WAL + Docker crash recovery** — No definitive guidance on what happens to WAL files when container is killed. Recommend adding `PRAGMA journal_mode=TRUNCATE` as fallback if WAL corruption is observed.
3. **Multi-arch builds** — Research needed for building this stack for arm64 (Raspberry Pi) in CI. `better-sqlite3` has prebuilds for arm64 but edge-tts Python deps are architecture-agnostic.
4. **Static file streaming performance** — If the app streams large audio files, consider Nginx reverse proxy in a separate container for sendfile/X-Accel-Redirect. Not researched here as it's a deployment topology decision.

---

## Supervisor coordination

No supervisor contact needed. All information gathered. Ready to proceed with Dockerfile and docker-compose.yml implementation.
