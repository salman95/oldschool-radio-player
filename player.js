const { spawn, execFileSync } = require('child_process');
const path = require('path');
const aiNews = require('./ai-news');

// Detect soxr resampler once at module load: `-h resampler` shows SWResampler options (~5KB)
// soxr is a resampler engine, not a standalone filter — `-filters` won't show it
let _ffmpegHasSoxr = false;
try {
  const result = execFileSync('ffmpeg', ['-hide_banner', '-h', 'resampler'], { timeout: 3000 }).toString();
  _ffmpegHasSoxr = result.includes('soxr');
} catch (e) { /* keep false */ }

// Recent audio sent to a listener on connect so the browser can start playing immediately.
// Every listener gets the same amount, so all listeners stay in sync with each other.
const BACKLOG_BYTES = 64 * 1024;
// A listener whose socket has this much unsent data is too slow to keep up and is dropped
// (instead of silently skipping chunks and leaving holes in their audio).
const MAX_PENDING_BYTES = 512 * 1024;
// Delay before trying the next track after a failure, so broken files can't spin the CPU.
const FAILURE_RETRY_MS = 250;
// Stop the station after this many consecutive tracks failed to produce audio.
const MAX_CONSECUTIVE_FAILURES = 25;
const REMOTE_RECONNECT_MS = 5000;

/* ---------- Station Player ---------- */
// Every track is played through ffmpeg with `-re`, which emits audio at real-time speed
// regardless of bitrate. MP3s are copied as-is; other formats are transcoded to MP3.
// Output is forwarded to listeners as it arrives, so all listeners hear the same thing live.
class StationPlayer {
  constructor(stationId, stationName, tracks, onEvent) {
    this.stationId = stationId;
    this.stationName = stationName;
    this.tracks = tracks || [];
    this.streamUrl = null;
    this.onEvent = onEvent || (() => {});

    this.isPlaying = false;
    this.currentTrackIndex = -1;
    this.currentTrackName = '';

    // The ffmpeg process currently producing audio (local track, news, or remote stream)
    this._proc = null;
    this._nextTimer = null;
    this._reconnectTimer = null;
    this._failures = 0;

    // News segment tracking
    this._trackCount = -1;   // tracks played since last news

    // Shuffle state
    this._shuffleOrder = [];  // shuffled track indices
    this._shuffleIdx = 0;    // current position in shuffle order

    // Listeners + burst-on-connect backlog
    this._listeners = new Set();
    this._backlog = [];
    this._backlogSize = 0;
  }

  start() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.currentTrackIndex = -1;
    this._failures = 0;

    if (this.streamUrl) {
      // Remote stream — no tracks needed
      this.currentTrackName = this.stationName;
      this.onEvent(this.stationId, 'track_change', this.currentTrackName);
      this._playRemote();
      this.onEvent(this.stationId, 'started', this.stationName);
      return;
    }

    if (this.tracks.length === 0) {
      this.isPlaying = false;
      this.onEvent(this.stationId, 'error', 'No tracks');
      return;
    }
    this._shuffleTracks();
    this._nextTrack();
    this.onEvent(this.stationId, 'started', this.stationName);
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

  // Replace the track list (e.g. after a rescan). Safe to call while playing.
  setTracks(tracks) {
    this.tracks = tracks || [];
    this._shuffleTracks();
  }

