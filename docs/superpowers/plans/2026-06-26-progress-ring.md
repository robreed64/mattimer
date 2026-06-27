# TV Progress Ring (Oval) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the under-time progress bar with a bold oval ring encircling the countdown that depletes as the phase counts down, so it reads from across a gym.

**Architecture:** Swap the bar `<div>` for an SVG `<ellipse>` ring as the first child of `#displayPanelTimer` (behind the text). `applyProgress` changes from animating `transform: scaleX` to animating `stroke-dashoffset` on the ring; the fraction math (`roundProgress`), the `timerPanelActive` gate, and the round indicator are unchanged. Markup + CSS + one JS function.

**Tech Stack:** Vanilla HTML/SVG/CSS, `node:test` (unchanged suite), PartyKit (no server change).

## Global Constraints

- **Cache lockstep (enforced by `.githooks/pre-commit`):** this touches `public/`, so bump `CACHE_NAME` in `public/sw.js` AND `main.css?v=` AND `app.js?v=` in `public/index.html` to the same new number, greater than HEAD. Current: **v42** → bump to **v43** (also bump `progress.js?v=` to 43 to stay uniform).
- **Branch:** `feat/progress-ring` (already created; spec revision 2 already committed).
- **Reuse, don't change:** `roundProgress(s)` and `timerPanelActive()` are unchanged. Only `applyProgress` and markup/CSS change. Element IDs change from `displayProgress`/`displayProgressFill` to `displayRing`/`displayRingProg`.
- **Scope:** TV display only. Ring depletes clockwise from 12 o'clock; red fight (`var(--mat-red)`), green rest (`var(--go-color)`).

---

### Task 1: Replace the bar with an oval progress ring

**Files:**
- Modify: `public/index.html` (swap bar markup for the SVG ring inside `#displayPanelTimer`; bump `?v=`)
- Modify: `public/css/main.css:214-217` (replace `.display-progress*` rules with ring rules; make the panel a positioning context)
- Modify: `public/js/app.js:2480-2495` (rewrite `applyProgress` to drive the ring)
- Modify: `public/sw.js` (bump `CACHE_NAME`)

**Interfaces:**
- Consumes: `roundProgress(s)` and `timerPanelActive()` (both unchanged, in `app.js`).
- Produces: revised `applyProgress(s)` targeting `#displayRing` / `#displayRingProg`.

- [ ] **Step 1: Remove the old bar markup**

In `public/index.html`, delete the bar block (lines 730–732):

```html
      <div class="display-progress" id="displayProgress" style="display:none">
        <div class="display-progress-fill" id="displayProgressFill"></div>
      </div>
```

- [ ] **Step 2: Insert the ring as the first child of `#displayPanelTimer`**

In `public/index.html`, change the panel opening:

```html
    <div id="displayPanelTimer">
      <div class="display-round" id="displayRound" style="display:none">Round 1 of 3</div>
```

to:

```html
    <div id="displayPanelTimer">
      <svg class="display-ring" id="displayRing" viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid meet" style="display:none">
        <ellipse class="display-ring-track" cx="500" cy="280" rx="470" ry="250"/>
        <ellipse class="display-ring-prog" id="displayRingProg" cx="500" cy="280" rx="470" ry="250"
                 pathLength="100" stroke-dasharray="100" stroke-dashoffset="0"/>
      </svg>
      <div class="display-round" id="displayRound" style="display:none">Round 1 of 3</div>
```

- [ ] **Step 3: Replace the bar CSS with ring CSS**

In `public/css/main.css`, replace lines 214–217 (the four `.display-progress*` / media rules):

```css
  .display-progress { width: min(62%, 900px); height: clamp(16px, 2.6vh, 30px); margin-top: clamp(1rem, 3.5vh, 2.75rem); background: rgba(255,255,255,.10); border-radius: 999px; overflow: hidden; pointer-events: none; }
  .display-progress-fill { height: 100%; width: 100%; transform-origin: left; transform: scaleX(1); background: var(--mat-red); border-radius: 999px; will-change: transform; }
  .display-inner.phase-rest .display-progress-fill { background: var(--go-color); }
  @media (prefers-reduced-motion: reduce) { .display-progress-fill { transition: none !important; } }
```

with:

