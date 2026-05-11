# Implementation Plan — Dockerize RadioApp

## Goal
Containerize the Node.js radio streaming app for one-command local deployment with persistent DB, mounted audio dirs, and full ffmpeg/edge-tts support.

---

## Files to Create

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build: Node 20 + system deps + non-root user |
| `docker-compose.yml` | Single-service orchestration with volumes, env vars, healthcheck |
| `.dockerignore` | Exclude node_modules, .git, radio.db*, logs |
| `.env.example` | Document all env vars (PORT, TZ, etc.) |
| `DOCKER.md` | Deployment instructions for end users |

## Files to Modify

| File | Change |
|------|--------|
| `README.md` | Add Docker quick-start section linking to DOCKER.md |
| `.gitignore` | Add `.env` (prevent leaking keys) |

---

## Task Breakdown

### 1. Create `.dockerignore`
- **File**: `.dockerignore`
- **Content**: Exclude `node_modules`, `.git`, `radio.db`, `radio.db-shm`, `radio.db-wal`, `*.log`, `.env`, `public/news/*.mp3`, `Dockerfile`, `docker-compose.yml`
- **Acceptance**: Verify `docker build` context size is small (~few MB, not hundreds)

### 2. Create `Dockerfile`
- **File**: `Dockerfile`
- **Stages**: Single-stage with layering optimization (multi-stage not needed — runtime deps = build deps due to better-sqlite3 + edge-tts)
- **Base image**: `node:20-slim` (smaller than full, has build tools via apt)
- **System deps**:
  ```dockerfile
  RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      build-essential \
      && rm -rf /var/lib/apt/lists/*
  ```
- **Python deps**: `pip3 install --break-system-packages edge-tts`
- **App setup**:
  ```dockerfile
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci --omit=dev
  COPY . .
  ```
- **Non-root user**:
  ```dockerfile
  RUN useradd --no-create-home --shell /bin/bash radio && \
      mkdir -p /app/data /app/music && \
      chown -R radio:radio /app
  USER radio
  ```
- **Env**: `ENV PORT=6767 NODE_ENV=production`
- **Port**: `EXPOSE 6767`
- **Entry**: `CMD ["node", "server.js"]`
- **Notes**: 
  - `better-sqlite3` will compile during `npm ci` — needs python3 + build-essential present
  - DB path in `db.js` is `path.join(__dirname, 'radio.db')` which means DB lives in `/app/radio.db`. Need to point this to `/app/data/radio.db` for volume mount — but DON'T modify code. Instead, let docker-compose bind-mount the whole `/app/data` and symlink or... actually, simpler: modify db.js to respect `DB_PATH` env var, or just volume-mount the file directly.
  - **Decision needed**: Simplest path that doesn't change app code: volume-mount `./data:/app/data` and modify `db.js` to use `DB_PATH` env var with fallback. OR just mount the db file directly: `./data/radio.db:/app/radio.db`. The latter is cleaner — no code changes. But WAL mode creates `-shm` and `-wal` files. Those need mounting too. Volumes support this: mount the whole data dir.
  - **Actually**: Let's add a small env-var patch to db.js — `process.env.DB_PATH || path.join(__dirname, 'radio.db')` — so users can point DB anywhere. Default stays working for non-Docker use.

### 3. Patch `db.js` for configurable DB path
- **File**: `db.js`
- **Change**: Line 4: `const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'radio.db');`
- **Acceptance**: `DB_PATH=/tmp/test.db node -e "require('./db')"` creates DB at that path

### 4. Create `.env.example`
- **File**: `.env.example`
- **Content**:
  ```
  # RadioApp Docker Configuration
  PORT=6767
  DB_PATH=/app/data/radio.db
  TZ=UTC
  ```
- **Acceptance**: File readable, documents all vars

### 5. Create `docker-compose.yml`
- **File**: `docker-compose.yml`
- **Content**:
  ```yaml
  version: '3.8'
  services:
    radio:
      build: .
      container_name: radio-app
      ports:
        - "${PORT:-6767}:6767"
      environment:
        - PORT=${PORT:-6767}
        - DB_PATH=/app/data/radio.db
        - TZ=${TZ:-UTC}
      volumes:
        - ./data:/app/data           # DB persistence
        - ./music:/app/music:ro      # Mount music dirs (read-only)
        - ./public/news:/app/public/news  # News audio persistence
      restart: unless-stopped
      healthcheck:
        test: ["CMD", "node", "-e", "require('http').get('http://localhost:6767/',r=>{process.exit(r.statusCode===200?0:1)})"]
        interval: 30s
        timeout: 5s
        retries: 3
        start_period: 10s
  ```
- **Acceptance**: `docker compose up` starts the app, `docker compose down` stops it cleanly

