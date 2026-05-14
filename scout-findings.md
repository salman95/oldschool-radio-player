# Scout Findings — Station Lifecycle & Idle Timeout Bug

## Files Retrieved

1. `server.js` (lines 1-450) — HTTP server, API routes, players Map, stream endpoint
2. `player.js` (lines 1-340) — StationPlayer class, idle timeout, listener management
3. `db.js` (lines 1-180) — SQLite schema, prepared statements, `updateStationOnline`
4. `scanner.js` (lines 1-80) — Directory scanner for audio files
5. `public/js/app.js` (lines 1-600) — Frontend: tune in/disconnect, status polling
6. `public/index.html` (lines 1-300) — UI structure
7. `README.md` — Project overview, API docs
8. `DOCKER.md` — Deployment guide

---

## Architecture Overview

```
Admin clicks Play
  -> POST /api/stations/:id/play
  -> creates StationPlayer, sets in players Map
  -> DB: online=1

Listener tunes in
  -> GET /stream?station_id=X
  -> player.addListener(res)
  -> idle timer reset

Listener disconnects
  -> res.on('close') -> _listeners.delete()
  -> _checkIdle() -> 2min timer starts

2 min idle expires
  -> stop() -> fires 'stopped' event
  -> players.delete(stationId)
  -> DB: online STILL = 1  <-- BUG
```

### Two sources of truth for station state:

| Source | Location | Set by |
|--------|----------|--------|
| `stations.online` (DB) | `db.js` table `stations` | Admin play/stop, server startup reset |
| `players` Map (in-memory) | `server.js:42` | Admin play, idle timeout stop |

These diverge on idle timeout. DB says online, Map says gone.

---

## Every Code Path That Affects Station Online/Offline State

### Path 1: Admin Plays Station (server.js:227-252)

```js
// server.js line 237-252
player.start();
db.updateStationOnline.run(1, stationId);  // DB online=1
// players.set() happens before start()
```

**Result:** DB=1, Map=has player. In sync.

### Path 2: Admin Stops Station (server.js:258-277)

```js
// server.js line 270-272
stopPlayer(stationId);       // player.stop() -> 'stopped' -> players.delete()
db.updateStationOnline.run(0, stationId);  // DB online=0
```

**Result:** DB=0, Map=no player. In sync.

### Path 3: Idle Timeout Auto-Stop (player.js:304-310) — **BUG HERE**

```js
// player.js line 304-310
_checkIdle() {
  if (this._listeners.size > 0) return;
  if (this._idleTimer) clearTimeout(this._idleTimer);
  this._idleTimer = setTimeout(() => {
    if (this._listeners.size === 0 && this.isPlaying) {
      console.log('[player] Auto-stopped ' + this.stationName + ' (idle 2min)');
      this.stop();  // fires 'stopped' event
    }
  }, 120000);
}
```

`stop()` (player.js:97-104):
```js
stop() {
  if (!this.isPlaying) return;
  this.isPlaying = false;
  this._cleanup();
  for (const l of this._listeners) {
    try { l.res.destroy(); } catch (e) {}
  }
  this._listeners.clear();
  this.onEvent(this.stationId, 'stopped', this.stationName);  // fires event
}
```

`onPlayerEvent` in server.js:44-52:
```js
function onPlayerEvent(stationId, event, detail) {
  // ...
  if (event === 'stopped') {
    players.delete(stationId);  // Map cleaned up
  }
  // MISSING: db.updateStationOnline.run(0, stationId);
}
```

**Result:** DB=1 (stale), Map=no player. **OUT OF SYNC.**

### Path 4: Server Startup (server.js:45-48)

```js
function resetAllOffline() {
  db.db.prepare('UPDATE stations SET online = 0').run();
}
```

Called at `server.listen()` callback. Resets ALL stations to offline. No auto-restore.

**Result:** DB=0, Map=empty. In sync (both offline).

### Path 5: Station Deleted (server.js:211-225)

```js
stopPlayer(stationId);  // player.stop() -> 'stopped' -> players.delete()
db.deleteStation.run(stationId);  // row gone, online flag irrelevant
```

**Result:** Station row deleted. Clean.

### Path 6: Stream Endpoint Rejects (server.js:348-367)

