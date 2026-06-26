# TV Display Progress Bar + Round Indicator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-width, phase-colored progress bar that depletes along the bottom of the TV display, plus a round indicator shown by default, so the countdown is readable at a glance from across a gym.

**Architecture:** A pure `roundProgress(state)` helper (UMD, browser + Node) computes the fraction of the current phase remaining. `applyProgress()` in `app.js` drives a CSS `transform: scaleX()` transition on a bar element — running depletes to empty over the remaining seconds; paused/reset freeze. Phase color rides the existing `.phase-rest` class. The round indicator reuses the existing `#displayRound` render path with its default flipped on. No server/protocol changes.

**Tech Stack:** Vanilla JS (browser `<script>`, no module system), CSS custom properties, `node:test`, PartyKit (`party/main.js`).

## Global Constraints

- **Cache lockstep (enforced by `.githooks/pre-commit`):** any commit touching `public/` must bump `CACHE_NAME` in `public/sw.js` AND `main.css?v=` AND `app.js?v=` in `public/index.html` to the **same** new number, greater than HEAD's. Current value at branch HEAD: **v38**. This plan advances v38 → v39 → v40 → v41 (one bump per `public/`-touching commit).
- **Helper location:** the pure helper lives in `public/js/progress.js`, NOT `lib/` — Vercel serves only `public/` (`vercel.json` `outputDirectory: "public"`); `lib/` is server-side only and the browser can't load it.
- **Branch:** `feat/tv-display-progress` (already created; spec already committed).
- **Scope:** TV display view only. Do not touch the controller timer.
- **Phase colors:** fight = `var(--mat-red)`, rest = `var(--go-color)` (existing tokens).
- **Commit message trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Pure `roundProgress` helper + unit tests

**Files:**
- Create: `public/js/progress.js`
- Create: `test/progress.test.js`
- Modify: `public/index.html` (add `<script>` before app.js; bump `?v=`)
- Modify: `public/sw.js` (add to `ASSETS`; bump `CACHE_NAME`)

**Interfaces:**
- Produces: `roundProgress(state) -> number` where `state` has `{ phase: 'fight'|'rest', roundDuration: number, restDuration: number, timeRemaining: number }`. Returns a clamped fraction in `[0,1]`. Exposed as `window.roundProgress` in the browser and `module.exports.roundProgress` in Node.

- [ ] **Step 1: Write the failing test**

Create `test/progress.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roundProgress } = require('../public/js/progress.js');

test('full fight round → fraction 1', () => {
  assert.equal(roundProgress({ phase: 'fight', roundDuration: 300, restDuration: 60, timeRemaining: 300 }), 1);
});

test('half a fight round → 0.5', () => {
  assert.equal(roundProgress({ phase: 'fight', roundDuration: 300, restDuration: 60, timeRemaining: 150 }), 0.5);
});

test('rest phase uses restDuration', () => {
  assert.equal(roundProgress({ phase: 'rest', roundDuration: 300, restDuration: 60, timeRemaining: 30 }), 0.5);
});

test('empty round → 0', () => {
  assert.equal(roundProgress({ phase: 'fight', roundDuration: 300, restDuration: 60, timeRemaining: 0 }), 0);
});

test('timeRemaining greater than full clamps to 1', () => {
  assert.equal(roundProgress({ phase: 'fight', roundDuration: 300, restDuration: 60, timeRemaining: 400 }), 1);
});

test('negative timeRemaining clamps to 0', () => {
  assert.equal(roundProgress({ phase: 'fight', roundDuration: 300, restDuration: 60, timeRemaining: -5 }), 0);
});

test('zero-duration guard returns 0 (no divide-by-zero)', () => {
  assert.equal(roundProgress({ phase: 'rest', roundDuration: 300, restDuration: 0, timeRemaining: 0 }), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/progress.test.js`
Expected: FAIL — `Cannot find module '../public/js/progress.js'`.

- [ ] **Step 3: Create the helper**

