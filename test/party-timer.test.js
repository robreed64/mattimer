// Timer state-machine tests for party/main.js (the realtime server).
//
// party/main.js is written in ESM syntax with extensionless imports and is only
// ever processed by PartyKit's esbuild bundler, so plain require() can't load it.
// We bundle it to CJS in-process (esbuild ships with partykit) and exercise the
// timer logic against a fake `room` with a controllable clock. The timer methods
// touch only `this.room` and sibling methods — never the bundled lib imports — so
// no PartyKit runtime or Durable Object is needed.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

function loadPartyClass() {
  const entry = path.resolve(__dirname, '../party/main.js');
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node',
    write: false, logLevel: 'silent',
  });
  const m = new Module(entry, module);
  m.filename = entry;
  m.paths = Module._nodeModulePaths(path.dirname(entry));
  m._compile(outputFiles[0].text, entry);
  return m.exports.default || m.exports;
}
const BjjTimerServer = loadPartyClass();

// ─── Fake room + clock ────────────────────────────────────────────────

// In-memory storage that clones on the way in and out, mimicking the Durable
// Object's structured-clone persistence (so storage holds snapshots, not live
// references to this.timerStates).
function makeRoom(env = {}) {
  const store = new Map();
  const alarms = [];
  const clone = v => (v === undefined ? undefined : structuredClone(v));
  return {
    id: 'TESTROOM',
    env,
    storage: {
      async get(k) { return clone(store.get(k)); },
      async put(k, v) { store.set(k, clone(v)); },
      async delete(k) { store.delete(k); },
      async setAlarm(t) { alarms.push(t); },
    },
    getConnections() { return []; },   // no TVs/controllers — sends are no-ops
    broadcast() {},
    _store: store,
    _alarms: alarms,
  };
}

const FIXED_START = 1_700_000_000_000;
const realNow = Date.now;
let NOW = FIXED_START;
beforeEach(() => { NOW = FIXED_START; Date.now = () => NOW; });
afterEach(() => { Date.now = realNow; });
function advance(seconds) { NOW += seconds * 1000; }

// A server with a controller bound to mat 1 and a fresh timer state. `overrides`
// patches the timer state (e.g. short rounds) before it is started.
function serverOnMat1(overrides = {}) {
  const room = makeRoom();
  const s = new BjjTimerServer(room);
  s.controllers['c1'] = { slot: 1, mats: [1] };
  s.ctrlSlots[1] = 'c1';
  s.timerStates[1] = { ...s._newTimerState(), mats: [1], ...overrides };
  return { s, room };
}
const send = (s, msg) => s.onMessage(JSON.stringify(msg), { id: 'c1' });
const start = (s) => send(s, { type: 'timer:start' });

// ─── Regression: onAlarm() must tick the countdown ────────────────────

// The bug that cost a day: a handler named alarm() (raw Durable Object
// convention) is never invoked by PartyKit — it dispatches to onAlarm(). When
// that was wrong the timer silently never ticked. These two assertions lock the
// contract in place.
test('the alarm handler is named onAlarm (not alarm)', () => {
  const { s } = serverOnMat1();
  assert.equal(typeof s.onAlarm, 'function');
  assert.equal(s.alarm, undefined);
});

test('onAlarm advances the running countdown by elapsed seconds', async () => {
  const { s, room } = serverOnMat1();
  await start(s);
  advance(5);
  await s.onAlarm();
  assert.equal(s.timerStates[1].timeRemaining, 295);
  // Still running → it must reschedule itself, or the clock would freeze.
  assert.ok(room._alarms.length >= 2);
});

test('onAlarm with no running timers does nothing and does not reschedule', async () => {
  const room = makeRoom();
  const s = new BjjTimerServer(room);
  await s.onAlarm();
  assert.equal(room._alarms.length, 0);
});

// ─── Pause / resume / replay ──────────────────────────────────────────

test('pause freezes the remaining time and stops the clock', async () => {
  const { s } = serverOnMat1();
  await start(s);
  advance(10);
  await send(s, { type: 'timer:pause' });
  const ts = s.timerStates[1];
  assert.equal(ts.running, false);
  assert.equal(ts.timeRemaining, 290);
  assert.equal(ts.startedAt, null);
  // Frozen: time passing must not change the paused value.
  advance(30);
  assert.equal(s._computeCurrentState(1).timeRemaining, 290);
});

