# Implementation Plan — Station Auto-Offline Bug Fix

## Goal
Stations stay online until admin manually stops them. Idle timeout must not kill station players. DB and in-memory Map must stay synchronized.

## Root Cause Trace

```
Listener switches stations
  → old station's res.on('close') fires
    → player._listeners.delete(listener)
      → player._checkIdle()
        → 2-min idle timer starts
          → timer fires → player.stop()
            → onPlayerEvent('stopped') → players.delete(stationId)  ← Map entry gone
            → BUT db.updateStationOnline.run(0, stationId) NEVER CALLED  ← DB still online=1
```

Next listener connects → `serveRadioStream` does `players.get(stationId)` → `null` → 409 "Station is not broadcasting" → station appears offline even though DB says online.

Secondary issue: `resetAllOffline()` wipes all stations on server restart (acceptable per existing design of manual restart, but worth documenting).

---

## Tasks

### 1. Remove idle timeout from StationPlayer
- **File**: `player.js`
- **Changes**:
  - Remove `_idleTimer` from constructor (line ~60: `this._idleTimer = null;`)
  - Remove `_checkIdle()` method entirely (lines ~304-312)
  - Remove `_idleTimer` clearing in `_cleanup()` (line ~118: `if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }`)
  - Remove idle-timer reset in `addListener()` (lines ~139-140: `if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }`)
  - Remove `removeListener` call from `res.on('close')` handler — keep only the `_listeners.delete(listener)` call (line ~152: remove `this._checkIdle()` call)
- **Acceptance**: No references to `_idleTimer` or `_checkIdle` remain in player.js. `grep -n "_idleTimer\|_checkIdle" player.js` returns empty.

### 2. Make `onPlayerEvent('stopped')` write-through to DB
- **File**: `server.js`
- **Changes**: In `onPlayerEvent` function (line ~49-54), add DB update before Map deletion:
  ```js
  function onPlayerEvent(stationId, event, detail) {
    if (event === 'started' || event === 'stopped' || event === 'error') {
      console.log(`[player] station=${stationId} event=${event} detail=${detail}`);
    }
    if (event === 'stopped') {
      db.updateStationOnline.run(0, stationId);  // ADD: sync DB
      players.delete(stationId);
    }
  }
  ```
- **Acceptance**: When admin clicks "Stop" in UI, DB `online` column for that station becomes 0 AND player is removed from Map. Both paths (idle timeout and manual stop) are now safe.

### 3. Remove `checkIdle()` call from `removeListener()`
- **File**: `player.js`
- **Changes**: The `removeListener()` method at line ~156 currently calls `_checkIdle()` — not directly visible in code but the close handler calls it. Confirm: the `res.on('close')` handler in `addListener()` is the only place `_checkIdle()` is called. After removing `_checkIdle()`, the close handler only needs `this._listeners.delete(listener)`.
- **Acceptance**: `res.on('close')` handler in `addListener()` contains only `this._listeners.delete(listener)` — no `_checkIdle()` call.

### 4. Validate station listing endpoint consistency
- **File**: `server.js`
- **Changes**: No code change needed. The `/api/stations` GET handler (line ~233) already computes `is_playing` from `players.get(s.id)`. After fixes:
  - `players.get(s.id)` will always have the player if `online=1` (since idle timeout no longer deletes it).
  - DB `online` flag and Map presence stay synchronized.
- **Acceptance**: After admin starts 4 stations and listener switches between them rapidly, all 4 stations still show as playing in the UI after 5+ minutes.

### 5. Remove stale `stopPlayer` worker (dead code check)
- **File**: `server.js`
- **Changes**: Inspect `stopPlayer()` function (line ~65-69). It calls `player.stop()` and comments that `players.delete` is handled by `onPlayerEvent`. With the DB write-through fix in Task 2, this is now correct. No changes needed.
- **Acceptance**: Manual stop via admin API still works — station disappears from UI, DB online=0.

---

## Files to Modify