```css
  #displayPanelTimer { position: relative; }
  .display-ring { position: absolute; width: min(82vw, 1150px); aspect-ratio: 1000 / 560; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 0; pointer-events: none; overflow: visible; }
  .display-ring-track { fill: none; stroke: rgba(255,255,255,.10); stroke-width: 30; }
  .display-ring-prog { fill: none; stroke: var(--mat-red); stroke-width: 30; stroke-linecap: round; transform: rotate(-90deg); transform-origin: center; will-change: stroke-dashoffset; }
  .display-inner.phase-rest .display-ring-prog { stroke: var(--go-color); }
  @media (prefers-reduced-motion: reduce) { .display-ring-prog { transition: none !important; } }
```

(`#displayPanelTimer { position: relative }` makes the absolute ring center on the panel. The ring is the first child but the text siblings come after it in the DOM, so they paint on top.)

- [ ] **Step 4: Rewrite `applyProgress` to drive the ring**

In `public/js/app.js`, replace the whole `applyProgress` function (lines 2480–2495):

```js
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

with:

```js
function applyProgress(s) {
  const ring = document.getElementById('displayRing');
  const prog = document.getElementById('displayRingProg');
  if (!ring || !prog) return;
  const full = s.phase === 'rest' ? s.restDuration : s.roundDuration;
  if (!timerPanelActive() || !full || full <= 0) { ring.style.display = 'none'; return; }
  ring.style.display = '';
  const frac = roundProgress(s);
  prog.style.transition = 'none';                          // freeze at the current fraction
  prog.style.strokeDashoffset = String(100 * (1 - frac));  // visible arc = frac of the ring
  void prog.getBoundingClientRect();                        // force reflow so the transition starts here
  if (s.running && s.timeRemaining > 0) {
    prog.style.transition = 'stroke-dashoffset ' + s.timeRemaining + 's linear';
    prog.style.strokeDashoffset = '100';                    // deplete to empty over the remaining time
  }
}
```

- [ ] **Step 5: Bump asset versions to v43**

In `public/index.html`: `main.css?v=42` → `v=43`, `progress.js?v=42` → `v=43`, `app.js?v=42` → `v=43`.
In `public/sw.js`: `CACHE_NAME` `bjj-timer-v42` → `bjj-timer-v43`.

- [ ] **Step 6: Verify lint and the existing suite pass**

Run: `npm run lint`
Expected: no errors. (If eslint flags the now-unused old IDs, there are none — `applyProgress` no longer references `displayProgress`.)
Run: `npm test`
Expected: all tests pass (50; `roundProgress` math unchanged).

- [ ] **Step 7: Manual / DOM verification**

Preferred (deploy preview or local TV display, `?room=demo`, connect a TV, start a timer):
- A bold oval ring encircles the `5:00`; the red arc shrinks clockwise from the top as the round counts down.
- Round end → rest: ring resets full and turns green.
- Pause freezes the arc; resume continues; reset refills.
- Stopwatch tab / idle-clock hides the ring.

If a live check is impractical, confirm structurally: `#displayRing` is the first child of `#displayPanelTimer`, `#displayRingProg` exists with `pathLength="100"`, and `applyProgress` sets `strokeDashoffset` (grep). Rely on the deploy preview for the across-the-room look.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/css/main.css public/js/app.js public/sw.js
git commit -m "$(cat <<'EOF'
Replace progress bar with an oval ring around the clock

Bold SVG ellipse ring encircling the countdown, depleting clockwise via
stroke-dashoffset; red fight / green rest. roundProgress + round indicator
unchanged. Asset version bumped to v43.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

Expected: pre-commit hook passes (CACHE_NAME/css/js all at v43).

---

## Self-review notes

- **Spec coverage (Revision 2):** form/markup → Steps 1–2; CSS (sizing, colors, rotate-90 start, reduced-motion) → Step 3; depletion via stroke-dashoffset → Step 4; unchanged `roundProgress`/`timerPanelActive`/round indicator → honored (Global Constraints, not modified); bar removal → Steps 1 & 3; cache lockstep → Step 5. All covered.
- **No placeholders:** every step has exact before/after code and commands.
- **Type/ID consistency:** new IDs `displayRing` / `displayRingProg` used consistently across markup (Step 2), CSS (Step 3), and JS (Step 4). Old `displayProgress*` fully removed.
- **No new tests:** `roundProgress` is unchanged, so `test/progress.test.js` remains valid; the change is DOM/animation glue, verified manually.
