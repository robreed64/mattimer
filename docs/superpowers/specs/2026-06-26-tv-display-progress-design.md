# TV Display: Progress Bar + Round Indicator

**Date:** 2026-06-26
**Status:** Approved (design)
**Scope:** TV display view only (`#display` / `#displayInner` in `public/index.html`)

## Goal

Make the wall-TV countdown readable at a glance from across a noisy gym, where
students are 30–40 ft away and can't parse the digits mid-roll. Two additions:

1. A **full-width progress bar** along the bottom edge of the display that
   depletes as the current phase (fight round or rest) counts down, colored by
   phase (red fight / green rest).
2. A **round indicator** ("Round 2 of 5") shown by default, so everyone on the
   mat knows where they are in the class.

Non-goals: the coach's controller timer (out of scope — the coach controls the
timer and reads the number up close); whole-session progress (the bar tracks the
current phase only).

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Indicator form | Full-width bar at the bottom edge | Largest horizontal motion, most readable at distance, no competition with the time |
| Progress semantics | Current phase only (resets each round/rest) | The actionable question is "how much of *this* round is left" |
| Animation | CSS `transform: scaleX()` transition (GPU-composited) | Smooth, near-free, decoupled from the number's throttled rAF repaint |
| Round indicator | Respect existing `showRound` setting, default flipped to ON | Backward-compatible; owners can still hide it |
| Scope | TV display only | The bar's value is the across-the-room glance |

## Components

### 1. Markup (`public/index.html`, inside `#displayInner`)

```html
<div class="display-progress" id="displayProgress">
  <div class="display-progress-fill" id="displayProgressFill"></div>
</div>
```

`#displayInner` is already `position: relative`, so the bar absolutely-positions
to the bottom edge. The wall clock (`bottom: 1.25rem`) and QR sit above it — no
overlap.

### 2. CSS (`public/css/main.css`)

```css
.display-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 12px;
  background: rgba(255,255,255,.06); z-index: 1; }
.display-progress-fill { height: 100%; width: 100%; transform-origin: left;
  transform: scaleX(1); background: var(--mat-red); }
.display-inner.phase-rest .display-progress-fill { background: var(--go-color); }

@media (prefers-reduced-motion: reduce) {
  .display-progress-fill { transition: none !important; }
}
```

Depletion animates via `scaleX()` (compositor, no layout thrash). Phase color
rides the **existing** `.phase-rest` toggle on `#displayInner` — no extra JS for
color.

### 3. Pure fraction helper (`lib/progress.js`, CJS)

```js
function roundProgress(s) {
  const full = s.phase === 'rest' ? s.restDuration : s.roundDuration;
  if (!full || full <= 0) return 0;
  return Math.max(0, Math.min(1, s.timeRemaining / full));
}
module.exports = { roundProgress };
```

Lives in `lib/` (alongside the other shared helpers) so it is unit-testable
without restructuring the monolithic `public/js/app.js`. Loaded by both `app.js`
and the test.

### 4. Depletion / freeze logic (`public/js/app.js`)

Called from `applyStateSnapshot()` after the existing `Object.assign(state, s)`:

```js
function applyProgress(s) {
  const wrap = document.getElementById('displayProgress');
  const fill = document.getElementById('displayProgressFill');
  // Hide unless the timer panel is the active view (not stopwatch / idle clock).
  if (!timerPanelActive()) { wrap.style.display = 'none'; return; }
  const full = s.phase === 'rest' ? s.restDuration : s.roundDuration;
  if (!full || full <= 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const frac = roundProgress(s);
  fill.style.transition = 'none';            // freeze at current fraction
  fill.style.transform  = `scaleX(${frac})`;
  void fill.offsetWidth;                       // force reflow so transition starts here
  if (s.running && s.timeRemaining > 0) {
    fill.style.transition = `transform ${s.timeRemaining}s linear`;
    fill.style.transform  = 'scaleX(0)';       // deplete to empty over remaining time
  }
}
```

`timerPanelActive()` reuses the same condition that shows/hides
`#displayPanelTimer` (vs. the stopwatch panel and the idle big-digital / analog
clock modes). The bar seeds from the same `timeRemaining` as the number, so the
two stay in sync without hooking the throttled rAF interpolation loop.

### 5. Round indicator default

Flip `showRound` default `false → true` in all three default sites:
- `public/js/app.js` client state default (~line 1129)
- `party/main.js` `DEFAULT_SETTINGS` (~line 9)
- `party/main.js` `_newTimerState()` (~line 902)

The display already renders `#displayRound` gated by `state.showRound`
(`app.js:2262`) — no new render code. **Polish:** during rest, keep
`#displayRound` showing the round number rather than "REST" (the phase label
already says REST), so the two lines complement rather than duplicate
(`app.js:2261`). The number shown is `currentRound` — the just-completed round
(the server increments `currentRound` only when the next fight round starts, see
`party/main.js` `_handlePhaseEnd`). So the rest screen reads "Round 1 of 5" +
"REST" = resting after round 1, which the REST phase label disambiguates.

## Edge cases

| Case | Behavior |
|---|---|
| Pause | Transition removed; bar frozen at current fraction |
| Reset | `timeRemaining == full`, not running → bar full, static |
| Final round ends / "TIME!" | `timeRemaining: 0, running: false` → bar empty; overlay shows TIME! |
| Stopwatch tab active | Timer panel hidden → bar hidden |
| Idle clock modes (big digital / analog) | Timer panel hidden → bar hidden |
| Grouped mats (mirrored TVs) | Same state snapshot → identical bar; no special handling |
| SW-restored state after server restart | Re-seeds from the restored snapshot, same as the number |
| `prefers-reduced-motion` | Bar kept (it's information); smooth transition dropped — snaps per-second tick |

## Data flow

Server `state` message → `applyStateSnapshot(s)` → `Object.assign(state, s)` →
existing phase/round render + new `applyProgress(s)`. No server/protocol change:
all fields (`phase`, `timeRemaining`, `roundDuration`, `restDuration`,
`currentRound`, `totalRounds`, `running`, `showRound`) are already in the state
snapshot.

## Backward compatibility

Flipping the `showRound` default affects only new gyms/profiles and the fallback
when the value is unset. Gyms with `showRound` already persisted as `false` keep
it off until they toggle it.

## Testing

- **Unit (`test/progress.test.js`, `node:test`):** `roundProgress()` — fight
  fraction, rest fraction, clamp at 1 (full) and 0 (empty), `timeRemaining > full`
  clamps to 1, zero/negative-duration guard returns 0.
- **Manual:** browser verification of the depletion animation, pause-freeze,
  phase color change, and panel-visibility gating; before/after screenshot.

## Cache versioning

Touches `public/` (index.html, main.css, app.js), so bump all three asset
versions in lockstep per `CLAUDE.md` (`CACHE_NAME` + both `?v=`). The pre-commit
hook enforces this.

## Files touched

- `public/index.html` — progress markup; `?v=` bump
- `public/css/main.css` — bar styles
- `public/js/app.js` — `applyProgress`, `showRound` default, rest-round label; `?v=` bump
- `public/sw.js` — `CACHE_NAME` bump
- `party/main.js` — `showRound` default (×2)
- `lib/progress.js` — new pure helper
- `test/progress.test.js` — new unit tests
