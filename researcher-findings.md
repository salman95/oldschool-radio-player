# Research: Node.js Radio Streaming — Idle Timeout, State Sync, Station Lifecycle

## Summary
Idle timeouts that auto-stop radio stations on zero listeners create state drift between in-memory Map and DB. Best fix: debounce the idle trigger (30-60s grace), use write-through pattern (update DB *before* removing from Map on stop, restore from DB on start), and make DB the single source of truth — never reset online=0 on restart. Station lifecycle should use an EventEmitter-driven state machine with explicit states (idle, active, stopping, starting) to prevent race conditions.

## Findings

### 1. Idle timeout should use debounce + grace window, not immediate kill
- 2-minute hard timeout fires during rapid station switching. Listener leaves station A → timeout starts → switches to station B → timeout fires while B plays → kills A's player but A's DB flag stays online=1.
- **Fix**: Debounce idle timeout. Reset timer on each listener disconnect/reconnect event. Use 30-60s debounce window so transient disconnect during station switch doesn't trigger stop.
- Icecast pattern: `source-timeout` (default 10s) only disconnects sources that send zero data. Streaming servers distinguish "no listeners" from "no source data" — the source (encoder) stays live regardless of listener count. Your app conflates these: app *is* the source, so killing it on zero listeners is wrong for rapid-switch scenarios.
- If stopping on zero listeners is desired, use debounce + check "has this station had any listener in last N seconds" before stopping. [Source](https://icecast.imux.net/viewtopic.php?t=5092)

### 2. Write-through pattern prevents Map/DB mismatch
- Current code: stop handler removes player from Map but does NOT update DB online flag. Classic write-around bug.
- **Fix**: Always update DB *synchronously* (or await) in same tick as Map mutation. Two options:
  - **Write-through**: Update DB first, then remove from Map. If DB write fails, don't remove from Map.
  - **Write-back with verify**: Remove from Map, queue DB update. On restart, reconcile: for any station with online=1 but no player — mark offline in DB.
- Write-through is safer for correctness. Write-back is better for performance but requires reconciliation logic. [Source](https://oneuptime.com/blog/post/2026-01-30-write-through-pattern-details/view)

### 3. DB is single source of truth — never reset all to offline on restart
- App resets ALL stations to offline on restart. This destroys the source of truth. On restart, DB should reflect actual runtime state.
- **Fix**: On restart, query DB for online=1 stations. Attempt to start player for each. If start fails (bad stream URL, etc.), *then* set offline=0. If start succeeds, player Map populated from DB truth, not the reverse.
- Alternative lighter fix: don't reset online flag at all on restart. Leave it as the last-known-desired state. The startup reconciliation logic handles stale flags. [Source](https://blog.appsignal.com/2023/04/19/nodejs-pitfalls-to-avoid.html)

### 4. Station lifecycle needs a state machine, not ad-hoc timer logic
- Current: start/stop directly mutates Map and DB in inconsistent order. No guard against double-start or double-stop.
- **Fix**: Use EventEmitter-based station state manager with explicit states:
  ```
  IDLE → STARTING → ACTIVE → STOPPING → IDLE
              ↕ (error) ↕
  ```
- Each transition: validate current state, emit event, update Map, update DB, set new state.
- Start/stop are idempotent — calling start on ACTIVE station is no-op. Calling stop on IDLE station is no-op.
- Timer only triggers transition from ACTIVE → STOPPING, never directly mutates. [Source](https://oneuptime.com/blog/post/2026-02-03-nodejs-eventemitter/view)

### 5. Listener reconnect/seamless switch requires source persistence
- Rapid station switch: listener leaves station A, joins station B. Station A's player should NOT be destroyed immediately.
- **Pattern**: Keep the player/ffmpeg process alive for a grace period (30-60s) after last listener disconnects. Track `lastListenerAt` timestamp.
- On new listener connect to station A within grace window — reuse existing player (no restart needed). On connect after grace — start fresh.
- This prevents the "stop → start → stop → start" thrash during rapid switching.
- For orphan detection: periodic heartbeat from each listener (every 15-30s). If no heartbeat received, assume listener dropped (network issue, tab closed) and decrement listener count. [Source](https://webrtc.ventures/2023/06/implementing-a-reconnection-mechanism-for-webrtc-mobile-applications/)

### 6. Common pitfalls summary
| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Update Map but not DB | Stale online=1 with no player | Write-through: DB first, Map second |
| Reset all to offline on restart | Lose desired state | Query DB, start players, reconcile |
| Hard 2min timeout, no debounce | Stations killed during rapid switch | Debounce idle timer (30-60s grace) |
| No state guards | Double-stop crashes, race conditions | State machine with idempotent transitions |
| Listener count not heartbeated | Orphan listeners keep station alive forever | Heartbeat every 15-30s, expire stale |
| Stop destroys source immediately | Restart cost on every reconnect | Keep source alive during grace window |

## Sources

### Kept
- **Icecast source-timeout docs** (icecast.org) — Industry standard for streaming server idle handling. Shows source stays alive regardless of listener count. [Source](http://icecast.org/docs/icecast-2.2.0/config-file.html)
- **Write-through caching pattern** (OneUptime) — Practical Node.js implementation for synchronous cache/DB updates. Directly applicable to Map/DB sync. [Source](https://oneuptime.com/blog/post/2026-01-30-write-through-pattern-details/view)
- **Node.js pitfalls to avoid** (AppSignal) — Covers state management anti-patterns including unchecked mutations and missing error handlers. [Source](https://blog.appsignal.com/2023/04/19/nodejs-pitfalls-to-avoid.html)
- **EventEmitter event-driven systems** (OneUptime) — Pattern for decoupled state transitions via events. Applicable to station lifecycle manager. [Source](https://oneuptime.com/blog/post/2026-02-03-nodejs-eventemitter/view)
- **Debounce implementation** (FreeCodeCamp / GeeksforGeeks) — Standard debounce pattern for rate-limiting rapid-fire events like timer reset on station switch. [Source](https://www.freecodecamp.org/news/javascript-debounce-example/)
- **WebRTC reconnection handling** (WebRTC.ventures) — Connection state machine and heartbeat patterns for streaming apps. [Source](https://webrtc.ventures/2023/06/implementing-a-reconnection-mechanism-for-webrtc-mobile-applications/)

### Dropped
- Generic Node.js timeout guides (BetterStack, AppSignal) — Too general, focus on HTTP server timeouts not streaming app idle logic.
- Agora WebRTC GitHub discussion — Too specific to Agora SDK, not general pattern.
- Redis in-memory DB blog — Marketing content, no actionable patterns.
- Spotify system design — Not directly applicable to small radio streaming app architecture.

## Gaps
- No specific Node.js radio streaming open-source projects found with comparable idle-timeout + DB-state architecture to reference directly.
- No performance benchmarks comparing ffmpeg process restart cost vs keepalive during grace window. Would need measurement.
- Exact heartbeat interval for browser-based audio streaming listeners (HLS/WebSocket) not established — 15-30s is estimate based on WebRTC patterns.

## Supervisor coordination
Research complete. Write-through pattern + debounced idle timeout + state machine + startup reconciliation recommended as primary fix strategy. Ready for implementation planning.
