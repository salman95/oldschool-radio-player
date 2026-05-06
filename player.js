const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
require('events').EventEmitter.defaultMaxListeners = 50;
const aiNews = require('./ai-news');

/* ---------- Station Player ---------- */
// Direct file reads via fs.readSync with consistent setTimeout pacing.
// No stream pipeline — just raw reads at a controlled rate.
// 16KB every 375ms = 43 KB/s = 344 kbps.
// FLAC/OGG/WAV transcoded to MP3 via ffmpeg with same pacing.
class StationPlayer {
  constructor(stationId, stationName, tracks, onEvent) {
    this.stationId = stationId;
    this.stationName = stationName;
    this.tracks = tracks;
    this.onEvent = onEvent || (() => {});

    this.isPlaying = false;
    this.currentTrackIndex = -1;
    this.currentTrackName = '';

    // File reading state
    this._fd = null;
    this._fileSize = 0;
    this._filePos = 0;
    this._timer = null;

    // FLAC transcoding
    this._ffmpegProcess = null;
    this._ffmpegQueue = [];
    this._ffmpegDraining = false;

    // News segment tracking
    this._trackCount = -1;   // tracks played since last news

    // Shuffle state
    this._shuffleOrder = [];  // shuffled track indices
    this._shuffleIdx = 0;    // current position in shuffle order

    // Listeners
    this._listeners = new Set();

    // Pacing: 16KB every 375ms = 43 KB/s = 344 kbps
    this.CHUNK = 16 * 1024;
    this.INTERVAL = 375;
  }

  start() {
    if (this.isPlaying) return;
    if (this.tracks.length === 0) {
      this.onEvent(this.stationId, 'error', 'No tracks');
      return;
    }
    this.isPlaying = true;
    this.currentTrackIndex = -1;
    this._shuffleTracks();
    this._nextTrack();
    this.onEvent(this.stationId, 'started', this.stationName);
  }