test('resume continues from the paused value, not the original duration', async () => {
  const { s } = serverOnMat1();
  await start(s);
  advance(10);
  await send(s, { type: 'timer:pause' });   // 290 left
  await start(s);
  advance(5);
  assert.equal(s._computeCurrentState(1).timeRemaining, 285);
});

test('_computeCurrentState replays from startedAt without mutating stored state', async () => {
  const { s } = serverOnMat1();
  await start(s);
  advance(7);
  assert.equal(s._computeCurrentState(1).timeRemaining, 293);
  // The persisted value is only rewritten on a tick (onAlarm) or pause.
  assert.equal(s.timerStates[1].timeRemaining, 300);
});

// ─── Round / phase transitions ────────────────────────────────────────

test('a fight round ending rolls over into the rest phase', async () => {
  const { s } = serverOnMat1({ roundDuration: 3, restDuration: 60, totalRounds: 5, timeRemaining: 3 });
  await start(s);
  advance(3);
  await s.onAlarm();
  const ts = s.timerStates[1];
  assert.equal(ts.phase, 'rest');
  assert.equal(ts.timeRemaining, 60);
  assert.equal(ts.currentRound, 1);
  assert.equal(ts.running, true);
});

test('a rest phase ending starts the next fight round', async () => {
  const { s } = serverOnMat1({ roundDuration: 3, restDuration: 60, totalRounds: 5, timeRemaining: 3 });
  await start(s);
  advance(3);
  await s.onAlarm();        // → rest
  advance(60);
  await s.onAlarm();        // → next fight round
  const ts = s.timerStates[1];
  assert.equal(ts.phase, 'fight');
  assert.equal(ts.currentRound, 2);
  assert.equal(ts.timeRemaining, 3);
  assert.equal(ts.running, true);
});

test('restDuration 0 skips rest and goes straight to the next round', async () => {
  const { s } = serverOnMat1({ roundDuration: 3, restDuration: 0, totalRounds: 3, timeRemaining: 3 });
  await start(s);
  advance(3);
  await s.onAlarm();
  const ts = s.timerStates[1];
  assert.equal(ts.phase, 'fight');
  assert.equal(ts.currentRound, 2);
  assert.equal(ts.timeRemaining, 3);
  assert.equal(ts.running, true);
});

test('the final round ending stops the timer and clears persisted state', async () => {
  const { s, room } = serverOnMat1({ roundDuration: 3, restDuration: 60, totalRounds: 1, timeRemaining: 3 });
  await start(s);
  advance(3);
  await s.onAlarm();
  assert.equal(s.timerStates[1].running, false);
  assert.equal(s.timerStates[1].timeRemaining, 0);
  assert.equal(s._hasAnyRunning(), false);
  assert.equal(await room.storage.get('timerState:1'), undefined);
});

// ─── Reset / reconfigure ──────────────────────────────────────────────

test('reset returns to round 1, fight phase, full duration, stopped', async () => {
  const { s } = serverOnMat1();
  await start(s);
  advance(50);
  await s.onAlarm();
  await send(s, { type: 'timer:reset' });
  const ts = s.timerStates[1];
  assert.equal(ts.running, false);
  assert.equal(ts.currentRound, 1);
  assert.equal(ts.phase, 'fight');
  assert.equal(ts.timeRemaining, ts.roundDuration);
  assert.equal(ts.startedAt, null);
});

test('shrinking roundDuration while paused clamps the remaining time', async () => {
  const { s } = serverOnMat1({ timeRemaining: 300, running: false });
  await send(s, { type: 'timer:config', roundDuration: 120 });
  assert.equal(s.timerStates[1].roundDuration, 120);
  assert.equal(s.timerStates[1].timeRemaining, 120);
});

// ─── Hibernation recovery ─────────────────────────────────────────────

test('onAlarm recovers timer state from storage after DO hibernation', async () => {
  const { s } = serverOnMat1();
  await start(s);          // persists timerState:1
  advance(8);
  s.timerStates[1] = null; // simulate hibernation wiping in-memory state
  await s.onAlarm();
  assert.ok(s.timerStates[1], 'state was reloaded from storage');
  assert.equal(s.timerStates[1].timeRemaining, 292);
});