Create `public/js/progress.js`:

```js
// Pure helper for the TV display progress bar: the fraction (0..1) of the
// current phase still remaining. Browser-loaded via <script> (sets
// window.roundProgress) and required by test/progress.test.js (module.exports).
// No DOM, no dependencies.
(function (root) {
  function roundProgress(s) {
    const full = s.phase === 'rest' ? s.restDuration : s.roundDuration;
    if (!full || full <= 0) return 0;
    return Math.max(0, Math.min(1, s.timeRemaining / full));
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { roundProgress };
  root.roundProgress = roundProgress;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/progress.test.js`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Wire the helper into the page**

In `public/index.html`, add the script tag immediately BEFORE the app.js tag (so `window.roundProgress` exists when app.js loads). Change:

```html
<script src="/js/app.js?v=38"></script>
```

to:

```html
<script src="/js/progress.js?v=39"></script>
<script src="/js/app.js?v=39"></script>
```

In `public/index.html`, bump the CSS link `?v=`:

```html
<link rel="stylesheet" href="/css/main.css?v=39">
```

- [ ] **Step 6: Add the helper to the service-worker precache and bump CACHE_NAME**

In `public/sw.js`, change `const CACHE_NAME  = 'bjj-timer-v38';` to `const CACHE_NAME  = 'bjj-timer-v39';`.

In the `ASSETS` array, add `'/js/progress.js',` after the `'/js/app.js',` line:

```js
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/main.css',
  '/js/app.js',
  '/js/progress.js',
  '/js/spotify.js',
  '/spotify-config.js',
  '/supabase.js',
  '/supabase-config.js',
  '/partysocket.js',
  '/partykit-config.js',
];
```

- [ ] **Step 7: Verify the full suite and lint pass**

Run: `npm test`
Expected: all tests pass (previous total + 7 new).
Run: `npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add public/js/progress.js test/progress.test.js public/index.html public/sw.js
git commit -m "$(cat <<'EOF'
Add roundProgress helper for the TV display progress bar

Pure UMD helper (browser + node:test) computing the fraction of the current
phase remaining, with clamping and a zero-duration guard. Wired into the page
and SW precache; asset version bumped to v39.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

Expected: the pre-commit hook passes (CACHE_NAME/css/js all at v39, bumped vs HEAD's v38).

---

### Task 2: Progress bar markup, styles, and depletion logic

**Files:**
- Modify: `public/index.html` (bar markup inside `#displayInner`; bump `?v=` to v40)
- Modify: `public/css/main.css` (bar styles; bump `?v=` to v40)
- Modify: `public/js/app.js` (`timerPanelActive`, `applyProgress`, two call sites; bump `?v=` to v40)
- Modify: `public/sw.js` (bump `CACHE_NAME` to v40)

**Interfaces:**
- Consumes: `roundProgress(state)` from Task 1 (global `window.roundProgress`).
- Consumes (existing in `app.js`): `mode` (string, `'display'` on a TV), `_isIdleClockMode()` (`app.js:2432`), `_displayTab` (`app.js:2428`), `state` (global timer state), `applyStateSnapshot(s)` (`app.js:2256`), `_refreshDisplayMode()` (`app.js:2438`).
- Produces: `timerPanelActive() -> boolean`, `applyProgress(s)` (side-effecting DOM updater).

- [ ] **Step 1: Add the bar markup**

In `public/index.html`, inside `#displayInner` (the element opened at `id="displayInner"`), add the bar as the LAST child before `#displayInner` closes — place it immediately after the `#displayQr` block (`id="displayQr"` … closing `</div>`):

```html
<div class="display-progress" id="displayProgress" style="display:none">
  <div class="display-progress-fill" id="displayProgressFill"></div>
</div>
```

- [ ] **Step 2: Add the bar styles**

In `public/css/main.css`, add after the `.display-clock` rule (around line 213):

