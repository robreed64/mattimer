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