// ─── Code-review bug regressions ─────────────────────────────────────

// Helpers for tests that go through onConnect (demo room bypasses auth).
function makeDemoRoom() {
  const room = makeRoom();
  room.id = 'demo';
  return room;
}
function makeCtrlConn(id, params = {}) {
  const url = new URL('http://localhost/?role=controller&mats=1&name=Coach&clientId=default-client');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return {
    conn: {
      id,
      _sent: [],
      _closed: false,
      send(msg) { try { this._sent.push(JSON.parse(msg)); } catch {} },
      close() { this._closed = true; },
      setState() {},
    },
    ctx: { request: { url: url.toString() } },
  };
}

// Bug 1 + Bug 4: onConnect preserve-running path must not overwrite ts.mats
// or wipe swStates/activeTab when a running timer survives DO hibernation.
test('onConnect preserve-running does not overwrite mat group or wipe stopwatch state', async () => {
  const room = makeDemoRoom();
  const { conn, ctx } = makeCtrlConn('conn1', { mats: '1', clientId: 'phone-abc' });
  room.getConnections = (tag) => tag === 'controller' ? [conn] : [];

  const s = new BjjTimerServer(room);
  const baseTs = { ...s._newTimerState(), mats: [1, 2],
    running: true, startedAt: Date.now(), timeRemainingAtStart: 200, timeRemaining: 200 };
  await room.storage.put('timerState:1', baseTs);
  await room.storage.put('stopwatchState:1', { running: true, elapsed: 45, ts: Date.now() });
  await s.onStart();

  assert.deepEqual(s.timerStates[1].mats, [1, 2], 'precondition: mat group loaded');
  assert.equal(s.matClientId[1], null, 'precondition: matClientId lost after hibernation');

  await s.onConnect(conn, ctx);

  assert.deepEqual(s.timerStates[1].mats, [1, 2], 'mat group not overwritten by reconnect');
  assert.equal(s.timerStates[1].running, true, 'timer still running');
  assert.equal(s.swStates[1]?.running, true, 'stopwatch state not wiped');
});

// Code review fix: matClientId must persist across DO hibernation. Before this
// fix it was in-memory only, so every post-hibernation reconnect looked like a
// stranger — the true owner fell back through the "preserve running timer"
// path instead of a real reclaim, and a genuinely different coach's device
// could silently take over a mat with a live class (matClientId[p] was always
// falsy, so the busy-mat lock at onConnect never triggered).
test('matClientId persists across hibernation so the true owner reclaims instead of merely preserving', async () => {
  const room = makeDemoRoom();
  const { conn, ctx } = makeCtrlConn('conn1', { mats: '1', clientId: 'phone-abc' });
  room.getConnections = (tag) => tag === 'controller' ? [conn] : [];

  const s = new BjjTimerServer(room);
  const baseTs = { ...s._newTimerState(), mats: [1],
    running: true, startedAt: Date.now(), timeRemainingAtStart: 200, timeRemaining: 200 };
  await room.storage.put('timerState:1', baseTs);
  await room.storage.put('matClientId:1', 'phone-abc'); // persisted by the original connect
  await s.onStart();

  assert.equal(s.matClientId[1], 'phone-abc', 'matClientId recovered from storage');

  await s.onConnect(conn, ctx);

  assert.equal(conn._closed, false, 'the true owner is accepted');
  assert.equal(s.timerStates[1].running, true, 'timer still running');
});

test('a different device is blocked from taking over a hibernated mat with a live class', async () => {
  const room = makeDemoRoom();
  const { conn, ctx } = makeCtrlConn('conn1', { mats: '1', clientId: 'phone-xyz' }); // different clientId
  room.getConnections = (tag) => tag === 'controller' ? [conn] : [];

  const s = new BjjTimerServer(room);
  const baseTs = { ...s._newTimerState(), mats: [1],
    running: true, startedAt: Date.now(), timeRemainingAtStart: 200, timeRemaining: 200 };
  await room.storage.put('timerState:1', baseTs);
  await room.storage.put('matClientId:1', 'phone-abc'); // held by a different device
  await s.onStart();

  await s.onConnect(conn, ctx);

  assert.equal(conn._closed, true, 'a stranger cannot silently bind to a busy mat after hibernation');
  assert.ok(conn._sent.some(m => m.type === 'error'), 'an error is sent explaining the mat is in use');
});