```css
  .display-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 12px; background: rgba(255,255,255,.06); z-index: 1; pointer-events: none; }
  .display-progress-fill { height: 100%; width: 100%; transform-origin: left; transform: scaleX(1); background: var(--mat-red); will-change: transform; }
  .display-inner.phase-rest .display-progress-fill { background: var(--go-color); }
  @media (prefers-reduced-motion: reduce) { .display-progress-fill { transition: none !important; } }
```

- [ ] **Step 3: Add `timerPanelActive` and `applyProgress` in app.js**

In `public/js/app.js`, add these two functions immediately AFTER the `_refreshDisplayMode` function (which ends at `app.js:2465` with its closing `}`):

```js
// True when the countdown timer panel is the active display view (not the
// stopwatch tab, not an idle wall-clock). Mirrors the show condition for
// #displayPanelTimer in _refreshDisplayMode().
function timerPanelActive() {
  return mode === 'display' && !_isIdleClockMode() && _displayTab === 'timer';
}

// Drive the bottom progress bar. Running → deplete to empty over the remaining
// seconds via a linear CSS transform transition; paused/reset → freeze at the
// current fraction. Seeds from the same timeRemaining as the number, so the two
// stay in sync without touching the throttled rAF interpolation loop.
function applyProgress(s) {
  const wrap = document.getElementById('displayProgress');
  const fill = document.getElementById('displayProgressFill');
  if (!wrap || !fill) return;
  const full = s.phase === 'rest' ? s.restDuration : s.roundDuration;
  if (!timerPanelActive() || !full || full <= 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const frac = roundProgress(s);
  fill.style.transition = 'none';            // freeze at the current fraction
  fill.style.transform  = 'scaleX(' + frac + ')';
  void fill.offsetWidth;                       // force reflow so the transition starts from frac
  if (s.running && s.timeRemaining > 0) {
    fill.style.transition = 'transform ' + s.timeRemaining + 's linear';
    fill.style.transform  = 'scaleX(0)';       // deplete to empty over the remaining time
  }
}
```

- [ ] **Step 4: Call `applyProgress` from the two drivers**

In `public/js/app.js`, in `applyStateSnapshot` (`app.js:2256`), add a call right before the `_seedTimerInterp();` line (currently `app.js:2269`):

```js
  applyProgress(state);
  _seedTimerInterp();
```

In `public/js/app.js`, at the END of `_refreshDisplayMode` (so the bar hides/shows when the panel mode changes), add a call right before its closing brace, after the `updateDisplayClock();` line (`app.js:2464`):

```js
  updateDisplayClock();
  applyProgress(state);
```

- [ ] **Step 5: Bump asset versions to v40**

In `public/index.html`: `main.css?v=39` → `v=40`, `progress.js?v=39` → `v=40`, `app.js?v=39` → `v=40`.
In `public/sw.js`: `CACHE_NAME` `bjj-timer-v39` → `bjj-timer-v40`.

- [ ] **Step 6: Verify lint and the existing suite still pass**

Run: `npm run lint`
Expected: no errors.
Run: `npm test`
Expected: all tests pass (no behavior change to tested code).

- [ ] **Step 7: Manual browser verification**

Run the app locally (`npx partykit dev` + `vercel dev`, or open the deployed preview) and, on a TV display (`?room=demo`, connect a TV, start the timer from a controller):
- Bar depletes left-to-right-empty smoothly during a fight round (red).
- On round end → rest, the bar resets full and turns green.
- Pause freezes the bar; resume continues from the frozen point.
- Reset returns the bar to full.
- Switching the controller to the stopwatch tab hides the bar; switching back shows it.
Capture a before/after screenshot of the display for the PR.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/css/main.css public/js/app.js public/sw.js
git commit -m "$(cat <<'EOF'
Add depleting progress bar to the TV display

Full-width bottom bar that depletes over the remaining phase time via a CSS
scaleX transition; red in fight, green in rest. Hidden on the stopwatch tab and
idle-clock views. Asset version bumped to v40.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

