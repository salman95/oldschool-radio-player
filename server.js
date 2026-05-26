const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { scanDirectory } = require('./scanner');
const { StationPlayer } = require('./player');
const aiNews = require('./ai-news');

const PORT = process.env.PORT || 6767;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MUSIC_ROOT = process.env.MUSIC_DIR || path.join(__dirname, 'music');

/* ---------- In-Memory Sessions ---------- */
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Periodically purge expired sessions to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - new Date(session.createdAt).getTime() > SESSION_TTL) {
      sessions.delete(token);
    }
  }
}, 60 * 60 * 1000); // every hour

function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    role: user.role,
    theme: user.theme || 'win98-basic',
    createdAt: new Date().toISOString(),
  });
  return token;
}

function getSession(token) {
  return token && sessions.has(token) ? sessions.get(token) : null;
}

function destroySession(token) {
  sessions.delete(token);
}

/* ---------- Station Players ---------- */
// Map<stationId, StationPlayer>
const players = new Map();

function onPlayerEvent(stationId, event, detail) {
  if (event === 'started' || event === 'stopped' || event === 'error') {
    console.log(`[player] station=${stationId} event=${event} detail=${detail}`);
  }
  // Clean up players Map on stop (idle timeout or manual stop)
  if (event === 'stopped') {
    db.updateStationOnline.run(0, stationId);
    players.delete(stationId);
  }
}

// On startup, reset all stations to offline since we no longer auto-restore
function resetAllOffline() {
  db.db.prepare('UPDATE stations SET online = 0').run();
}

function refreshPlayerTracks(stationId) {
  const player = players.get(stationId);
  if (!player) return;
  const tracks = db.getTracksByStation.all(stationId);
  player.tracks = tracks;
}

function stopPlayer(stationId) {
  const player = players.get(stationId);
  if (player) {
    player.stop();
    // players.delete(stationId) is handled by onPlayerEvent 'stopped'
  }
}

/* ---------- Helpers ---------- */

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getClientIp(req) {
  return req.socket.remoteAddress || '';
}

function logAction(userId, action, detail, ip) {
  db.insertLog.run(userId, action, detail, ip);
}

function requireAuth(req, res) {
  const token = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('token='))
    ?.split('=')[1];

  const session = getSession(token);
  if (!session) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return null;
  }
  return session;
}

function requireAdmin(session) {
  return session && session.role === 'admin';
}

/* ---------- Scan helper ---------- */