  _shuffleTracks() {
    this._shuffleOrder = Array.from({ length: this.tracks.length }, (_, i) => i);
    for (let i = this._shuffleOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this._shuffleOrder[i], this._shuffleOrder[j]] = [this._shuffleOrder[j], this._shuffleOrder[i]];
    }
    this._shuffleIdx = 0;
  }

  _cleanup() {
    this._killProc();
    if (this._nextTimer) { clearTimeout(this._nextTimer); this._nextTimer = null; }
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._backlog = [];
    this._backlogSize = 0;
  }

  _killProc() {
    const proc = this._proc;
    // Clear first so the process's exit handlers see it is no longer current
    this._proc = null;
    if (proc) { try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ } }
  }

  // ---- Listeners ----

  addListener(res) {
    if (!this.isPlaying) return null;

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const listener = { res };
    this._listeners.add(listener);

    // Send recent audio so the new listener's player can start immediately
    for (const chunk of this._backlog) {
      try { res.write(chunk); } catch (e) { break; }
    }

    res.on('close', () => {
      this._listeners.delete(listener);
    });

    return listener;
  }

  removeListener(res) {
    for (const l of this._listeners) {
      if (l.res === res) { this._listeners.delete(l); try { res.end(); } catch (e) {} return; }
    }
  }

  get listenerCount() { return this._listeners.size; }

  // ---- Data Feeding ----

  _broadcast(chunk) {
    this._backlog.push(chunk);
    this._backlogSize += chunk.length;
    while (this._backlogSize > BACKLOG_BYTES && this._backlog.length > 1) {
      this._backlogSize -= this._backlog.shift().length;
    }

    for (const l of this._listeners) {
      if (l.res.writableLength > MAX_PENDING_BYTES) {
        // Client can't keep up with real time — disconnect rather than buffer forever
        this._listeners.delete(l);
        try { l.res.destroy(); } catch (e) { /* ignore */ }
        continue;
      }
      try {
        l.res.write(chunk);
      } catch (e) {
        this._listeners.delete(l);
      }
    }
  }

  // ---- Track Playback ----

  _scheduleNext(delay) {
    if (!this.isPlaying) return;
    if (this._nextTimer) clearTimeout(this._nextTimer);
    this._nextTimer = setTimeout(() => {
      this._nextTimer = null;
      this._nextTrack();
    }, delay);
  }

  _nextTrack() {
    if (!this.isPlaying) return;
    this._killProc();

    if (this.tracks.length === 0) {
      this.onEvent(this.stationId, 'error', 'No tracks left to play');
      this.stop();
      return;
    }

    this._trackCount++;

    // Check if it's time for an AI news segment
    const interval = aiNews.getTrackInterval();
    if (this._trackCount >= interval && aiNews.isNewsReady()) {
      const newsPath = aiNews.getNewsAudioPath();
      if (newsPath) {
        this._trackCount = 0;
        this.currentTrackName = '📰 AI News Roundup';
        this.onEvent(this.stationId, 'track_change', this.currentTrackName);
        this._playFile(newsPath, true);
        return;
      }
    }

    // Play next music track (shuffled order)
    if (this._shuffleOrder.length !== this.tracks.length || this._shuffleIdx >= this._shuffleOrder.length) {
      this._shuffleTracks();
    }
    this.currentTrackIndex = this._shuffleOrder[this._shuffleIdx++];
    const track = this.tracks[this.currentTrackIndex];

    this.currentTrackName = track.display_name;
    this.onEvent(this.stationId, 'track_change', track.display_name);

    const ext = path.extname(track.filepath).toLowerCase();
    this._playFile(track.filepath, ext === '.mp3');
  }

  _playFile(filepath, isMp3) {
    const args = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error',
                  '-re', '-i', filepath, '-map', '0:a:0', '-vn', '-map_metadata', '-1'];
    if (isMp3) {
      args.push('-c:a', 'copy');
    } else {
      if (_ffmpegHasSoxr) args.push('-af', 'aresample=resampler=soxr:precision=28:cutoff=0.99');
      args.push('-c:a', 'libmp3lame', '-q:a', '0', '-ar', '44100', '-ac', '2');
    }
    // No ID3/Xing headers: they would be injected mid-stream at every track change
    args.push('-id3v2_version', '0', '-write_id3v1', '0', '-write_xing', '0', '-f', 'mp3', '-');

    const proc = this._spawnFfmpeg(args, (bytes, stderrTail) => {
      if (bytes > 0) {
        this._failures = 0;
        this._scheduleNext(0);
        return;
      }
      this._failures++;
      const reason = stderrTail.trim().split('\n').pop() || 'no audio produced';
      console.error(`[player] Skipping unplayable file: ${path.basename(filepath)} (${reason.slice(0, 200)})`);
      if (this._failures >= Math.min(this.tracks.length || 1, MAX_CONSECUTIVE_FAILURES)) {
        this.onEvent(this.stationId, 'error', `${this._failures} consecutive tracks failed to play`);
        this.stop();
        return;
      }
      this._scheduleNext(FAILURE_RETRY_MS);
    });
    this._proc = proc;
  }

  // Spawns ffmpeg, forwards stdout to listeners, and calls onDone(bytesProduced, stderrTail)
  // exactly once when the process exits — unless it was replaced or killed in the meantime.
  _spawnFfmpeg(args, onDone) {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    let finished = false;

    proc.stdout.on('data', (chunk) => {
      if (this._proc !== proc) return;
      bytes += chunk.length;
      this._broadcast(chunk);
    });

    // Collect only trailing stderr — bounded to 2KB to prevent memory leak
    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      stderrTail += d.toString();
      if (stderrTail.length > 2048) stderrTail = stderrTail.slice(-2048);
    });

    const finish = () => {
      if (finished) return;
      finished = true;
      if (this._proc !== proc || !this.isPlaying) return;
      this._proc = null;
      onDone(bytes, stderrTail);
    };
    proc.on('error', (err) => { stderrTail += '\nspawn error: ' + err.message; finish(); });
    // 'close' fires after stdout is fully consumed, so no audio is lost at track end
    proc.on('close', finish);

    return proc;
  }

  // ---- Remote Stream Playback ----
  // Fetches a remote internet radio stream and re-broadcasts
  // it to all connected listeners (proxy mode).

  _playRemote() {
    if (!this.isPlaying || !this.streamUrl) return;

    // Transcode remote stream to MP3 via ffmpeg for universal browser support.
    // Only network protocols are allowed, so a stream URL can't read local files.
    const args = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error',
                  '-protocol_whitelist', 'http,https,tcp,tls,crypto',
                  '-rw_timeout', '15000000',
                  '-i', this.streamUrl,
                  '-map', '0:a:0', '-vn', '-map_metadata', '-1',
                  '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                  '-id3v2_version', '0', '-write_id3v1', '0', '-write_xing', '0',
                  '-f', 'mp3', '-'];

    this._proc = this._spawnFfmpeg(args, (bytes, stderrTail) => {
      if (stderrTail.trim()) {
        console.error('[player] ffmpeg error for remote stream:', stderrTail.trim().slice(-300));
      }
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this._playRemote();
      }, REMOTE_RECONNECT_MS);
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