// Code review fix: when preservingRunning kept ts.mats unchanged across a
// hibernation reconnect that requested a smaller mat subset, ctrl.mats (and
// ctrlSlots/ctrlNames for the excluded mat) must still track the timer's full
// group — otherwise ctrl:release/ctrl:rename/onClose, which all iterate
// ctrl.mats, silently skip the excluded mat and its TV is never told to go
// idle or freed.
test('a mat outside the reconnect request but inside the preserved group is still tracked and released', async () => {
  const room = makeDemoRoom();
  const { conn, ctx } = makeCtrlConn('conn1', { mats: '1', clientId: 'phone-new' }); // only requests mat 1
  room.getConnections = (tag) => tag === 'controller' ? [conn] : [];

  const s = new BjjTimerServer(room);
  const baseTs = { ...s._newTimerState(), mats: [1, 2], // group originally covered mats 1+2
    running: true, startedAt: Date.now(), timeRemainingAtStart: 200, timeRemaining: 200 };
  await room.storage.put('timerState:1', baseTs);
  // matClientId was never persisted (e.g. hibernation before this fix shipped),
  // so this reconnect is recognized as preservingRunning, not a reclaim.
  await s.onStart();

  await s.onConnect(conn, ctx);

  assert.deepEqual(s.controllers['conn1'].mats, [1, 2], 'ctrl.mats tracks the full preserved group, not just the request');
  assert.equal(s.ctrlSlots[2], 'conn1', 'mat 2 is bound to this connection so it can later be found and freed');

  await s.onMessage(JSON.stringify({ type: 'ctrl:release' }), conn);

  assert.equal(s.ctrlSlots[2], null, 'mat 2 is freed, not left orphaned, on release');
  assert.equal(s.ctrlNames[2], '', 'mat 2 TV notification path is reached (name cleared)');
});

// Bug 2: onAlarm must recover swStates from storage after DO hibernation so
// a running stopwatch correctly blocks a pending idle sweep.
test('onAlarm recovers swStates from storage and uses it to block an overdue idle sweep', async () => {
  const { s, room } = serverOnMat1();
  await room.storage.put('stopwatchState:1', { running: true, elapsed: 10 });
  s.swStates[1] = null;              // simulate hibernation clearing in-memory state
  s._idleSweepRecovered = true;      // isolate: skip idleSweepAt re-read
  s.idleSweepAt[1] = Date.now() - 1; // overdue sweep
  s.timerStates[1].running = false;  // timer not running — only swStates should block sweep

  await s.onAlarm();

  assert.equal(s.swStates[1]?.running, true, 'swStates recovered from storage');
  assert.ok(s.idleSweepAt[1] !== 0, 'idle sweep held by running stopwatch');
});

// Bug 3: restDuration changes must sync timeRemaining, mirroring the existing
// roundDuration behaviour — both paused and running.
test('restDuration increase while paused at start of rest syncs timeRemaining', async () => {
  const { s } = serverOnMat1({ roundDuration: 3, restDuration: 60, totalRounds: 2, timeRemaining: 3 });
  await start(s);
  advance(3);
  await s.onAlarm();                      // fight ends → rest starts (timeRemaining=60)
  await send(s, { type: 'timer:pause' }); // pause immediately at top of rest

  assert.equal(s.timerStates[1].phase, 'rest');
  assert.equal(s.timerStates[1].timeRemaining, 60);

  await send(s, { type: 'timer:config', restDuration: 120 });
  assert.equal(s.timerStates[1].restDuration, 120);
  assert.equal(s.timerStates[1].timeRemaining, 120, 'timeRemaining follows new restDuration');
});

