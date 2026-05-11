# RadioApp — Docker Deployment Guide

## Prerequisites

- Docker Engine installed
- Docker Compose plugin (`docker compose`)

## Quick Start

```bash
# Clone and enter
git clone <repo-url> radio-app
cd radio-app

# Create required directories
mkdir -p data music

# Copy env and start
cp .env.example .env
docker compose up -d
```

Visit `http://localhost:6767` — default login: `admin` / `admin123`.

## Adding Local Music

### If your music is on a local disk:

```bash
mkdir -p music/jazz music/rock music/classical
# Copy your audio files into those directories
```

Then update `docker-compose.yml` to mount your music directory:
```yaml
volumes:
  - ./music:/app/music:ro
```

Then in the app UI, add a station with:
- **Name:** e.g. "Smooth Jazz FM"
- **Stream Directory:** `/app/music/jazz/`

The app scans the directory recursively for audio files.

### If your music is on a remote mount (rclone, NFS, etc.):

Update `docker-compose.yml` to mount the **actual mount path** (not a local directory):
```yaml
volumes:
  - /path/to/your/mount:/app/music:ro
```

Then restart: `docker compose down && docker compose up -d`.

In the app UI, use **container paths** (not host paths):
- **Stream Directory:** `/app/music/your-folder/`

> **Important:** The Stream Directory must use the path **inside the container** (`/app/music/...`), not the host path (`/mnt/...` or wherever rclone mounts). The container doesn't see your host's mount points.

## Adding Remote Streams

In the app UI, add a station with:
- **Name:** e.g. "Classic Rock 101"
- **Stream URL:** `https://stream.example.com/live.mp3`

## AI News

1. Open the AI News tab (admin only)
2. Enter your DeepSeek API key
3. Click "Generate News"
4. Toggle "Enable News" to insert news segments during playback

## Managing the Container

```bash
# View logs
docker compose logs -f radio

# Stop
docker compose down

# Start again (keeps data)
docker compose up -d

# Clean rebuild (no cache)
docker compose build --no-cache
docker compose up -d
```

## Data Persistence

| Data | Location |
|------|----------|
| Database | `./data/radio.db` |
| News audio | Docker volume `news-audio` |
| Music files | `./music/` (bind mount, read-only in container) |

## Troubleshooting

**App won't start:**
```bash
docker compose logs radio
```

**Permission errors on music files:**
- Music bind mount is `:ro` — the app only reads from it, no write needed.
- Ensure audio files exist before scanning.

**DB corruption:**
- Stop container, back up `./data/radio.db`, restart.

**Port conflict:**
- Edit `.env` and change `PORT=6767` to another port, then `docker compose up -d`.

**Reset everything:**
```bash
docker compose down -v
rm -rf data
docker compose up -d
```