```js
function serveRadioStream(req, res) {
  const player = players.get(stationId);
  if (!player || !player.isPlaying) {
    res.writeHead(409, ...);
    res.end(JSON.stringify({ error: 'Station is not broadcasting' }));
    return;
  }
  // ...
}
```

After idle timeout: player gone from Map. Returns 409. Listener gets error.

---

## The Bug: State Mismatch After Idle Timeout

### Root Cause

`onPlayerEvent` in `server.js:44-52` handles the `'stopped'` event by deleting from the `players` Map, but **never calls** `db.updateStationOnline.run(0, stationId)`.

The DB `online` flag is only updated in two places:
1. `server.js:247` — admin play: `db.updateStationOnline.run(1, stationId)`
2. `server.js:272` — admin stop: `db.updateStationOnline.run(0, stationId)`
3. `server.js:46` — startup reset: `UPDATE stations SET online = 0`

Idle timeout path hits none of these.

### Impact on Rapid Listener Switching

1. Listener tunes into Station A → player A created, DB online=1
2. Listener clicks Station B → disconnect from A, tune into B
3. Station A idle timer starts (2 min)
4. 2 min later → Station A auto-stops
5. DB still says `online=1` for Station A
6. `GET /api/stations` returns `online: true, is_playing: false` (divergent)
7. Listener clicks back to Station A → frontend sees `!station.is_playing` → shows "Offline"
8. Even if frontend tried `/stream?station_id=A` → returns 409 "Station is not broadcasting"

### Frontend Behavior (app.js)

- `renderStations()` (app.js:130): shows LIVE badge when `station.is_playing` (from Map), not from DB `online`
- `tuneIntoStation()` (app.js:211): checks `!station.stream_url && !station.is_playing` → blocks tuning
- Status poll (app.js:332): polls `/stations/:id/status` every 3s; if `!result.is_playing` → disconnects

Frontend uses `is_playing` (Map-based) for UI decisions, so the UI correctly shows offline. But the DB flag is stale, and any code that reads `stations.online` directly gets wrong data.

---

## Fix Options

### Option A: Update DB in onPlayerEvent (minimal change)

In `server.js:44-52`, add DB update when 'stopped' fires:

```js
function onPlayerEvent(stationId, event, detail) {
  if (event === 'started' || event === 'stopped' || event === 'error') {
    console.log(`[player] station=${stationId} event=${event} detail=${detail}`);
  }
  if (event === 'stopped') {
    players.delete(stationId);
    db.updateStationOnline.run(0, stationId);  // <-- ADD THIS
  }
}
```

**Pro:** One-line fix. Covers idle timeout and any future stop paths.
**Con:** If admin stop also triggers this, `updateStationOnline` runs twice (harmless, idempotent).

### Option B: Remove idle timeout entirely

Remove `_checkIdle` / `_idleTimer` from `player.js`. Stations stay playing until admin stops them.

**Pro:** No state mismatch possible.
**Con:** Wastes resources on stations with no listeners.

### Option C: Make onPlayerEvent the single source of truth for online state

Remove `db.updateStationOnline.run(0, stationId)` from the admin stop handler (`server.js:272`) since `onPlayerEvent` already handles it. Same for play — move DB update into the 'started' event handler.

**Pro:** Single point of truth.
**Con:** More refactoring. Higher risk of introducing bugs.

---

## Key Types & Interfaces

### StationPlayer (player.js)

```js
class StationPlayer {
  stationId, stationName, tracks, streamUrl, onEvent
  isPlaying: boolean
  _listeners: Set<{res, draining}>
  _idleTimer: Timer | null
  // methods: start(), stop(), addListener(res), removeListener(res), _checkIdle()
}
```

### players Map (server.js:42)

```js
const players = new Map();  // Map<stationId (number), StationPlayer>
```

### DB stations table (db.js)

```sql
stations (id, name, stream_dir, stream_url, online INTEGER DEFAULT 0, created_at)
```

### DB prepared statement (db.js)

```js
const updateStationOnline = db.prepare('UPDATE stations SET online = ? WHERE id = ?');
```

---

## Start Here

Open `server.js` line 44 (`onPlayerEvent` function). This is where the fix belongs. Add `db.updateStationOnline.run(0, stationId)` inside the `'stopped'` event branch.

Secondary: review `server.js` line 272 (admin stop handler) — after the fix, this line becomes redundant since `onPlayerEvent` handles it. Consider removing it to avoid double-update.
