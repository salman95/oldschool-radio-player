# RadioApp — Self-Hosted Internet Radio

A self-hosted internet radio player with a **Windows 98/2000 aesthetic**, built to run on any Linux server. Multiple listeners can tune in simultaneously and hear the exact same broadcast in sync — just like real radio.

> Built with assistance from **Qwen3.6** (local coding assistant) and **DeepSeek V4 Flash** (AI news generation).

---


<img width="2341" height="1158" alt="image" src="https://github.com/user-attachments/assets/c85882c7-6c25-4deb-83d9-613e3aed8fe2" />


---

## Docker (Recommended)

The easiest way to run RadioApp.

```bash
# Clone and prepare
git clone <repo-url> radio-app
cd radio-app

# Create data directories (required for persistence)
mkdir -p data music

# Copy environment config, then set PUID/PGID to the owner of ./data (`id -u`, `id -g`)
# and optionally ADMIN_PASSWORD
cp .env.example .env

# Start
docker compose up -d
```

Visit `http://localhost:6767` and log in as `admin`. The password is `ADMIN_PASSWORD` from `.env` if you set one; otherwise a random password is generated on first start and printed once in the logs:

```bash
docker compose logs radio | grep "Seeded admin"
```

The container runs as `PUID:PGID` (default `1000:1000`), which must be able to write `./data`. If the logs say `Cannot open database`, fix the ownership with `sudo chown -R "$(id -u):$(id -g)" data` or adjust `PUID`/`PGID`. News audio is kept in the `news-audio` named volume.

### Adding Music

```bash
mkdir -p music/jazz music/rock music/classical
# Copy your audio files into those directories
```

### Creating a Station

1. Click **Add Station** in the admin panel
2. Enter a station name
3. **Stream Directory** — pick a genre folder from the dropdown (e.g. `jazz`, `rock`)
4. **Sub-folder** (optional) — if the genre folder contains sub-folders (e.g. albums), pick one to narrow the station to that sub-folder. Leave blank to use the entire genre folder.
5. **Stream URL** (optional) — for remote streams (Icecast, SHOUTcast, etc.)
6. Click **OK**

The directory dropdown is populated automatically from the `music/` volume, so you never need to type a path manually.

### Changing the Port

Edit `.env` and change `PORT=6767` to your desired host port, then `docker compose up -d`. (The app always listens on 6767 inside the container.)

### Stopping

```bash
docker compose down          # stop, keep data
docker compose down -v       # stop, remove all data
```

## Features

- **Live radio streaming** — Audio is paced in real time, so all listeners hear the same broadcast together
- **WinAmp-style mini player** — Scrolling track marquee, green-on-black display, animated visualizer
- **Role-based access** — Admin can start/stop stations; listeners can only tune in/disconnect
- **Multi-station support** — Run multiple stations with different music directories
- **Interactive directory browser** — Pick music folders and sub-folders via dropdown menus instead of typing paths
- **Track shuffle** — Random playback order, re-shuffled after all tracks have played
- **FLAC/OGG/WAV/AAC transcoding** — Automatically converts to MP3 via ffmpeg for browser compatibility
- **AI News Roundup** — Optional AI-generated news segments inserted between songs (powered by DeepSeek + edge-tts)
- **Remote stream relay** — Re-broadcast an Icecast/SHOUTcast stream to your listeners
- **Mobile responsive** — Works on phones and tablets

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ |
| Database | better-sqlite3 (SQLite) |
| Streaming | Raw Node.js HTTP server (no Express) |
| Audio | ffmpeg (real-time pacing, transcoding, remote stream relay) |
| TTS | edge-tts (Microsoft Edge, free) |
| AI text | DeepSeek V4 Flash API |
| Frontend | Vanilla HTML/CSS/JS (no frameworks) |
| Styling | Windows 98/2000 aesthetic (MS Sans Serif, raised/sunken borders) |

---

## Setup

### Prerequisites

- Node.js 20+
- ffmpeg (required for playback)
- Python 3 + pip3 (for edge-tts TTS)

### Installation

```bash
git clone <repo-url> /root/radio-app
cd /root/radio-app
npm install
pip3 install edge-tts --break-system-packages
```

### Start

```bash
node server.js
```

The app runs on **port 6767** at `http://0.0.0.0:6767`.

Environment variables (all optional): `PORT`, `DB_PATH`, `MUSIC_DIR` (default `./music`), `ADMIN_PASSWORD`, `DEEPSEEK_API_KEY`, `APP_SECRET`, `COOKIE_SECURE` — see `.env.example`.

### Auto-start (systemd)

Create `/etc/systemd/system/radio-app.service`:

```ini
[Unit]
Description=RadioApp
After=network.target

[Service]
WorkingDirectory=/root/radio-app
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then `systemctl enable --now radio-app`.

---

## Accounts

On first start a single `admin` account is created, using `ADMIN_PASSWORD` if set or a random password printed once in the log. Change passwords with **Password** in the menu bar; admins can set other users' passwords from the **Users** screen. Passwords must be at least 8 characters.

After 10 failed logins for the same username from the same IP, further attempts are refused for 15 minutes.

---

## API Overview

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/login` | POST | Authenticate and get session cookie |
| `/api/account/password` | POST | Change your own password |
| `/api/users/:id/password` | PATCH | Set a user's password (admin) |
| `/api/music-dirs` | GET | List top-level music folders (admin) |
| `/api/subdirs/:path` | GET | List sub-folders of a given path (admin) |
| `/api/stations` | GET | List all stations |
| `/api/stations/:id/play` | POST | Start broadcasting (admin) |
| `/api/stations/:id/stop` | POST | Stop broadcasting (admin) |
| `/api/stations/:id/status` | GET | Current track, listener count |
| `/stream?station_id=:id` | GET | Live MP3 audio stream (login required) |
| `/api/ai-news/key` | POST | Save DeepSeek API key (admin) |
| `/api/ai-news/generate` | POST | Generate news segment (admin) |
| `/api/ai-news/toggle` | POST | Enable/disable news (admin) |
| `/api/ai-news/interval` | POST | Set songs between news segments (admin) |

---

## Audio Formats

| Format | Support |
|--------|---------|
| MP3 | Streamed as-is (no re-encoding) |
| FLAC, OGG, Opus, WAV, WMA, AAC/M4A, WebM | Transcoded to MP3 via ffmpeg |
| Remote streams (http/https) | Relayed and transcoded to 128 kbps MP3 |

---

## AI News Feature

1. Add a DeepSeek API key in the **AI News** admin tab
2. Click **Generate News** — calls DeepSeek V4 Flash for 2 AI story summaries, then converts to speech via edge-tts
3. Click **Enable News** — after every 10 songs (configurable), all stations will play the 30-60 second news segment

The API key is stored encrypted in the database (or provide it with `DEEPSEEK_API_KEY`).

Cost: ~$0.0001 per generation (DeepSeek V4 Flash at $0.14/million tokens).

---

## Project Structure

```
/root/radio-app/
├── server.js          # HTTP server, API routes
├── player.js          # Audio streaming engine
├── db.js              # SQLite database
├── scanner.js         # Audio file scanner
├── ai-news.js         # AI news generation
├── public/
│   ├── index.html     # Main UI
│   ├── css/style.css  # Windows 98 styles
│   └── js/app.js      # Frontend logic
└── package.json
```

---

## License

MIT