function scanAndStore(stationId, streamDir) {
  const result = scanDirectory(streamDir);
  if (result.error) {
    return result;
  }

  db.deleteTracksByStation.run(stationId);

  if (result.files.length > 0) {
    const tx = db.db.transaction((files) => {
      const stmt = db.db.prepare(
        `INSERT INTO tracks (station_id, filename, filepath, display_name, file_size)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const f of files) {
        stmt.run(stationId, f.filename, f.filepath, f.display_name, f.file_size);
      }
    });
    tx(result.files);
  }

  // Refresh player tracks if it's running
  refreshPlayerTracks(stationId);

  return result;
}

/* ---------- API Routes ---------- */

async function handleApi(req, res) {
  try {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- Auth ---
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const { username, password } = body;
    if (!username || !password) {
      jsonResponse(res, 400, { error: 'Username and password required' });
      return;
    }
    const user = db.getUserByUsername.get(username);
    if (!user || user.password !== db.hashPassword(password)) {
      logAction(null, 'login_failed', `User: ${username}`, getClientIp(req));
      jsonResponse(res, 401, { error: 'Invalid credentials' });
      return;
    }
    const token = createSession(user);
    logAction(user.id, 'login', '', getClientIp(req));
    res.setHeader('Set-Cookie', `token=${token}; HttpOnly; Path=/; SameSite=Lax`);
    jsonResponse(res, 200, {
      user: { id: user.id, username: user.username, role: user.role, theme: user.theme || 'win98-basic' },
    });
    return;
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('token='))
      ?.split('=')[1];
    if (token) {
      const session = getSession(token);
      if (session) logAction(session.userId, 'logout', '', getClientIp(req));
      destroySession(token);
    }
    res.setHeader('Set-Cookie', 'token=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/');
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;
    jsonResponse(res, 200, { user: { id: session.userId, username: session.username, role: session.role, theme: session.theme || 'win98-basic' } });
    return;
  }

  // --- User theme preference ---
  if (pathname === '/api/user/theme' && req.method === 'PATCH') {
    const session = requireAuth(req, res);
    if (!session) return;

    const body = await parseBody(req);
    const validThemes = ['win98-basic', 'win98-enhanced', 'winxp'];
    if (!body.theme || !validThemes.includes(body.theme)) {
      jsonResponse(res, 400, { error: 'Invalid theme. Must be win98-basic, win98-enhanced, or winxp' });
      return;
    }

    db.updateUserTheme.run(body.theme, session.userId);
    // Update in-memory session too
    const currentSession = sessions.get((req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('token='))
      ?.split('=')[1]);
    if (currentSession) {
      currentSession.theme = body.theme;
    }
    logAction(session.userId, 'theme_changed', body.theme, getClientIp(req));
    jsonResponse(res, 200, { ok: true, theme: body.theme });
    return;
  }

  // --- List music directories ---
  if (pathname === '/api/music-dirs' && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) {
      jsonResponse(res, 403, { error: 'Admin only' });
      return;
    }

    let dirs = [];
    try {
      const entries = fs.readdirSync(MUSIC_ROOT, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          dirs.push({
            name: entry.name,
            path: path.join(MUSIC_ROOT, entry.name),
          });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      jsonResponse(res, 500, { error: 'Cannot read music directory: ' + err.message });
      return;
    }

    jsonResponse(res, 200, { music_root: MUSIC_ROOT, directories: dirs });
    return;
  }

  // --- List subdirectories of a given path ---
  const subdirsMatch = pathname.match(/^\/api\/subdirs\/(.+)$/);
  if (subdirsMatch && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) {
      jsonResponse(res, 403, { error: 'Admin only' });
      return;
    }

    const dirPath = decodeURIComponent(subdirsMatch[1]);
    let subdirs = [];
    try {
      const resolved = path.resolve(dirPath);
      // Safety: must be under MUSIC_ROOT
      if (!resolved.startsWith(MUSIC_ROOT)) {
        jsonResponse(res, 403, { error: 'Access denied' });
        return;
      }
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          subdirs.push({
            name: entry.name,
            path: path.join(resolved, entry.name),
          });
        }
      }
      subdirs.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      jsonResponse(res, 500, { error: 'Cannot read directory: ' + err.message });
      return;
    }

    jsonResponse(res, 200, { parent: dirPath, subdirectories: subdirs });
    return;
  }

  // --- Stations ---
  if (pathname === '/api/stations' && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;

    const stations = db.getAllStations.all().map((s) => {
      const trackCount = db.getTrackCountByStation.get(s.id).count;
      const player = players.get(s.id);
      return {
        id: s.id,
        name: s.name,
        stream_dir: s.stream_dir,
        stream_url: s.stream_url || '',
        online: !!s.online,
        track_count: trackCount,
        is_playing: player ? player.isPlaying : !!s.stream_url,
        current_track: player ? player.currentTrackName : (s.stream_url ? s.name : ''),
        listener_count: player ? player.listenerCount : 0,
        created_at: s.created_at,
      };
    });
    jsonResponse(res, 200, { stations });
    return;
  }

  if (pathname === '/api/stations' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) {
      jsonResponse(res, 403, { error: 'Admin only' });
      return;
    }
    const body = await parseBody(req);
    const { name, stream_dir, stream_url } = body;
    if (!name || (!stream_dir && !stream_url)) {
      jsonResponse(res, 400, { error: 'Name and stream_dir required' });
      return;
    }

    const result = db.insertStation.run(name, stream_dir || '', stream_url || '', 0);
    const stationId = result.lastInsertRowid;

    let tracks_found = 0, scan_errors = [];
    if (stream_dir) {
      const scanResult = scanAndStore(stationId, stream_dir);
      tracks_found = scanResult.count || 0;
      scan_errors = scanResult.errors || [];
      if (scanResult.error) {
        logAction(session.userId, 'scan_error', `${name}: ${scanResult.error}`, getClientIp(req));
      } else {
        logAction(session.userId, 'station_created', `${name} \u2014 ${tracks_found} tracks`, getClientIp(req));
      }
    }

    jsonResponse(res, 201, {
      id: stationId,
      name,
      stream_dir: stream_dir || '',
      stream_url: stream_url || '',
      tracks_found,
      scan_errors: scan_errors,
    });
    return;
  }

  const deleteStationMatch = pathname.match(/^\/api\/stations\/(\d+)$/);
  if (deleteStationMatch && req.method === 'DELETE') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) {
      jsonResponse(res, 403, { error: 'Admin only' });
      return;
    }
    const stationId = parseInt(deleteStationMatch[1], 10);
    const station = db.getStationById.get(stationId);
    if (!station) {
      jsonResponse(res, 404, { error: 'Station not found' });
      return;
    }
    stopPlayer(stationId);
    db.deleteStation.run(stationId);
    logAction(session.userId, 'station_deleted', station.name, getClientIp(req));
    jsonResponse(res, 200, { ok: true });
    return;
  }

  // --- Play/Stop a station ---
  const playMatch = pathname.match(/^\/api\/stations\/(\d+)\/play$/);
  if (playMatch && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) {
      jsonResponse(res, 403, { error: 'Admin only' });
      return;
    }
    const stationId = parseInt(playMatch[1], 10);
    const station = db.getStationById.get(stationId);
    if (!station) {
      jsonResponse(res, 404, { error: 'Station not found' });
      return;
    }

    const tracks = db.getTracksByStation.all(stationId);
    // Remote stream stations don't need local tracks
    if (tracks.length === 0 && !station.stream_url) {
      jsonResponse(res, 400, { error: 'No tracks in this station' });
      return;
    }

    let player = players.get(stationId);
    if (!player) {
      player = new StationPlayer(stationId, station.name, tracks, onPlayerEvent);
      player.streamUrl = station.stream_url || null;
      players.set(stationId, player);
    } else {
      player.tracks = tracks;
      player.streamUrl = station.stream_url || null;
    }

    if (player.isPlaying) {
      jsonResponse(res, 200, { ok: true, status: 'already_playing' });
      return;
    }

    player.start();
    db.updateStationOnline.run(1, stationId);
    logAction(session.userId, 'station_play', `${station.name}`, getClientIp(req));
    jsonResponse(res, 200, { ok: true, status: 'playing' });
    return;
  }

  const stopMatch = pathname.match(/^\/api\/stations\/(\d+)\/stop$/);
  if (stopMatch && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) {
      jsonResponse(res, 403, { error: 'Admin only' });
      return;
    }
    const stationId = parseInt(stopMatch[1], 10);
    const station = db.getStationById.get(stationId);
    if (!station) {
      jsonResponse(res, 404, { error: 'Station not found' });
      return;
    }

    stopPlayer(stationId);
    db.updateStationOnline.run(0, stationId);
    logAction(session.userId, 'station_stop', `${station.name}`, getClientIp(req));
    jsonResponse(res, 200, { ok: true, status: 'stopped' });
    return;
  }

  // --- Station status ---
  const statusMatch = pathname.match(/^\/api\/stations\/(\d+)\/status$/);
  if (statusMatch && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;

    const stationId = parseInt(statusMatch[1], 10);
    const station = db.getStationById.get(stationId);
    if (!station) { jsonResponse(res, 404, { error: 'Station not found' }); return; }

    // Remote URL stations are always available — no player needed
    if (station.stream_url) {
      jsonResponse(res, 200, { is_playing: true, current_track: station.name, currentTrack: station.name, listener_count: 0 });
      return;
    }

    const player = players.get(stationId);
    if (!player) {
      jsonResponse(res, 200, { is_playing: false });
      return;
    }
    const s = player.getStatus();
    jsonResponse(res, 200, {
      is_playing: s.isPlaying,
      current_track: s.currentTrack,
      currentTrack: s.currentTrack,
      listener_count: s.listenerCount,
      track_index: s.trackIndex,
      total_tracks: s.totalTracks,
    });
    return;
  }

  // --- Scan a station's directory ---
  const scanMatch = pathname.match(/^\/api\/stations\/(\d+)\/scan$/);
  if (scanMatch && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) {
      jsonResponse(res, 403, { error: 'Admin only' });
      return;
    }
    const stationId = parseInt(scanMatch[1], 10);
    const station = db.getStationById.get(stationId);
    if (!station) {
      jsonResponse(res, 404, { error: 'Station not found' });
      return;
    }

    const scanResult = scanAndStore(stationId, station.stream_dir);
    if (scanResult.error) {
      logAction(session.userId, 'scan_error', `${station.name}: ${scanResult.error}`, getClientIp(req));
      jsonResponse(res, 400, { error: scanResult.error });
      return;
    }

    logAction(session.userId, 'station_scanned',
      `${station.name} \u2014 ${scanResult.count} tracks found`, getClientIp(req));
    jsonResponse(res, 200, {
      station_id: stationId,
      tracks_found: scanResult.count,
      errors: scanResult.errors || [],
    });
    return;
  }

  // --- Tracks for a station ---
  const tracksMatch = pathname.match(/^\/api\/stations\/(\d+)\/tracks$/);
  if (tracksMatch && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;

    const stationId = parseInt(tracksMatch[1], 10);
    const station = db.getStationById.get(stationId);
    if (!station) {
      jsonResponse(res, 404, { error: 'Station not found' });
      return;
    }

    const tracks = db.getTracksByStation.all(stationId);
    jsonResponse(res, 200, {
      station_id: stationId,
      station_name: station.name,
      tracks,
      total: tracks.length,
    });
    return;
  }

  // --- Users (admin only) ---
  if (pathname === '/api/users' && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) {
      jsonResponse(res, 403, { error: 'Admin only' });
      return;
    }
    const users = db.getAllUsers.all();
    jsonResponse(res, 200, { users });
    return;
  }

  if (pathname === '/api/users' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) {
      jsonResponse(res, 403, { error: 'Admin only' });
      return;
    }
    const body = await parseBody(req);
    const { username, password, role } = body;
    if (!username || !password || !role) {
      jsonResponse(res, 400, { error: 'Username, password, and role required' });
      return;
    }
    if (!['admin', 'listener'].includes(role)) {
      jsonResponse(res, 400, { error: 'Role must be admin or listener' });
      return;
    }
    const existing = db.getUserByUsername.get(username);
    if (existing) {
      jsonResponse(res, 409, { error: 'Username already exists' });
      return;
    }
    db.insertUser.run(username, db.hashPassword(password), role);
    logAction(session.userId, 'user_created', `${username} (${role})`, getClientIp(req));
    jsonResponse(res, 201, { ok: true, username, role });
    return;
  }

  const deleteUserMatch = pathname.match(/^\/api\/users\/(\d+)$/);
  if (deleteUserMatch && req.method === 'DELETE') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) {
      jsonResponse(res, 403, { error: 'Admin only' });
      return;
    }
    const userId = parseInt(deleteUserMatch[1], 10);
    if (userId === session.userId) {
      jsonResponse(res, 400, { error: 'Cannot delete yourself' });
      return;
    }
    const user = db.getUserById.get(userId);
    if (!user) {
      jsonResponse(res, 404, { error: 'User not found' });
      return;
    }
    db.deleteUserStmt.run(userId);
    logAction(session.userId, 'user_deleted', user.username, getClientIp(req));
    jsonResponse(res, 200, { ok: true });
    return;
  }

  // --- Logs (admin only) ---
  if (pathname === '/api/logs' && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) {
      jsonResponse(res, 403, { error: 'Admin only' });
      return;
    }
    const logs = db.getAllLogs.all();
    jsonResponse(res, 200, { logs });
    return;
  }

  // --- AI News (admin only) ---
  if (pathname === '/api/ai-news/config' && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) { jsonResponse(res, 403, { error: 'Admin only' }); return; }

    const cfg = db.getAiNews.get() || { enabled: 0, use_ai: 1, track_interval: 10, news_text: '', generated_at: '' };
    jsonResponse(res, 200, {
      has_key: !!cfg.api_key,
      enabled: !!cfg.enabled,
      use_ai: cfg.use_ai !== undefined ? !!cfg.use_ai : true,
      track_interval: cfg.track_interval || 10,
      has_news: !!cfg.news_text,
      news_text: cfg.news_text || '',
      generated_at: cfg.generated_at || '',
    });
    return;
  }

  if (pathname === '/api/ai-news/key' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) { jsonResponse(res, 403, { error: 'Admin only' }); return; }

    const body = await parseBody(req);
    if (!body.api_key) { jsonResponse(res, 400, { error: 'API key required' }); return; }

    db.upsertAiNews.run(body.api_key, 0, 1, 10, '', '', '');
    logAction(session.userId, 'ai_key_saved', '', getClientIp(req));
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/ai-news/toggle' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) { jsonResponse(res, 403, { error: 'Admin only' }); return; }

    const body = await parseBody(req);
    const cfg = db.getAiNews.get();
    if (!cfg || !cfg.api_key) { jsonResponse(res, 400, { error: 'Set API key first' }); return; }

    const enabled = body.enabled ? 1 : 0;
    db.updateAiNewsEnabled.run(enabled);
    logAction(session.userId, enabled ? 'ai_news_enabled' : 'ai_news_disabled', '', getClientIp(req));
    jsonResponse(res, 200, { ok: true, enabled: !!enabled });
    return;
  }

  if (pathname === '/api/ai-news/generate' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) { jsonResponse(res, 403, { error: 'Admin only' }); return; }

    const cfg = db.getAiNews.get();
    if (!cfg || !cfg.api_key) { jsonResponse(res, 400, { error: 'Set API key first' }); return; }

    try {
      const result = await aiNews.generateNews(cfg.api_key, cfg.use_ai !== 0);
      db.updateAiNewsAudio.run(result.text, result.audioPath);
      logAction(session.userId, 'ai_news_generated', '', getClientIp(req));
      jsonResponse(res, 200, { ok: true, text: result.text.slice(0, 100) + '...' });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // --- AI News: toggle rewrite mode ---
  if (pathname === '/api/ai-news/rewrite' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) { jsonResponse(res, 403, { error: 'Admin only' }); return; }

    const body = await parseBody(req);
    const useAi = body.use_ai ? 1 : 0;
    db.updateAiNewsRewrite.run(useAi);
    logAction(session.userId, useAi ? 'ai_rewrite_enabled' : 'ai_rewrite_disabled', '', getClientIp(req));
    jsonResponse(res, 200, { ok: true, use_ai: !!useAi });
    return;
  }

  jsonResponse(res, 404, { error: 'API endpoint not found' });
  } catch (e) {
    console.error('[api] Unhandled error:', e.message);
    jsonResponse(res, 500, { error: e.message || 'Internal error' });
  }
}

/* ---------- Radio Stream Endpoint ---------- */
// /stream?station_id=X  — live radio stream from the station player
function serveRadioStream(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const stationId = parseInt(url.searchParams.get('station_id'), 10);

  if (!stationId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'station_id required' }));
    return;
  }

  const station = db.getStationById.get(stationId);
  if (!station) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Station not found' }));
    return;
  }

  const player = players.get(stationId);
  if (!player || !player.isPlaying) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Station is not broadcasting' }));
    return;
  }

  const listener = player.addListener(res);
  if (!listener) {
    res.writeHead(503);
    res.end('Station not playing');
    return;
  }

  req.on('close', () => {
    player.removeListener(res);
  });
}

/* ---------- Static File Server ---------- */

const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

function serveStatic(req, res) {
  let filePath = path.normalize(req.url).replace(/\.\.\//g, '');
  filePath = filePath === '/' ? '/index.html' : filePath;
  filePath = path.join(PUBLIC_DIR, filePath);

  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not Found' : 'Internal Server Error');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

/* ---------- Main Server ---------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res).catch(function (err) {
      console.error('[server] API error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
    });
  } else if (url.pathname === '/stream') {
    serveRadioStream(req, res);
  } else {
    serveStatic(req, res);
  }
});

// Don't auto-restore stations on boot — the admin will click Play manually.
// This avoids CPU spikes on startup from multiple stations running simultaneously.
// The 'online' flag still persists in the DB so the admin knows which stations were active.

server.listen(PORT, HOST, () => {
  resetAllOffline();
  console.log(`Radio app running at http://${HOST}:${PORT}`);
  console.log(`Default admin: admin / admin123`);
});

/* ---------- Memory Monitoring (diagnostic logging) ---------- */
// Logs heap usage every 5 minutes to detect leaks in production
setInterval(() => {
  const mem = process.memoryUsage();
  const toMB = (n) => Math.round(n / 1024 / 1024);
  console.log(`[memory] heap=${toMB(mem.heapUsed)}/${toMB(mem.heapTotal)}MB rss=${toMB(mem.rss)}MB external=${toMB(mem.external)}MB sessions=${sessions.size} players=${players.size}`);
}, 5 * 60 * 1000);