test('restDuration decrease while paused mid-rest clamps timeRemaining', async () => {
  const { s } = serverOnMat1({ roundDuration: 3, restDuration: 60, totalRounds: 2, timeRemaining: 3 });
  await start(s);
  advance(3);
  await s.onAlarm();   // → rest, timeRemaining=60
  advance(20);
  await s.onAlarm();   // rest has 40s left
  await send(s, { type: 'timer:pause' });

  assert.equal(s.timerStates[1].phase, 'rest');
  assert.equal(s.timerStates[1].timeRemaining, 40);

  await send(s, { type: 'timer:config', restDuration: 30 });
  assert.equal(s.timerStates[1].restDuration, 30);
  assert.equal(s.timerStates[1].timeRemaining, 30, 'clamped down to new restDuration');
});

test('restDuration change while rest is running resets the countdown from the new value', async () => {
  const { s } = serverOnMat1({ roundDuration: 3, restDuration: 60, totalRounds: 2, timeRemaining: 3 });
  await start(s);
  advance(3);
  await s.onAlarm();   // → rest running, timeRemaining=60

  assert.equal(s.timerStates[1].phase, 'rest');
  assert.equal(s.timerStates[1].running, true);

  await send(s, { type: 'timer:config', restDuration: 90 });
  assert.equal(s.timerStates[1].restDuration, 90);
  assert.equal(s.timerStates[1].timeRemaining, 90, 'rest restarted at new duration');
  assert.ok(s.timerStates[1].startedAt > 0, 'startedAt set for resumed rest');
});

// Bug 5: template:save for a concurrently-deleted template must broadcast
// templates:updated so stale clients correct themselves immediately.
test('template:save for a deleted template broadcasts templates:updated', async () => {
  const { s, room } = serverOnMat1();
  s.config = { tvCodes: [], classTemplates: [], branding: {}, profiles: [] };

  const broadcasts = [];
  room.broadcast = (msg) => { try { broadcasts.push(JSON.parse(msg)); } catch {} };

  await send(s, { type: 'template:save', name: 'Round Robin', settings: { roundDuration: 300 } });
  const id = s.config.classTemplates[0]?.id;
  assert.ok(id, 'precondition: template created');

  s.config.classTemplates = []; // simulate concurrent delete

  const countBefore = broadcasts.filter(b => b.type === 'templates:updated').length;
  await send(s, { type: 'template:save', id, name: 'Updated', settings: {} });
  const countAfter = broadcasts.filter(b => b.type === 'templates:updated').length;

  assert.ok(countAfter > countBefore, 'templates:updated broadcast sent on concurrent-delete no-op');
});

// Bug 6: when onAlarm cannot recover a slot's timer state from storage it
// must block a pending idle sweep for that tick only — not by writing a
// permanent {running:true} sentinel into timerStates, which would prevent
// ever reading the real state back from storage again (a transient error
// would wedge the slot forever). The block must be transient: it clears on
// the very next tick once storage succeeds again.
test('onAlarm storage error blocks an idle sweep for that tick without wedging the slot', async () => {
  const { s, room } = serverOnMat1();
  s._idleSweepRecovered = true;
  s.idleSweepAt[1] = Date.now() - 1; // overdue sweep
  s.timerStates[1] = null;            // simulate hibernation
  room._store.set('timerState:1', { ...s._newTimerState(), mats: [1], running: false });

  const origGet = room.storage.get.bind(room.storage);
  room.storage.get = async (k) => {
    if (k === 'timerState:1') throw new Error('transient storage error');
    return origGet(k);
  };

  await s.onAlarm();

  assert.equal(s.timerStates[1], null, 'no permanent sentinel written into timerStates');
  assert.ok(s.idleSweepAt[1] !== 0, 'idle sweep blocked for this tick');
  assert.ok(room._alarms.length >= 1, 'alarm rescheduled so the slot gets a retry');

  // Storage recovers; the next tick must read the real (non-running) state
  // back and let the now-due idle sweep proceed instead of staying wedged —
  // proceeding to finalize (nulling timerStates[1] out again) is only
  // possible if the sweep actually saw the real, non-running state.
  room.storage.get = origGet;
  await s.onAlarm();

  assert.equal(s.idleSweepAt[1], 0, 'idle sweep finally proceeds once state is verified');
  assert.equal(s.timerStates[1], null, 'slot finalized to idle, not stuck on a fake sentinel');
});

