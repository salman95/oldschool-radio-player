const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'radio.db');
let db;
try {
  db = new Database(DB_PATH);
} catch (e) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
  console.error(`[db] Cannot open database at ${DB_PATH}: ${e.message}`);
  console.error(`[db] Make sure ${path.dirname(DB_PATH)} exists and is writable by uid ${uid}.`);
  console.error('[db] With Docker Compose, set PUID/PGID in .env to the owner of ./data (see README).');
  process.exit(1);
}

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ---------- Schema ---------- */
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_news (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key    TEXT    DEFAULT '',
    model      TEXT    DEFAULT 'deepseek-v4-flash',
    enabled    INTEGER NOT NULL DEFAULT 0,
    use_ai     INTEGER NOT NULL DEFAULT 1,
    track_interval INTEGER NOT NULL DEFAULT 10,
    news_text  TEXT    DEFAULT '',
    audio_path TEXT    DEFAULT '',
    generated_at TEXT  DEFAULT '',
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    UNIQUE NOT NULL,
    password   TEXT    NOT NULL,
    role       TEXT    NOT NULL DEFAULT 'listener',
    theme      TEXT    DEFAULT 'win98-basic',
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    stream_dir TEXT    DEFAULT '',
    stream_url TEXT    DEFAULT '',
    online     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id    INTEGER NOT NULL,
    filename      TEXT    NOT NULL,
    filepath      TEXT    NOT NULL,
    display_name  TEXT    NOT NULL,
    file_size     INTEGER NOT NULL DEFAULT 0,
    added_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER,
    action     TEXT    NOT NULL,
    detail     TEXT    DEFAULT '',
    ip         TEXT    DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

/* ---------- Migrations (after schema, for existing DBs) ---------- */
try { db.exec(`ALTER TABLE ai_news ADD COLUMN model TEXT DEFAULT 'deepseek-v4-flash'`); } catch (e) {}
try { db.exec("ALTER TABLE ai_news ADD COLUMN use_ai INTEGER DEFAULT 1"); } catch (e) {}
try { db.exec(`ALTER TABLE stations ADD COLUMN stream_url TEXT DEFAULT ''`); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'win98-basic'"); } catch (e) {}

// The AI news config is a single row; make sure it exists so plain UPDATEs always apply
db.exec('INSERT OR IGNORE INTO ai_news (id) VALUES (1)');

/* ---------- Prepared Statements ---------- */

// Users
const insertUser = db.prepare(
  `INSERT INTO users (username, password, role) VALUES (?, ?, ?)`
);
const getUserByUsername = db.prepare(
  `SELECT * FROM users WHERE username = ?`
);
const getAllUsers = db.prepare(
  `SELECT id, username, role, created_at FROM users ORDER BY created_at DESC`
);
const deleteUserStmt = db.prepare(
  `DELETE FROM users WHERE id = ?`
);
const getUserById = db.prepare(
  `SELECT id, username, role, theme, created_at FROM users WHERE id = ?`
);
const updateUserPassword = db.prepare(
  `UPDATE users SET password = ? WHERE id = ?`
);
const getPasswordHashById = db.prepare(
  `SELECT password FROM users WHERE id = ?`
);
// Logs keep their history when a user is deleted; they just lose the user link
const detachUserLogs = db.prepare(
  `UPDATE logs SET user_id = NULL WHERE user_id = ?`
);
const deleteUser = db.transaction((userId) => {
  detachUserLogs.run(userId);
  deleteUserStmt.run(userId);
});

// Stations
const insertStation = db.prepare(
  `INSERT INTO stations (name, stream_dir, stream_url, online) VALUES (?, ?, ?, ?)`
);
const getAllStations = db.prepare(
  `SELECT * FROM stations ORDER BY name ASC`
);
const deleteStation = db.prepare(
  `DELETE FROM stations WHERE id = ?`
);
const getStationById = db.prepare(
  `SELECT * FROM stations WHERE id = ?`
);
const updateStationOnline = db.prepare(
  `UPDATE stations SET online = ? WHERE id = ?`
);

// Tracks
const insertTrack = db.prepare(
  `INSERT INTO tracks (station_id, filename, filepath, display_name, file_size) VALUES (?, ?, ?, ?, ?)`
);
const deleteTracksByStation = db.prepare(
  `DELETE FROM tracks WHERE station_id = ?`
);
const getTracksByStation = db.prepare(
  `SELECT * FROM tracks WHERE station_id = ? ORDER BY display_name ASC`
);
const getTrackCountByStation = db.prepare(
  `SELECT COUNT(*) AS count FROM tracks WHERE station_id = ?`
);

// AI News
const getAiNews = db.prepare(
  `SELECT * FROM ai_news WHERE id = 1`
);
const updateAiNewsKey = db.prepare(
  `UPDATE ai_news SET api_key = ?, updated_at = datetime('now') WHERE id = 1`
);
const updateAiNewsEnabled = db.prepare(
  `UPDATE ai_news SET enabled = ?, updated_at = datetime('now') WHERE id = 1`
);
const updateAiNewsRewrite = db.prepare(
  `UPDATE ai_news SET use_ai = ?, updated_at = datetime('now') WHERE id = 1`
);
const updateAiNewsInterval = db.prepare(
  `UPDATE ai_news SET track_interval = ?, updated_at = datetime('now') WHERE id = 1`
);
const updateAiNewsAudio = db.prepare(
  `UPDATE ai_news SET news_text = ?, audio_path = ?, generated_at = datetime('now'), updated_at = datetime('now') WHERE id = 1`
);

// Logs
const insertLog = db.prepare(
  `INSERT INTO logs (user_id, action, detail, ip) VALUES (?, ?, ?, ?)`
);
const getAllLogs = db.prepare(
  `SELECT logs.*, users.username
   FROM logs
   LEFT JOIN users ON logs.user_id = users.id
   ORDER BY logs.created_at DESC
   LIMIT 200`
);

// User theme
const updateUserTheme = db.prepare(
  `UPDATE users SET theme = ? WHERE id = ?`
);

/* ---------- Passwords ---------- */
// Format: scrypt$<salt hex>$<key hex>. Older databases stored unsalted sha256 hex,
// which is still accepted at login and upgraded to scrypt on the next successful login.
const SCRYPT_KEYLEN = 32;

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function hashPasswordSync(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function legacySha256(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

// Returns { ok, legacy } — legacy=true means the stored hash should be upgraded
async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return { ok: false, legacy: false };
  if (stored.startsWith('scrypt$')) {
    const [, saltHex, keyHex] = stored.split('$');
    const expected = Buffer.from(keyHex || '', 'hex');
    const actual = await scryptAsync(plain, Buffer.from(saltHex || '', 'hex'), expected.length || SCRYPT_KEYLEN);
    return { ok: expected.length > 0 && crypto.timingSafeEqual(actual, expected), legacy: false };
  }
  const expected = Buffer.from(stored, 'hex');
  const actual = Buffer.from(legacySha256(plain), 'hex');
  const ok = expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  return { ok, legacy: ok };
}

/* ---------- Secrets at rest (DeepSeek API key) ---------- */
// AES-256-GCM with a key from APP_SECRET, or a generated key file next to the database.
const SECRET_PREFIX = 'enc:v1:';

function loadSecretKey() {
  if (process.env.APP_SECRET) {
    return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  }
  const keyFile = path.join(path.dirname(DB_PATH), 'secret.key');
  try {
    const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    if (key.length === 32) return key;
    console.warn(`[db] Ignoring invalid key file ${keyFile}`);
  } catch (e) { /* not created yet */ }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  return key;
}

const SECRET_KEY = loadSecretKey();

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return SECRET_PREFIX + [iv, cipher.getAuthTag(), ct].map((b) => b.toString('hex')).join(':');
}

function decryptSecret(stored) {
  if (!stored) return '';
  if (!stored.startsWith(SECRET_PREFIX)) return stored; // legacy plaintext
  try {
    const [iv, tag, ct] = stored.slice(SECRET_PREFIX.length).split(':').map((h) => Buffer.from(h, 'hex'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    console.warn('[db] Could not decrypt stored API key (APP_SECRET or secret.key changed?)');
    return '';
  }
}

function setApiKey(plain) {
  updateAiNewsKey.run(encryptSecret(plain));
}

// DEEPSEEK_API_KEY from the environment takes precedence over the stored key
function getApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const cfg = getAiNews.get();
  return decryptSecret(cfg && cfg.api_key);
}

// Encrypt any key that was stored in plaintext by older versions
{
  const cfg = getAiNews.get();
  if (cfg && cfg.api_key && !cfg.api_key.startsWith(SECRET_PREFIX)) setApiKey(cfg.api_key);
}

/* ---------- Seeding ---------- */

function seedDefaults() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (count.c === 0) {
    const fromEnv = !!process.env.ADMIN_PASSWORD;
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
    insertUser.run('admin', hashPasswordSync(password), 'admin');
    if (fromEnv) {
      console.log('[db] Seeded admin user with the password from ADMIN_PASSWORD');
    } else {
      console.log(`[db] Seeded admin user — username: admin  password: ${password}`);
      console.log('[db] This password is shown only once. Change it from the Users screen.');
    }
  }

  const weak = db.prepare('SELECT username FROM users WHERE password = ?').all(legacySha256('admin123'));
  for (const u of weak) {
    console.warn(`[db] WARNING: user "${u.username}" still has the old default password "admin123" — change it`);
  }
}

seedDefaults();

module.exports = {
  db,
  hashPassword,
  verifyPassword,
  // user ops
  insertUser,
  getUserByUsername,
  getAllUsers,
  deleteUserStmt,
  getUserById,
  updateUserPassword,
  getPasswordHashById,
  deleteUser,
  // station ops
  insertStation,
  getAllStations,
  deleteStation,
  getStationById,
  updateStationOnline,
  // track ops
  insertTrack,
  deleteTracksByStation,
  getTracksByStation,
  getTrackCountByStation,
  // log ops
  insertLog,
  getAllLogs,
  // ai news ops
  getAiNews,
  setApiKey,
  getApiKey,
  updateAiNewsEnabled,
  updateAiNewsRewrite,
  updateAiNewsInterval,
  updateAiNewsAudio,
  // user theme
  updateUserTheme,
};