### 6. Create `DOCKER.md`
- **File**: `DOCKER.md`
- **Content**: 
  - Prerequisites: Docker + Docker Compose installed
  - Quick start: `docker compose up -d`
  - Access: `http://localhost:6767`
  - Default login: `admin/admin123`
  - Adding music: Create dirs under `./music/`, add station with path `/app/music/your-dir`
  - Remote streams: Add station with stream URL directly (no dir needed)
  - AI News: Set DeepSeek API key in web UI
  - Stopping: `docker compose down`
  - Data: DB stored in `./data/`, news audio in `./public/news/`
  - Building from source: `docker compose build`
  - Troubleshooting: Check logs `docker compose logs radio`
- **Acceptance**: New user can follow steps and deploy successfully

### 7. Update `.gitignore`
- **File**: `.gitignore`
- **Add**: `.env` line
- **Acceptance**: `.env` not tracked by git

### 8. Update `README.md`
- **File**: `README.md`
- **Change**: Add Docker quick-start section after "Setup" heading, before "Prerequisites":
  ```markdown
  ## Docker (Recommended)
  
  The easiest way to run RadioApp. See [DOCKER.md](DOCKER.md) for full details.
  
  ```bash
  git clone <repo-url> radio-app
  cd radio-app
  docker compose up -d
  ```
  
  Then visit `http://localhost:6767` — default login: `admin` / `admin123`.
  ```
- **Acceptance**: Readme shows Docker as first option

---

## Dependency Order

```
1. .dockerignore        (no deps)
2. Patch db.js          (no deps)
3. .env.example         (no deps)
4. Dockerfile           (depends on .dockerignore)
5. docker-compose.yml   (depends on Dockerfile)
6. DOCKER.md            (depends on docker-compose.yml)
7. .gitignore update    (no deps)
8. README.md update     (depends on DOCKER.md)
```

---

## Risks & Considerations

### Risk 1: Native module compilation
`better-sqlite3` compiles C++ code during `npm install`. Need `build-essential`, `python3` in Docker image. Test that `npm ci` succeeds inside container. **Mitigation**: Use `node:20-slim` + apt install build-essential. The slim image includes everything needed.

### Risk 2: edge-tts availability
`edge-tts` is a Python package. If Microsoft changes their Edge TTS API, this breaks. No mitigation — it's already a runtime dependency in bare-metal setup. Docker just inherits this risk.

### Risk 3: DB path on first run
First run creates `radio.db` at `DB_PATH`. If volume is mounted but DB doesn't exist, `better-sqlite3` creates it — then seeds default admin. This works fine.

### Risk 4: WAL mode files
SQLite WAL creates `.db-shm` and `.db-wal` files. Mounting a directory volume rather than a single file avoids issues with these sidecar files.

### Risk 5: Port conflicts
Default port 6767 may be in use. Docker Compose `.env` overrides let user change via `PORT=9999 docker compose up`. The `server.js` reads `process.env.PORT` (currently hardcoded to 6767) — oh wait, it doesn't! It has `const PORT = 6767;`. **Need to patch server.js** to also read `PORT` env var.

### Risk 6: server.js hardcoded port
- **File**: `server.js`, line 12
- **Current**: `const PORT = 6767;`
- **Needed**: `const PORT = process.env.PORT || 6767;`
- **Action**: Add this patch to the plan

### Risk 7: Audio file permissions
Mounted music directories need read access for the `radio` user (UID 1000 by default in Docker). Document in DOCKER.md that music files must be world-readable or owned by the same UID.

### Risk 8: Image size
`node:20-slim` (~250MB) + ffmpeg (~50MB) + python3 + edge-tts (~20MB) = ~400MB image. Acceptable for a self-hosted app. Can optimize later with multi-stage if needed.

### Risk 9: ffmpeg in remote stream path
`player.js` spawns ffmpeg for remote streams. Need to verify ffmpeg is in PATH inside container — `apt-get install ffmpeg` handles this.

---

## Additional Patch: server.js PORT env var

**New Task 3b**: Patch `server.js` line 12: change `const PORT = 6767;` to `const PORT = process.env.PORT || 6767;`

---

## Validation Checklist (Post-Build)

- [ ] `docker compose build` succeeds
- [ ] `docker compose up -d` starts container
- [ ] `curl http://localhost:6767/` returns HTML
- [ ] Login with admin/admin123 works
- [ ] Container runs as non-root (`docker exec radio-app whoami` → `radio`)
- [ ] DB persists across `docker compose down && docker compose up`
- [ ] Music files in `./music/` are accessible when station dir = `/app/music/some-folder`
- [ ] Health check reports healthy (`docker ps` shows healthy)
- [ ] `docker compose logs` shows no errors
- [ ] Image size < 600MB

---

## Task Summary (Execution Order)

1. Create `.dockerignore`
2. Patch `db.js` — `DB_PATH` env var support
3. Patch `server.js` — `PORT` env var support
4. Create `.env.example`
5. Create `Dockerfile`
6. Create `docker-compose.yml`
7. Create `DOCKER.md`
8. Update `.gitignore` — add `.env`
9. Update `README.md` — Docker section