// Bug 7: idleSweepAt must be read from storage exactly once per wake cycle,
// not on every 1 Hz tick throughout a normal class.
test('onAlarm reads idleSweepAt from storage only once per wake cycle', async () => {
  const { s, room } = serverOnMat1();
  await start(s);

  let reads = 0;
  const origGet = room.storage.get.bind(room.storage);
  room.storage.get = async (k) => { if (k === 'idleSweepAt') reads++; return origGet(k); };

  await s.onAlarm();
  assert.equal(reads, 1, 'reads idleSweepAt once on first tick after wake');

  advance(1); await s.onAlarm();
  advance(1); await s.onAlarm();
  assert.equal(reads, 1, 'does not re-read idleSweepAt on subsequent ticks');
});

// Code review fix: swStates/timerStates recovery for an idle slot must not
// re-read storage on every tick — only once per wake cycle, same as
// idleSweepAt. Mat 1 running keeps the alarm armed for several ticks; mat 2
// is idle throughout and has nothing in storage, which is the common case
// (3 of 4 mats idle at any time) that was previously re-read every second.
test('onAlarm reads an idle slot\'s stopwatchState from storage only once per wake cycle', async () => {
  const { s, room } = serverOnMat1();
  await start(s);

  let reads = 0;
  const origGet = room.storage.get.bind(room.storage);
  room.storage.get = async (k) => { if (k === 'stopwatchState:2') reads++; return origGet(k); };

  await s.onAlarm();
  assert.equal(reads, 1, 'reads mat 2\'s stopwatchState once on first tick after wake');

  advance(1); await s.onAlarm();
  advance(1); await s.onAlarm();
  assert.equal(reads, 1, 'does not re-read mat 2\'s stopwatchState on subsequent ticks while it stays idle');
});

// ─── Client-side duration change bug ─────────────────────────────────
// User sets 5 min, starts, pauses at 4 min (240 sec remaining), then tries
// to increase duration to 6+ min. Client must clamp to current timeRemaining
// when paused mid-round, not blindly set to new roundDuration.
test('paused mid-round: increasing duration clamps timeRemaining to current value', async () => {
  const { s } = serverOnMat1({ roundDuration: 300 });
  await start(s);
  advance(60);           // 1 minute elapsed: 240 sec remaining
  await s.onAlarm();     // process elapsed time
  await send(s, { type: 'timer:pause' });

  assert.equal(s.timerStates[1].running, false);
  assert.equal(s.timerStates[1].roundDuration, 300);
  assert.equal(s.timerStates[1].timeRemaining, 240);

  // User increases duration to 6 min (360 sec)
  await send(s, { type: 'timer:config', roundDuration: 360 });

  // Server should NOT add time mid-round (unfair) — clamp to current 240 sec
  assert.equal(s.timerStates[1].roundDuration, 360);
  assert.equal(s.timerStates[1].timeRemaining, 240, 'timeRemaining clamped to current value, not increased to 360');
});

test('paused mid-round: decreasing duration clamps timeRemaining down', async () => {
  const { s } = serverOnMat1({ roundDuration: 300 });
  await start(s);
  advance(60);
  await s.onAlarm();
  await send(s, { type: 'timer:pause' });

  assert.equal(s.timerStates[1].timeRemaining, 240);

  // User decreases duration to 2 min (120 sec)
  await send(s, { type: 'timer:config', roundDuration: 120 });

  // Server should clamp down: 240 > 120, so set to 120
  assert.equal(s.timerStates[1].roundDuration, 120);
  assert.equal(s.timerStates[1].timeRemaining, 120, 'timeRemaining clamped down to new roundDuration');
});

test('paused at full duration: changing duration updates timeRemaining freely', async () => {
  const { s } = serverOnMat1({ roundDuration: 300 });
  await send(s, { type: 'timer:pause' }); // pause before starting

  assert.equal(s.timerStates[1].timeRemaining, 300);
  assert.equal(s.timerStates[1].roundDuration, 300);

  // Change to 2 min (at full duration, so should allow it)
  await send(s, { type: 'timer:config', roundDuration: 120 });
  assert.equal(s.timerStates[1].timeRemaining, 120);

  // Change back to 5 min (still at full duration of 120, now increasing to 300)
  await send(s, { type: 'timer:config', roundDuration: 300 });
  assert.equal(s.timerStates[1].timeRemaining, 300, 'can increase when at full duration');
});
