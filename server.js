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
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  if (Date.now() - new Date(session.createdAt).getTime() > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function destroySession(token) {
  sessions.delete(token);
}

// Log a user out everywhere (optionally keeping one session, e.g. the current one)
function destroySessionsForUser(userId, exceptToken) {
  for (const [token, session] of sessions) {
    if (session.userId === userId && token !== exceptToken) sessions.delete(token);
  }
}

/* ---------- Login Rate Limiting ---------- */
// Failed attempts are counted per client IP + username; after too many, that pair
// is locked out until the window expires.
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // key -> { count, firstAt }

function loginKey(req, username) {
  return getClientIp(req) + '|' + username.toLowerCase();
}

function isLoginLocked(key) {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key) {
  const entry = loginFailures.get(key);
  if (!entry || Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstAt: Date.now() });
  } else {
    entry.count++;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginFailures) {
    if (now - entry.firstAt > LOGIN_WINDOW_MS) loginFailures.delete(key);
  }
}, 60 * 60 * 1000);

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
  player.setTracks(db.getTracksByStation.all(stationId));
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

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const MAX_BODY_BYTES = 64 * 1024;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(httpError(413, 'Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (!body || typeof body !== 'object') throw new Error();
        resolve(body);
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

const MIN_PASSWORD_LENGTH = 8;

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

// Resolve a directory and make sure it is MUSIC_ROOT or inside it (symlinks resolved).
// Returns the resolved path, or null if it doesn't exist or is outside the music folder.
function resolveMusicDir(dirPath) {
  if (!isNonEmptyString(dirPath)) return null;
  const resolved = path.resolve(MUSIC_ROOT, dirPath);
  let real, root;
  try {
    real = fs.realpathSync(resolved);
    root = fs.realpathSync(MUSIC_ROOT);
  } catch {
    return null;
  }
  const rel = path.relative(root, real);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return resolved;
}

function isValidStreamUrl(value) {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

function sessionCookie(req, value, maxAgeSeconds) {
  const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
  return `token=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}` + (secure ? '; Secure' : '');
}

function getClientIp(req) {
  return req.socket.remoteAddress || '';
}

function logAction(userId, action, detail, ip) {
  db.insertLog.run(userId, action, detail, ip);
}

function getToken(req) {
  return (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('token='))
    ?.split('=')[1];
}

function requireAuth(req, res) {
  const token = getToken(req);
  const session = getSession(token);
  // Re-check the user on every request so deleted users lose access immediately
  const user = session ? db.getUserById.get(session.userId) : null;
  if (!user) {
    if (session) destroySession(token);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return null;
  }
  session.username = user.username;
  session.role = user.role;
  session.token = token;
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

async function handleApi(req, res, url) {
  try {
  const pathname = url.pathname;

  // --- Auth ---
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const { username, password } = body;
    if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
      jsonResponse(res, 400, { error: 'Username and password required' });
      return;
    }
    const key = loginKey(req, username);
    if (isLoginLocked(key)) {
      jsonResponse(res, 429, { error: 'Too many failed attempts. Try again later.' });
      return;
    }
    const user = db.getUserByUsername.get(username);
    // Hash even for unknown users so response time doesn't reveal which usernames exist
    const check = user ? await db.verifyPassword(password, user.password) : (await db.hashPassword(password), { ok: false });
    if (!check.ok) {
      recordLoginFailure(key);
      logAction(null, 'login_failed', `User: ${username}`, getClientIp(req));
      jsonResponse(res, 401, { error: 'Invalid credentials' });
      return;
    }
    loginFailures.delete(key);
    if (check.legacy) db.updateUserPassword.run(await db.hashPassword(password), user.id);
    if (password === 'admin123') {
      console.warn(`[auth] WARNING: user "${user.username}" is using the old default password — change it`);
    }
    const token = createSession(user);
    logAction(user.id, 'login', '', getClientIp(req));
    res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_TTL / 1000));
    jsonResponse(res, 200, {
      user: { id: user.id, username: user.username, role: user.role, theme: user.theme || 'win98-basic' },
    });
    return;
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = getToken(req);
    if (token) {
      const session = getSession(token);
      if (session) logAction(session.userId, 'logout', '', getClientIp(req));
      destroySession(token);
    }
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
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
    session.theme = body.theme;
    logAction(session.userId, 'theme_changed', body.theme, getClientIp(req));
    jsonResponse(res, 200, { ok: true, theme: body.theme });
    return;
  }

  // --- Change own password ---
  if (pathname === '/api/account/password' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;

    const body = await parseBody(req);
    const problem = passwordProblem(body.new_password);
    if (problem) { jsonResponse(res, 400, { error: problem }); return; }
    const row = db.getPasswordHashById.get(session.userId);
    const check = await db.verifyPassword(String(body.current_password || ''), row.password);
    if (!check.ok) { jsonResponse(res, 403, { error: 'Current password is incorrect' }); return; }

    db.updateUserPassword.run(await db.hashPassword(body.new_password), session.userId);
    destroySessionsForUser(session.userId, session.token);
    logAction(session.userId, 'password_changed', '', getClientIp(req));
    jsonResponse(res, 200, { ok: true });
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
      // Safety: must be under MUSIC_ROOT
      const resolved = resolveMusicDir(dirPath);
      if (!resolved) {
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
        is_playing: player ? player.isPlaying : false,
        current_track: player ? player.currentTrackName : '',
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
    const name = isNonEmptyString(body.name) ? body.name.trim() : '';
    const stream_url = isNonEmptyString(body.stream_url) ? body.stream_url.trim() : '';
    let stream_dir = isNonEmptyString(body.stream_dir) ? body.stream_dir : '';
    if (!name || (!stream_dir && !stream_url)) {
      jsonResponse(res, 400, { error: 'Name and stream_dir required' });
      return;
    }
    if (stream_url && !isValidStreamUrl(stream_url)) {
      jsonResponse(res, 400, { error: 'Stream URL must be an http:// or https:// URL' });
      return;
    }
    if (stream_dir) {
      stream_dir = resolveMusicDir(stream_dir);
      if (!stream_dir) {
        jsonResponse(res, 400, { error: 'Directory not found or outside the music folder' });
        return;
      }
    }

    const result = db.insertStation.run(name, stream_dir, stream_url, 0);
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

    if (station.stream_url && !isValidStreamUrl(station.stream_url)) {
      jsonResponse(res, 400, { error: 'Stream URL must be an http:// or https:// URL' });
      return;
    }
    if (!station.stream_url && !resolveMusicDir(station.stream_dir)) {
      jsonResponse(res, 400, { error: 'Station directory not found or outside the music folder' });
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
      player.setTracks(tracks);
      player.streamUrl = station.stream_url || null;
    }

    if (player.isPlaying) {
      jsonResponse(res, 200, { ok: true, status: 'already_playing' });
      return;
    }

    player.start();
    if (!player.isPlaying) {
      players.delete(stationId);
      jsonResponse(res, 500, { error: 'Station failed to start' });
      return;
    }
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

    if (!station.stream_dir) {
      jsonResponse(res, 400, { error: 'Remote stations have no directory to scan' });
      return;
    }
    const scanDir = resolveMusicDir(station.stream_dir);
    if (!scanDir) {
      jsonResponse(res, 400, { error: 'Station directory not found or outside the music folder' });
      return;
    }

    const scanResult = scanAndStore(stationId, scanDir);
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
    const { password, role } = body;
    const username = isNonEmptyString(body.username) ? body.username.trim() : '';
    if (!username || !password || !role) {
      jsonResponse(res, 400, { error: 'Username, password, and role required' });
      return;
    }
    const problem = passwordProblem(password);
    if (problem) {
      jsonResponse(res, 400, { error: problem });
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
    db.insertUser.run(username, await db.hashPassword(password), role);
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
    db.deleteUser(userId);
    destroySessionsForUser(userId);
    logAction(session.userId, 'user_deleted', user.username, getClientIp(req));
    jsonResponse(res, 200, { ok: true });
    return;
  }

  const userPasswordMatch = pathname.match(/^\/api\/users\/(\d+)\/password$/);
  if (userPasswordMatch && req.method === 'PATCH') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) {
      jsonResponse(res, 403, { error: 'Admin only' });
      return;
    }
    const userId = parseInt(userPasswordMatch[1], 10);
    const user = db.getUserById.get(userId);
    if (!user) {
      jsonResponse(res, 404, { error: 'User not found' });
      return;
    }
    const body = await parseBody(req);
    const problem = passwordProblem(body.password);
    if (problem) {
      jsonResponse(res, 400, { error: problem });
      return;
    }
    db.updateUserPassword.run(await db.hashPassword(body.password), userId);
    destroySessionsForUser(userId, session.token);
    logAction(session.userId, 'password_reset', user.username, getClientIp(req));
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
      has_key: !!db.getApiKey(),
      key_from_env: !!process.env.DEEPSEEK_API_KEY,
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
    if (!isNonEmptyString(body.api_key)) { jsonResponse(res, 400, { error: 'API key required' }); return; }

    db.setApiKey(body.api_key.trim());
    logAction(session.userId, 'ai_key_saved', '', getClientIp(req));
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/ai-news/toggle' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) { jsonResponse(res, 403, { error: 'Admin only' }); return; }

    const body = await parseBody(req);
    if (!db.getApiKey()) { jsonResponse(res, 400, { error: 'Set API key first' }); return; }

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
    const apiKey = db.getApiKey();
    if (!apiKey) { jsonResponse(res, 400, { error: 'Set API key first' }); return; }

    try {
      const result = await aiNews.generateNews(apiKey, cfg.use_ai !== 0);
      db.updateAiNewsAudio.run(result.text, result.audioPath);
      logAction(session.userId, 'ai_news_generated', '', getClientIp(req));
      jsonResponse(res, 200, { ok: true, text: result.text.slice(0, 100) + '...' });
    } catch (e) {
      jsonResponse(res, e.status || 500, { error: e.message });
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

  // --- AI News: songs between news segments ---
  if (pathname === '/api/ai-news/interval' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!requireAdmin(session)) { jsonResponse(res, 403, { error: 'Admin only' }); return; }

    const body = await parseBody(req);
    const interval = parseInt(body.track_interval, 10);
    if (!(interval >= 1 && interval <= 100)) {
      jsonResponse(res, 400, { error: 'Track interval must be between 1 and 100' });
      return;
    }
    db.updateAiNewsInterval.run(interval);
    logAction(session.userId, 'ai_news_interval', String(interval), getClientIp(req));
    jsonResponse(res, 200, { ok: true, track_interval: interval });
    return;
  }

  jsonResponse(res, 404, { error: 'API endpoint not found' });
  } catch (e) {
    if (!e.status) console.error('[api] Unhandled error:', e.message);
    if (res.headersSent) { res.destroy(); return; }
    jsonResponse(res, e.status || 500, { error: e.message || 'Internal error' });
  }
}

/* ---------- Radio Stream Endpoint ---------- */
// /stream?station_id=X  — live radio stream from the station player
function serveRadioStream(req, res, url) {
  const session = requireAuth(req, res);
  if (!session) return;

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

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  let filePath;
  try {
    filePath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (filePath.includes('\0')) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  filePath = filePath === '/' ? '/index.html' : filePath;

  const resolved = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(filePath));
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(resolved, (err, data) => {
    if (err) {
      const notFound = err.code === 'ENOENT' || err.code === 'EISDIR';
      res.writeHead(notFound ? 404 : 500);
      res.end(notFound ? 'Not Found' : 'Internal Server Error');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

/* ---------- Main Server ---------- */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    // connect-src allows the Icecast metadata lookup for remote stations
    "connect-src 'self' http: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const server = http.createServer((req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch(function (err) {
        console.error('[server] API error:', err.message);
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
      });
    } else if (url.pathname === '/stream') {
      serveRadioStream(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    console.error('[server] Request error:', err.message);
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(500);
    res.end('Internal Server Error');
  }
});

// Don't auto-restore stations on boot — the admin will click Play manually.
// This avoids CPU spikes on startup from multiple stations running simultaneously.
// The 'online' flag still persists in the DB so the admin knows which stations were active.

server.listen(PORT, HOST, () => {
  resetAllOffline();
  console.log(`Radio app running at http://${HOST}:${PORT}`);
});

/* ---------- Memory Monitoring (diagnostic logging) ---------- */
// Logs heap usage every 5 minutes to detect leaks in production
setInterval(() => {
  const mem = process.memoryUsage();
  const toMB = (n) => Math.round(n / 1024 / 1024);
  console.log(`[memory] heap=${toMB(mem.heapUsed)}/${toMB(mem.heapTotal)}MB rss=${toMB(mem.rss)}MB external=${toMB(mem.external)}MB sessions=${sessions.size} players=${players.size}`);
}, 5 * 60 * 1000);