Expected: pre-commit hook passes (all three at v40).

---

### Task 3: Round indicator — default on + rest-phase label

**Files:**
- Modify: `public/js/app.js` (`showRound` default; rest-phase round label; bump `?v=` to v41)
- Modify: `public/index.html` (bump `?v=` to v41)
- Modify: `public/sw.js` (bump `CACHE_NAME` to v41)
- Modify: `party/main.js` (`showRound` default ×2)

**Interfaces:**
- Consumes: existing `#displayRound` render in `applyStateSnapshot` (`app.js:2260-2262`), `state.currentRound`, `state.totalRounds`, `state.showRound`.
- Produces: no new symbols. Behavior change only.

- [ ] **Step 1: Flip the client default**

In `public/js/app.js` line 1129, change `showRound: false,` to `showRound: true,`.

- [ ] **Step 2: Flip the server defaults**

In `party/main.js` line 9 (`DEFAULT_SETTINGS`), change `showRound: false,` to `showRound: true,`.
In `party/main.js` line 902 (`_newTimerState()`), change `showRound: false,` to `showRound: true,`.

- [ ] **Step 3: Keep the round number visible during rest**

In `public/js/app.js`, in `applyStateSnapshot` (`app.js:2261`), change:

```js
    roundEl.textContent = state.phase === 'rest' ? 'REST' : `Round ${state.currentRound} of ${state.totalRounds}`;
```

to:

```js
    roundEl.textContent = `Round ${state.currentRound} of ${state.totalRounds}`;
```

(The `#displayPhase` element already shows "REST" during rest, so the round line now complements it instead of duplicating "REST". `currentRound` is the just-completed round during rest, disambiguated by the REST phase label.)

- [ ] **Step 4: Bump asset versions to v41**

In `public/index.html`: `main.css?v=40` → `v=41`, `progress.js?v=40` → `v=41`, `app.js?v=40` → `v=41`.
In `public/sw.js`: `CACHE_NAME` `bjj-timer-v40` → `bjj-timer-v41`.

- [ ] **Step 5: Verify lint and the full suite pass**

Run: `npm run lint`
Expected: no errors.
Run: `npm test`
Expected: all tests pass (the party-timer suite still green — `showRound` is not asserted there; if any assertion references `showRound: false`, update it to `true`).

- [ ] **Step 6: Manual browser verification**

On a TV display: the round indicator ("Round 1 of 5") is visible by default without changing any setting; during rest it shows the round number while the phase label reads REST. Toggling "Show round" off in settings still hides it.

- [ ] **Step 7: Commit**

```bash
git add public/js/app.js public/index.html public/sw.js party/main.js
git commit -m "$(cat <<'EOF'
Show the round indicator by default on the TV display

Flip the showRound default to on (client + party defaults) and keep the round
number visible during rest so it complements the REST phase label instead of
duplicating it. Asset version bumped to v41.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

Expected: pre-commit hook passes (all three at v41).

---

## Manual verification summary (whole feature)

After all three tasks, on a TV display (`?room=demo`):
1. Round indicator visible by default.
2. Progress bar depletes smoothly, red in fight / green in rest, full→empty each phase.
3. Pause freezes the bar; resume continues; reset refills.
4. Final round end leaves the bar empty with the TIME! overlay.
5. Stopwatch tab and idle-clock modes hide the bar.
6. `npm test` and `npm run lint` green; pre-commit hook satisfied at v41.

## Self-review notes

- Spec coverage: §1 markup → Task 2.1; §2 CSS → Task 2.2; §3 helper → Task 1; §4 applyProgress → Task 2.3-2.4; §3-round-indicator → Task 3; edge cases (pause/reset/stopwatch/idle/reduced-motion) → Task 2.2 + 2.3 + manual checks; testing → Task 1 tests + manual steps. All covered.
- The `showRound` default flip affects only new/unset state; gyms with it saved as `false` keep it (documented in spec "Backward compatibility").
