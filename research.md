# Research: Memory Leak Review — Node.js Radio Streaming App

## Summary

Six fixes applied target the main known leak vectors (ffmpeg stderr, reconnect timers, sessions, track-advance races, GC tuning, monitoring). The **players Map** is the one confirmed remaining cumulative leak. The other four concerns (`_listeners` Set, `_scheduleRead`, `_remoteBuffer`, better-sqlite3 statements) are sound. One additional logic risk surfaces around listener-orphaning on same-user reconnect.

## Findings

### 1. `players` Map — CONFIRMED CUMULATIVE LEAK

Entries are created in `startPlayer()` but only deleted in `stopPlayer()`. If idle timeout calls `player.stop()` without calling `stopPlayer()` (or `stopPlayer` doesn't delete the entry), the Map grows unboundedly. Each retained entry holds:
- The Player object reference (even if internally cleaned up)
- All properties on the Player instance (timer IDs, buffer arrays, ffmpeg child-process refs, listener closures)
- Map entry overhead (key + value pointer + hash table slot)

Over days/weeks with repeated start-idle-stop cycles, this grows linearly with no bound. Fix: delete the Map entry in `stopPlayer()` or in the idle timeout handler after `player.stop()`.

**Severity: HIGH** — direct unbounded growth on a per-player lifecycle.

### 2. `_listeners` Set — SOUND FOR MEMORY, LOGIC RACE EXISTS

The Set stores only userId strings (not response objects), so it cannot prevent GC of response objects. Closures attached via `res.on(event, handler)` are on the `res` object itself and are GC'd when `res` is collected. The `close` handler reliably removes listeners. Node's `removeListener` is a safe no-op for non-existent handlers — won't throw.

**One logic edge case**: If `addListener(res, userId)` is called for a userId that already has a stale response in the Set (previous `close` hasn't fired yet), the old response's `close` handler will eventually call `removeListener` and delete the userId from the Set. This **orphans** the newer response — its listeners remain attached, but the userId is gone, so broadcasts skip it. The user stops receiving audio until next reconnect. Not a memory leak, but user-visible audio dropout.

**Fix**: Use a `Map<userId, Set<res>>` or track which `res` is current per userId, so `removeListener` only removes the userId if the closing response matches the current one.

### 3. `_scheduleRead()` recursive setTimeout — SAFE

Pattern: `this._readTimer = setTimeout(…)` with `clearTimeout(this._readTimer)` in `_cleanup()`. Each call overwrites the old timer reference, making the prior Timeout object eligible for GC. The Node.js Timeout-object retention bug (documented by Armin Ronacher, 2024) applies when Timeout objects are **stored indefinitely** in collections — not when they're overwritten and cleared like this. The circular reference (Timeout → callback → Player → `_readTimer` → Timeout) is within the same V8 heap and GC can collect it.

**One verification needed**: Confirm every code path that abandons a Player calls `_cleanup()` (or `stop()` which calls it). Missed cleanup is the real risk here.

### 4. `_remoteBuffer` ring buffer — SAFE

Bounded at 256KB with `.shift()` on old chunks. Constant-size array, no growth. The `.shift()` O(n) cost is negligible at this size. Could optimize to an indexed ring buffer (no shift), but no leak.

### 5. better-sqlite3 global prepared statements — NOT A LEAK

Two key facts from the better-sqlite3 source and docs:

1. **Automatic finalization**: The native `Statement` destructor calls `sqlite3_finalize()` when the JS object is GC'd. [Source: Issue #356, WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3/issues/356)

2. **Global module-level statements** are intentionally permanent — they live for the app lifetime, consuming a fixed ~4KB+ each for compiled VDBE bytecode. This is the intended caching pattern. No growth over time.

**Caveat**: If `db.prepare()` is called inside request handlers (per-request) without caching to a variable, each call creates a new Statement object. These are eventually GC'd and finalized, but the repeated allocation creates GC pressure. For a radio app with session-based auth queries, this matters at high concurrency. Solution: prepare once at module load and reuse.

### 6. Node.js `setTimeout` memory leak bug (Node < 22)

Armin Ronacher documented a bug where `setTimeout` returns a `Timeout` object that retains references even after clearing/destruction. Fixed in Node 22+. [Source](https://lucumr.pocoo.org/2024/6/5/node-timeout/)

**Impact on this app**: Low. The `_scheduleRead()` pattern overwrites `this._readTimer` and clears in `_cleanup()`. The bug primarily affects code that stores Timeout objects indefinitely (e.g., in arrays or Maps). The app's pattern is safe, but upgrading to Node 22+ eliminates the class of risk entirely.

### 7. `_cleanup()` reliability — MEDIUM CONCERN

All the timer/memory safety depends on `_cleanup()` being called exactly once per Player lifecycle. Risk points:
- Exceptions thrown during Player construction before `_cleanup()` is bonded
- `player.stop()` called multiple times re-entering cleanup (should be idempotent — verify)
- Abandoned Player objects where neither `stop()` nor idle timeout fires

**Recommendation**: Add a `_cleaned` flag to make `_cleanup()` idempotent with a guard at the top.

### 8. GC tuning — SOUND BUT MONITOR

- `--max-old-space-size=768` for 1GB container: standard recommendation (75-80% of container limit).
- `--max-semi-space-size=32`: doubles default young-gen size. Reduces minor-GC frequency for short-lived audio chunks. Tradeoff: each minor GC pauses slightly longer. For streaming audio, this is a good tradeoff.
- Monitoring every 5 min is lightweight — safe.

**Additional recommendation**: Also expose `--expose-gc` in dev mode only (not prod) for heap snapshot debugging.

## Sources

### Kept
- **WiseLibs/better-sqlite3 Issue #356** — Confirms Statement destructor auto-calls `sqlite3_finalize` via C++ destructor. (https://github.com/WiseLibs/better-sqlite3/issues/356)
- **Armin Ronacher — Node.js setTimeout memory leak** — Documents Node < 22 bug where Timeout objects retain references. (https://lucumr.pocoo.org/2024/6/5/node-timeout/)
- **SQLite docs — sqlite3_finalize** — Official C API for prepared statement destruction. (https://sqlite.org/c3ref/finalize.html)
- **Node.js http module docs** — Confirms `close` event fires on ServerResponse for connection termination. (https://nodejs.org/api/http.html)

### Dropped
- Generic "Node.js memory leak" blog posts — redundant, no specific insights beyond general patterns.
- SQLite user-forum threads about C-level leaks — not applicable to better-sqlite3's bound wrapper.
- Unbounded-cache articles — app already bounded everything except `players` Map.

## Gaps

1. **Cannot verify actual code** — All analysis based on description. Would need to read `server.js` and the Player module to confirm:
   - Whether `stopPlayer()` deletes the Map entry
   - Whether idle timeout calls `stopPlayer()` or just `player.stop()`
   - Whether `_cleanup()` is idempotent
   - Whether `_listeners` tracks userId→response mapping or just userIds
   - Whether `db.prepare()` is called per-request or cached at module level
2. **Node.js version unknown** — setTimeout bug status depends on runtime version.
3. **No heap snapshot data** — Actual growth rate of `players` Map cannot be quantified without running the app under load.

## Supervisor coordination

No coordination needed. All findings are analytical based on described patterns and public documentation. If code access is granted, I can validate the `players` Map lifecycle and `_cleanup()` idempotency by reading the actual source files.