  _shuffleTracks() {
    this._shuffleOrder = Array.from({ length: this.tracks.length }, (_, i) => i);
    for (let i = this._shuffleOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this._shuffleOrder[i], this._shuffleOrder[j]] = [this._shuffleOrder[j], this._shuffleOrder[i]];
    }
    this._shuffleIdx = 0;
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this._cleanup();
    for (const l of this._listeners) {
      try { l.res.destroy(); } catch (e) { /* ignore */ }
    }
    this._listeners.clear();
    this.onEvent(this.stationId, 'stopped', this.stationName);
  }

  _cleanup() {
    this._closeFile();
    if (this._ffmpegProcess) { this._ffmpegProcess.kill(); this._ffmpegProcess = null; }
    this._ffmpegQueue = [];
    this._ffmpegDraining = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _closeFile() {
    if (this._fd) { try { fs.closeSync(this._fd); } catch (e) {} this._fd = null; }
  }

  // ---- Listeners ----

  addListener(res) {
    if (!this.isPlaying) return null;

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const listener = { res, draining: false };
    this._listeners.add(listener);

    res.on('close', () => { this._listeners.delete(listener); });

    return listener;
  }

  removeListener(res) {
    for (const l of this._listeners) {
      if (l.res === res) { this._listeners.delete(l); try { res.end(); } catch (e) {} return; }
    }
  }

  get listenerCount() { return this._listeners.size; }

  // ---- Data Feeding ----

  _feed(chunk) {
    const toRemove = [];
    for (const l of this._listeners) {
      if (l.draining) continue;
      try {
        const ok = l.res.write(chunk);
        if (!ok) {
          l.draining = true;
          l.res.once('drain', () => { l.draining = false; });
        }
      } catch (e) {
        toRemove.push(l);
      }
    }
    for (const l of toRemove) this._listeners.delete(l);
  }

  // ---- Track Playback ----

  _nextTrack() {
    if (!this.isPlaying) return;
    this._cleanup();

    this._trackCount++;

    // Check if it's time for an AI news segment
    const interval = this._newsInterval || 10;
    if (this._trackCount >= interval && aiNews.isNewsReady()) {
      const newsPath = aiNews.getNewsAudioPath();
      if (newsPath) {
        this._trackCount = 0;
        this.currentTrackName = '\uD83D\uDCF0 AI News Roundup';
        this.onEvent(this.stationId, 'track_change', this.currentTrackName);
        this._playNewsFile(newsPath);
        return;
      }
    }

    // Play next music track (shuffled order)
    this.currentTrackIndex = this._shuffleOrder[this._shuffleIdx];
    this._shuffleIdx = (this._shuffleIdx + 1) % this._shuffleOrder.length;
    if (this._shuffleIdx === 0) this._shuffleTracks();
    const track = this.tracks[this.currentTrackIndex];

    try {
      const stat = fs.statSync(track.filepath);
      if (!stat || stat.size === 0) { setImmediate(() => this._nextTrack()); return; }
    } catch (e) { setImmediate(() => this._nextTrack()); return; }

    this.currentTrackName = track.display_name;
    this.onEvent(this.stationId, 'track_change', track.display_name);

    const ext = path.extname(track.filepath).toLowerCase();
    if (ext === '.flac' || ext === '.ogg' || ext === '.wma' || ext === '.wav') {
      this._startFfmpeg(track.filepath);
    } else {
      this._openFile(track.filepath);
    }
  }

  // ---- AI News Playback ----
  // Reads the news file in paced 16KB chunks at the same rate as music
  // (375ms per chunk), then seamlessly transitions to the next track.
  // No artificial delay — the browser receives continuous data.

  _playNewsFile(filepath) {
    try {
      const stat = fs.statSync(filepath);
      if (!stat || stat.size === 0) { setImmediate(() => this._nextTrack()); return; }

      this._fd = fs.openSync(filepath, 'r');
      this._fileSize = stat.size;
      this._filePos = 0;
      this._scheduleNewsRead();
    } catch (e) {
      setImmediate(() => this._nextTrack());
    }
  }

  _scheduleNewsRead() {
    if (!this.isPlaying || !this._fd) return;

    const remaining = this._fileSize - this._filePos;
    if (remaining <= 0) {
      this._closeFile();
      setImmediate(() => this._nextTrack());
      return;
    }

    const toRead = Math.min(this.CHUNK, remaining);
    const buf = Buffer.alloc(toRead);

    try {
      const bytesRead = fs.readSync(this._fd, buf, 0, toRead, this._filePos);
      if (bytesRead <= 0) {
        this._closeFile();
        setImmediate(() => this._nextTrack());
        return;
      }
      this._filePos += bytesRead;
      this._feed(buf.slice(0, bytesRead));
    } catch (e) {
      this._closeFile();
      setImmediate(() => this._nextTrack());
      return;
    }

    this._timer = setTimeout(() => this._scheduleNewsRead(), this.INTERVAL);
  }

  _openFile(filepath) {
    try {
      this._fd = fs.openSync(filepath, 'r');
      this._fileSize = fs.statSync(filepath).size;
      this._filePos = 0;
      this._scheduleRead();
    } catch (e) {
      setImmediate(() => this._nextTrack());
    }
  }

  _scheduleRead() {
    if (!this.isPlaying || !this._fd) return;

    const remaining = this._fileSize - this._filePos;
    if (remaining <= 0) {
      this._closeFile();
      setImmediate(() => this._nextTrack());
      return;
    }

    const toRead = Math.min(this.CHUNK, remaining);
    const buf = Buffer.alloc(toRead);

    try {
      const bytesRead = fs.readSync(this._fd, buf, 0, toRead, this._filePos);
      if (bytesRead <= 0) {
        this._closeFile();
        setImmediate(() => this._nextTrack());
        return;
      }
      this._filePos += bytesRead;
      this._feed(buf.slice(0, bytesRead));
    } catch (e) {
      this._closeFile();
      setImmediate(() => this._nextTrack());
      return;
    }

    this._timer = setTimeout(() => this._scheduleRead(), this.INTERVAL);
  }

  // ---- FLAC Transcoding ----

  _startFfmpeg(filepath) {
    const ffmpeg = spawn('ffmpeg', [
      '-i', filepath, '-f', 'mp3', '-b:a', '192k', '-ar', '44100', '-ac', '2', '-'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this._ffmpegProcess = ffmpeg;
    this._ffmpegQueue = [];
    this._ffmpegDraining = false;

    ffmpeg.stdout.on('data', (chunk) => {
      // Break into 16KB pieces and queue them
      for (let i = 0; i < chunk.length; i += this.CHUNK) {
        this._ffmpegQueue.push(chunk.slice(i, Math.min(i + this.CHUNK, chunk.length)));
      }
      if (!this._ffmpegDraining) {
        this._ffmpegDraining = true;
        const drainQueue = () => {
          if (this._ffmpegQueue.length === 0) { this._ffmpegDraining = false; return; }
          if (!this.isPlaying) { ffmpeg.kill(); return; }
          this._feed(this._ffmpegQueue.shift());
          this._timer = setTimeout(drainQueue, this.INTERVAL);
        };
        drainQueue();
      }
    });

    ffmpeg.stdout.on('end', () => { ffmpeg.kill(); setImmediate(() => this._nextTrack()); });
    ffmpeg.on('error', () => { ffmpeg.kill(); setImmediate(() => this._nextTrack()); });
    ffmpeg.on('close', (code) => {
      if (code !== 0 && this._ffmpegQueue.length === 0) setImmediate(() => this._nextTrack());
    });

    let stderr = '';
    ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });
    ffmpeg.stderr.on('end', () => {
      if (this._ffmpegQueue.length === 0 && stderr.includes('Error')) {
        console.error(`[player] ffmpeg error for ${path.basename(filepath)}`);
      }
    });
  }

  getStatus() {
    return {
      isPlaying: this.isPlaying,
      currentTrack: this.currentTrackName,
      listenerCount: this.listenerCount,
      trackIndex: this.currentTrackIndex,
      totalTracks: this.tracks.length,
    };
  }
}

module.exports = { StationPlayer };
