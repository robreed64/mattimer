# Move TV Progress Bar Under the Time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the thin 12px bottom-edge progress bar with a thick, rounded bar centered directly under the countdown, so it reads from across a gym.

**Architecture:** Markup + CSS only. The element keeps its IDs (`#displayProgress` / `#displayProgressFill`), so the existing depletion engine (`applyProgress` + `roundProgress` in `app.js`) works unchanged. The bar moves from an absolute-positioned child at the bottom of `#displayInner` to an in-flow child of `#displayPanelTimer`, immediately after `#displayTime`.

**Tech Stack:** Vanilla HTML/CSS, PartyKit (no server change), `node:test` for the unchanged unit suite.

## Global Constraints

- **Cache lockstep (enforced by `.githooks/pre-commit`):** this touches `public/`, so bump `CACHE_NAME` in `public/sw.js` AND `main.css?v=` AND `app.js?v=` in `public/index.html` to the same new number, greater than HEAD. Current value: **v41** → bump to **v42** (also bump `progress.js?v=` to 42 to stay uniform, though the hook only checks the three).
- **Branch:** `feat/progress-bar-under-time` (already created; spec revision already committed).
- **No JS change:** do NOT modify `applyProgress`, `roundProgress`, or `timerPanelActive`. Element IDs are unchanged.
- **Scope:** TV display only. Depletion stays left-origin (drains right→left), red fight / green rest.

---

### Task 1: Reposition and restyle the progress bar

**Files:**
- Modify: `public/index.html` (move bar markup from `#displayInner` bottom to under `#displayTime`; bump `?v=`)
- Modify: `public/css/main.css:214-217` (replace bar geometry)
- Modify: `public/sw.js` (bump `CACHE_NAME`)

**Interfaces:**
- Consumes: existing `applyProgress(s)` / `roundProgress(s)` in `public/js/app.js` (unchanged — they target `#displayProgress` / `#displayProgressFill` by ID).
- Produces: no new symbols.

- [ ] **Step 1: Remove the bar from its current bottom-edge location**

In `public/index.html`, delete the existing block (currently after the `#displayQr` block, around lines 766–768):

```html

    <div class="display-progress" id="displayProgress" style="display:none">
      <div class="display-progress-fill" id="displayProgressFill"></div>
    </div>
```

(Delete those lines including the blank line above the opening `<div`.)

- [ ] **Step 2: Re-insert the bar directly under the time**

In `public/index.html`, find the `#displayTime` line inside `#displayPanelTimer`:

```html
      <div class="display-time" id="displayTime">5:00</div>
```

Add the bar immediately after it:

```html
      <div class="display-time" id="displayTime">5:00</div>
      <div class="display-progress" id="displayProgress" style="display:none">
        <div class="display-progress-fill" id="displayProgressFill"></div>
      </div>
```

- [ ] **Step 3: Replace the bar CSS**

In `public/css/main.css`, replace lines 214–217 (the four `.display-progress*` / media rules):

```css
  .display-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 12px; background: rgba(255,255,255,.06); z-index: 1; pointer-events: none; }
  .display-progress-fill { height: 100%; width: 100%; transform-origin: left; transform: scaleX(1); background: var(--mat-red); will-change: transform; }
  .display-inner.phase-rest .display-progress-fill { background: var(--go-color); }
  @media (prefers-reduced-motion: reduce) { .display-progress-fill { transition: none !important; } }
```

with:

```css
  .display-progress { width: min(62%, 900px); height: clamp(16px, 2.6vh, 30px); margin-top: clamp(1rem, 3.5vh, 2.75rem); background: rgba(255,255,255,.10); border-radius: 999px; overflow: hidden; pointer-events: none; }
  .display-progress-fill { height: 100%; width: 100%; transform-origin: left; transform: scaleX(1); background: var(--mat-red); border-radius: 999px; will-change: transform; }
  .display-inner.phase-rest .display-progress-fill { background: var(--go-color); }
  @media (prefers-reduced-motion: reduce) { .display-progress-fill { transition: none !important; } }
```

(Removes `position:absolute/left/right/bottom/z-index`; adds centered width, taller responsive height, top margin, rounded ends. `#displayPanelTimer` is a centered flex column, so the bar centers automatically.)

- [ ] **Step 4: Bump asset versions to v42**

In `public/index.html`: `main.css?v=41` → `v=42`, `progress.js?v=41` → `v=42`, `app.js?v=41` → `v=42`.
In `public/sw.js`: `CACHE_NAME` `bjj-timer-v41` → `bjj-timer-v42`.

- [ ] **Step 5: Verify lint and the existing suite pass**

Run: `npm run lint`
Expected: no errors.
Run: `npm test`
Expected: all tests pass (50; no logic changed).

- [ ] **Step 6: Manual browser verification**

On a TV display (`?room=demo`, connect a TV, start a timer from a controller):
- A thick rounded bar sits centered just below the countdown number.
- It depletes left-origin during a fight round (red), resets full and turns green in rest.
- Pause freezes it; reset refills it.
- Switching to the stopwatch tab hides it (panel hidden); switching back shows it.
Capture a before/after screenshot for the PR.

If a live browser check is impractical, confirm via DOM probe that `#displayProgress` is a child of `#displayPanelTimer` and that its computed height is > 12px, and rely on the deploy preview for the across-the-room look.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/css/main.css public/sw.js
git commit -m "$(cat <<'EOF'
Move TV progress bar under the time, make it thick + rounded

Replace the 12px bottom-edge bar (unreadable across a gym) with a thick rounded
bar centered directly under the countdown, inside #displayPanelTimer. Depletion
engine and IDs unchanged. Asset version bumped to v42.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

Expected: pre-commit hook passes (CACHE_NAME/css/js all at v42).

---

## Self-review notes

- **Spec coverage:** Revision note → Task 1; §1 markup (under `#displayTime`) → Steps 1–2; §2 CSS (thick rounded centered) → Step 3; §3 "no JS change" → honored (Global Constraints); cache lockstep → Step 4. All covered.
- **No placeholders:** every step has exact code/commands.
- **No JS/test changes:** `roundProgress` unchanged, so the existing `test/progress.test.js` remains valid; no new tests needed (pure logic untouched).
