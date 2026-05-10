const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = path.join(__dirname, 'radio.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrations: add columns if upgrading from older schema
try { db.exec(`ALTER TABLE ai_news ADD COLUMN model TEXT DEFAULT 'deepseek-v4-flash'`); } catch (e) {}
try { db.exec(`ALTER TABLE stations ADD COLUMN stream_url TEXT DEFAULT ''`); } catch (e) {}

/* ---------- Schema ---------- */
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_news (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key    TEXT    DEFAULT '',
    model      TEXT    DEFAULT 'deepseek-v4-flash',
    enabled    INTEGER NOT NULL DEFAULT 0,
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
  `SELECT id, username, role, created_at FROM users WHERE id = ?`
);

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
const upsertAiNews = db.prepare(
  `INSERT INTO ai_news (id, api_key, model, enabled, track_interval, news_text, audio_path, generated_at, updated_at)
   VALUES (1, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
   ON CONFLICT(id) DO UPDATE SET
     api_key = excluded.api_key,
     model = excluded.model,
     enabled = excluded.enabled,
     track_interval = excluded.track_interval,
     news_text = excluded.news_text,
     audio_path = excluded.audio_path,
     generated_at = excluded.generated_at,
     updated_at = datetime('now')`
);
const getAiNews = db.prepare(
  `SELECT * FROM ai_news WHERE id = 1`
);
const updateAiNewsKey = db.prepare(
  `UPDATE ai_news SET api_key = ?, model = ?, updated_at = datetime('now') WHERE id = 1`
);
const updateAiNewsEnabled = db.prepare(
  `UPDATE ai_news SET enabled = ?, updated_at = datetime('now') WHERE id = 1`
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

/* ---------- Helpers ---------- */

function hashPassword(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

function seedDefaults() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (count.c === 0) {
    insertUser.run('admin', hashPassword('admin123'), 'admin');
    console.log('[db] Seeded default admin (admin / admin123)');
  }

  const stationCount = db.prepare('SELECT COUNT(*) AS c FROM stations').get();
  if (stationCount.c === 0) {
    const demos = [
      ['Smooth Jazz FM', '/streams/jazz/', 0],
      ['Classic Rock 101', '/streams/rock/', 1],
      ['Lo-Fi Beats', '/streams/lofi/', 0],
      ['Classical Hour', '/streams/classical/', 1],
    ];
    const tx = db.transaction((rows) => {
      const stmt = db.prepare(
        `INSERT INTO stations (name, stream_dir, online) VALUES (?, ?, ?)`
      );
      for (const row of rows) stmt.run(...row);
    });
    tx(demos);
    console.log('[db] Seeded demo stations');
  }
}

seedDefaults();

module.exports = {
  db,
  hashPassword,
  // user ops
  insertUser,
  getUserByUsername,
  getAllUsers,
  deleteUserStmt,
  getUserById,
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
  upsertAiNews,
  getAiNews,
  updateAiNewsKey,
  updateAiNewsEnabled,
  updateAiNewsAudio,
};
