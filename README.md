# RadioApp — Self-Hosted Internet Radio

A self-hosted internet radio player with a **Windows 98/2000 aesthetic**, built to run on any Linux server. Multiple listeners can tune in simultaneously and hear the exact same broadcast in sync — just like real radio.

> Built with assistance from **Qwen3.6** (local coding assistant) and **DeepSeek V4 Flash** (AI news generation).

---


<img width="2341" height="1158" alt="image" src="https://github.com/user-attachments/assets/c85882c7-6c25-4deb-83d9-613e3aed8fe2" />


---

## Docker (Recommended)

The easiest way to run RadioApp. See [DOCKER.md](DOCKER.md) for full details.

```bash
# Clone and prepare
git clone <repo-url> radio-app
cd radio-app

# Create data directories (required for persistence)
mkdir -p data music news-audio

# Copy environment config
cp .env.example .env

# Start
docker compose up -d
```

Visit `http://localhost:6767` — default login: `admin` / `admin123`.

### Adding Music

```bash
mkdir -p music/jazz music/rock music/classical
# Copy your audio files into those directories
```

In the app UI, add a station with **Stream Directory** set to `/app/music/jazz/`.

### Changing the Port

Edit `.env` and change `PORT=6767` to your desired port, then `docker compose up -d`.

### Stopping

```bash
docker compose down          # stop, keep data
docker compose down -v       # stop, remove all data
```

## Features

- **Live radio streaming** — All listeners hear identical audio simultaneously (byte-for-byte sync)
- **WinAmp-style mini player** — Scrolling track marquee, green-on-black display, animated visualizer
- **Role-based access** — Admin can start/stop stations; listeners can only tune in/disconnect
- **Multi-station support** — Run multiple stations with different music directories
- **Track shuffle** — Random playback order, re-shuffled after all tracks have played
- **FLAC/OGG/WAV transcoding** — Automatically converts to MP3 via ffmpeg for browser compatibility
- **AI News Roundup** — Optional AI-generated news segments inserted between songs (powered by DeepSeek + edge-tts)
- **Persistent state** — Stations that were playing before a restart automatically resume
- **Mobile responsive** — Works on phones and tablets

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ |
| Database | better-sqlite3 (SQLite) |
| Streaming | Raw Node.js HTTP server (no Express) |
| Audio parsing | ffmpeg (for FLAC/OGG/WAV transcoding) |
| TTS | edge-tts (Microsoft Edge, free) |
| AI text | DeepSeek V4 Flash API |
| Frontend | Vanilla HTML/CSS/JS (no frameworks) |
| Styling | Windows 98/2000 aesthetic (MS Sans Serif, raised/sunken borders) |

---

## Setup

### Prerequisites

- Node.js 20+
- ffmpeg (for FLAC/OGG/WAV support)
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

### Auto-start (systemd)

```bash
cp radio-app.service /etc/systemd/system/
systemctl enable radio-app
systemctl start radio-app
```

---

## Default Credentials

| Username | Password | Role |
|----------|----------|------|
| `admin` | `admin123` | Administrator |
| `alice` | `secret` | Listener |

---

## API Overview

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/login` | POST | Authenticate and get session cookie |
| `/api/stations` | GET | List all stations |
| `/api/stations/:id/play` | POST | Start broadcasting (admin) |
| `/api/stations/:id/stop` | POST | Stop broadcasting (admin) |
| `/api/stations/:id/status` | GET | Current track, listener count |
| `/stream?station_id=:id` | GET | Live MP3 audio stream |
| `/api/ai-news/key` | POST | Save DeepSeek API key (admin) |
| `/api/ai-news/generate` | POST | Generate news segment (admin) |
| `/api/ai-news/toggle` | POST | Enable/disable news (admin) |

---

## Audio Formats

| Format | Support |
|--------|---------|
| MP3 | Native, streamed directly |
| AAC/M4A | Streamed directly |
| FLAC | Transcoded to MP3 via ffmpeg |
| OGG, WAV, WMA | Transcoded to MP3 via ffmpeg |

---

## AI News Feature

1. Add a DeepSeek API key in the **AI News** admin tab
2. Click **Generate News** — calls DeepSeek V4 Flash for 2 AI story summaries, then converts to speech via edge-tts
3. Click **Enable News** — after every 10 songs, all stations will play the 30-60 second news segment

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