| File | What changes |
|------|-------------|
| `player.js` | Remove `_idleTimer` field, `_checkIdle()` method, all references to both. Remove `_checkIdle()` call from `addListener()` close handler. Remove idleTimer cleanup in `_cleanup()`. |
| `server.js` | Add `db.updateStationOnline.run(0, stationId)` inside `onPlayerEvent` before `players.delete(stationId)`. |

---

## New Files
None.

---

## Dependencies

```
Task 1 (remove idle timeout) → Task 3 (clean up removeListener)
Task 2 (DB write-through) is independent of Tasks 1/3 — can run in parallel
Task 4 (validation) depends on Tasks 1-3
Task 5 (dead code check) — informational only, no code changes
```

Execution order: 1 → 3 → 2, then 4 (validation), then 5 (verify).

---

## Validation Steps

1. **Start server**: `node server.js`
2. **Admin login**: curl POST to `/api/login` with admin/admin123
3. **Start 4 stations**: curl POST to `/api/stations/1/play`, `/api/stations/2/play`, `/api/stations/3/play`, `/api/stations/4/play`
4. **Check DB**: `sqlite3 radio.db "SELECT id, name, online FROM stations"` — all 4 show `online=1`
5. **Listener connects to station 1**: `curl http://localhost:6767/stream?station_id=1` — receives audio data
6. **Listener disconnects** (Ctrl+C curl)
7. **Wait 3 minutes** (past old 2-min idle threshold)
8. **Listener reconnects to station 1**: `curl http://localhost:6767/stream?station_id=1` — STILL receives audio (was 409 before fix)
9. **Check DB again**: all 4 stations still `online=1`
10. **Admin stops station 1**: curl POST to `/api/stations/1/stop`
11. **Check DB**: station 1 is `online=0`, others still `online=1`
12. **Frontend test**: Open browser, login as admin, start stations, switch between them rapidly as listener, refresh page — all stations still online.

---

## Risks

### Risk 1: Zombie players running forever
- **Severity**: LOW
- **Mitigation**: Stations running with 0 listeners consume ~negligible CPU (disk read every 375ms). For 4 stations, this is ~4-16 MB/sec disk I/O. Memory per player is bounded (~256KB ring buffer + small objects). Manual admin stop always available. If this becomes an issue, add a *configurable* idle timeout (opt-in, off by default) later — not in this fix.

### Risk 2: Server restart still wipes all stations offline
- **Severity**: LOW (existing behavior, documented)
- **Mitigation**: `resetAllOffline()` remains unchanged. Admin must manually restart stations after server restart. This is intentional per the comment: "Don't auto-restore stations on boot — the admin will click Play manually." Not part of this bug scope.

### Risk 3: `_cleaned` guard already prevents re-entrant cleanup
- **Severity**: NONE (verified)
- **Confirmation**: `_cleanup()` has `if (this._cleaned) return; this._cleaned = true;` guard. Safe for any number of `stop()` calls. No code change needed.

### Risk 4: Frontend station list polling interval
- **Severity**: LOW
- **Confirmation**: Frontend polls `/api/stations` to refresh station list. After fix, `is_playing` field stays `true` as long as player exists in Map — no more false negatives from idle timeout. No frontend code changes needed.

### Risk 5: Remote stream stations (stream_url) not affected
- **Severity**: NONE
- **Confirmation**: Remote stream players also inherit from `StationPlayer` and use the same `_checkIdle()` mechanism. Fix applies equally to local and remote stations. Verified: `_playRemote()` runs inside the same `StationPlayer` instance with the same `_checkIdle()` guard.

---

## What This Fix Does NOT Do

1. **Does NOT auto-restore stations on server restart** — admin must manually click Play after restart (existing design).
2. **Does NOT add a configurable idle timeout** — stations run forever until admin stops them. This is the user's explicit requirement.
3. **Does NOT change frontend code** — the `/api/stations` response format stays identical. `is_playing` field still derived from Map presence, which is now accurate.
4. **Does NOT change the player Map lifecycle** — players are created in `play` endpoint, destroyed in `stop` endpoint via `onPlayerEvent`. Same flow, now with DB sync.
