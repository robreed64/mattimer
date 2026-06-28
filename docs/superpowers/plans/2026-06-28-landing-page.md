# Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `public/landing.html` — a standalone sales page for BJJ gym owners, linking into the existing trial signup flow.

**Architecture:** Static HTML file at `public/landing.html`. Reuses `/css/main.css` for design tokens and base styles; all landing-specific layout lives in a `<style>` block within the file. One small addition to `public/js/app.js` handles `?signup=1` and `?login=1` deep links from the landing page into the app's auth views.

**Tech Stack:** Vanilla HTML/CSS. No JS in the landing page itself. `<details>`/`<summary>` for FAQ accordion. CSS-only pricing toggle via `input[type=radio]:checked ~` selectors. Same Google Fonts as app (Bebas Neue, Barlow Condensed, Barlow).

## Global Constraints

- Visual design tokens must match the app exactly: `#0D0D0D` bg, `#D4A017` gold, `#C0392B` red, `#141414` surface, `#2A2A2A` border, `#F0EDE8` text, `#888` muted
- Display font: Bebas Neue. UI font: Barlow Condensed. Body font: Barlow.
- Pricing: $29/month or $249/year (2 months free)
- Trial CTA always links to `/?signup=1`; Sign In links to `/?login=1`; Demo links to `/?room=demo`
- Screenshot placeholder style: `background:#1C1C1C; border:2px dashed #2A2A2A; border-radius:8px` with centred label text
- All changes to `public/` require bumping CACHE_NAME in `sw.js` AND both `?v=` params in `index.html` to the same number (currently v51 → bump to v52)

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `public/js/app.js` lines 800–812 | Add `?signup=1` / `?login=1` URL param routing in `initAuth` |
| Create | `public/landing.html` | Full standalone sales page |
| Modify | `public/sw.js` line 3 | Bump `CACHE_NAME` to `bjj-timer-v52` |
| Modify | `public/index.html` lines 22, 885–886 | Bump `?v=51` → `?v=52` on CSS + JS script tags |

---

## Task 1: URL param routing in app.js

**Files:**
- Modify: `public/js/app.js` — the `initAuth` IIFE starting at line 770

**Context:** `initAuth` already handles `?room=demo`, `?pair=CODE`, and hash tokens for invite/recovery. When there's no session and no `roomId`, line 810 shows `#marketingView`. We add `?signup=1` and `?login=1` checks in that branch.

- [ ] **Step 1: Locate the no-session branch**

  In `public/js/app.js`, find this exact block (around line 800):

  ```js
  const { data: { session } } = await _supabase.auth.getSession();
  if (!session) {
    // A previously-paired phone has no Supabase session but may still
    // hold a long-lived device token for this room — try that next.
    if (roomId && await _resumeDeviceSession()) return;
    // …or a coach/kiosk login on a shared gym device.
    if (roomId && await _resumeKioskSession()) return;
    if (roomId) {
      document.getElementById('loginView').style.display = 'flex';
    } else {
      document.getElementById('marketingView').style.display = 'flex';
    }
    return;
  }
  ```

- [ ] **Step 2: Replace the final else branch**

  Change the `else` clause so the full block reads:

  ```js
  const { data: { session } } = await _supabase.auth.getSession();
  if (!session) {
    if (roomId && await _resumeDeviceSession()) return;
    if (roomId && await _resumeKioskSession()) return;
    if (roomId) {
      document.getElementById('loginView').style.display = 'flex';
    } else if (_urlParams.get('signup') === '1') {
      showSignup();
    } else if (_urlParams.get('login') === '1') {
      showLogin();
    } else {
      document.getElementById('marketingView').style.display = 'flex';
    }
    return;
  }
  ```

  `_urlParams` is already defined earlier in app.js as `new URLSearchParams(location.search)`. `showSignup()` is at line 355, `showLogin()` is at line 337.

- [ ] **Step 3: Verify in browser**

  Run `vercel dev` (frontend on port 3000). Open:
  - `http://localhost:3000/?signup=1` — should land directly on the signup form (not the marketing card)
  - `http://localhost:3000/?login=1` — should land directly on the email/password login form
  - `http://localhost:3000/` — should still show the marketing card (unchanged)

- [ ] **Step 4: Commit**

  ```bash
  git add public/js/app.js
  git commit -m "feat: support ?signup=1 and ?login=1 deep-link params from landing page"
  ```

---

## Task 2: Landing page scaffold — head, global CSS, sticky nav

**Files:**
- Create: `public/landing.html`

This task creates the file with the complete `<head>`, the full `<style>` block for all landing layout (added to incrementally in later tasks — write it all here as a skeleton and fill in during each task), and the sticky nav.

- [ ] **Step 1: Create `public/landing.html` with head + empty style block + nav**

  ```html
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>BJJ Mat Timer — Wall TV Timers for Your Gym</title>
    <meta name="description" content="Real-time countdown timers synced to every TV in your gym. Coach from your phone. No app installs, no hardware. 30-day free trial.">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow+Condensed:wght@400;600;700&family=Barlow:wght@400;500&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/css/main.css?v=52">
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: #0D0D0D; color: var(--mat-text); font-family: 'Barlow', sans-serif; }
      a { color: inherit; text-decoration: none; }
      img { display: block; max-width: 100%; border-radius: 8px; }

      /* ── NAV ──────────────────────────────────────────────────── */
      .lp-nav {
        position: sticky; top: 0; z-index: 100;
        background: #141414; border-bottom: 1px solid #2A2A2A;
        display: flex; align-items: center; justify-content: space-between;
        padding: 0 1.5rem; height: 52px;
      }
      .lp-nav-brand {
        display: flex; align-items: center; gap: .6rem;
        font-family: 'Bebas Neue', sans-serif; font-size: 1.2rem;
        letter-spacing: .12em; color: var(--mat-gold);
      }
      .lp-nav-brand svg { width: 26px; height: 26px; flex-shrink: 0; }
      .lp-nav-actions { display: flex; align-items: center; gap: .75rem; }

      /* ── SECTION WRAPPERS ─────────────────────────────────────── */
      .lp-section {
        padding: 5rem 1.5rem;
      }
      .lp-section-dark {
        padding: 5rem 1.5rem;
        background: #141414;
        border-top: 1px solid #2A2A2A;
        border-bottom: 1px solid #2A2A2A;
      }
      .lp-inner {
        max-width: 1100px; margin: 0 auto;
      }
      .lp-inner-narrow {
        max-width: 700px; margin: 0 auto;
      }
      .lp-inner-mid {
        max-width: 900px; margin: 0 auto;
      }
      .lp-eyebrow {
        font-family: 'Barlow Condensed', sans-serif;
        font-size: .75rem; font-weight: 700;
        letter-spacing: .25em; text-transform: uppercase;
        color: var(--mat-gold); margin-bottom: .75rem;
      }
      .lp-h2 {
        font-family: 'Bebas Neue', sans-serif;
        font-size: clamp(2rem, 5vw, 3rem);
        letter-spacing: .08em; line-height: 1;
        margin-bottom: 1.5rem;
      }

      /* ── SCREENSHOT PLACEHOLDER ───────────────────────────────── */
      .lp-shot {
        background: #1C1C1C; border: 2px dashed #2A2A2A;
        border-radius: 8px; display: flex; align-items: center;
        justify-content: center; text-align: center;
        font-family: 'Barlow Condensed', sans-serif;
        font-size: .75rem; letter-spacing: .15em; text-transform: uppercase;
        color: #555; padding: 1rem;
      }

      /* ── HERO ─────────────────────────────────────────────────── */
      .lp-hero {
        min-height: 100svh;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        text-align: center; padding: 5rem 1.5rem 4rem;
        background:
          radial-gradient(ellipse 80% 50% at 50% -10%, rgba(212,160,23,.18) 0%, transparent 70%),
          #0D0D0D;
      }
      .lp-hero-pre {
        font-family: 'Barlow Condensed', sans-serif;
        font-size: .8rem; font-weight: 700;
        letter-spacing: .3em; text-transform: uppercase;
        color: var(--mat-gold); margin-bottom: 1rem;
      }
      .lp-hero-h1 {
        font-family: 'Bebas Neue', sans-serif;
        font-size: clamp(3.5rem, 10vw, 7rem);
        letter-spacing: .06em; line-height: .95;
        color: var(--mat-text); margin-bottom: 1.25rem;
      }
      .lp-hero-sub {
        font-size: clamp(1rem, 2.5vw, 1.2rem);
        color: var(--mat-muted); max-width: 560px;
        line-height: 1.55; margin-bottom: 2.25rem;
      }
      .lp-hero-ctas {
        display: flex; flex-wrap: wrap;
        gap: .75rem; justify-content: center;
        margin-bottom: 3rem;
      }
      .lp-demo-link {
        font-family: 'Barlow Condensed', sans-serif;
        font-size: .95rem; letter-spacing: .1em;
        color: rgba(212,160,23,.7);
        border-bottom: 1px solid rgba(212,160,23,.3);
        transition: color .15s;
        display: flex; align-items: center; gap: .3rem;
      }
      .lp-demo-link:hover { color: var(--mat-gold); }
      .lp-hero-shot {
        width: 100%; max-width: 720px;
        aspect-ratio: 16/9;
      }
    </style>
  </head>
  <body>

  <!-- ── NAV ─────────────────────────────────────────────────────── -->
  <nav class="lp-nav">
    <a class="lp-nav-brand" href="/">
      <svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
        <circle cx="40" cy="40" r="36" fill="none" stroke="#D4A017" stroke-width="2"/>
        <path d="M20 55 Q30 25 40 40 Q50 55 60 25" fill="none" stroke="#C0392B" stroke-width="3" stroke-linecap="round"/>
        <circle cx="40" cy="40" r="4" fill="#D4A017"/>
      </svg>
      BJJ MAT TIMER
    </a>
    <div class="lp-nav-actions">
      <a href="/?login=1" class="btn btn-outline" style="font-size:.82rem;padding:.4rem .9rem">Sign In</a>
      <a href="/?signup=1" class="btn btn-gold" style="font-size:.82rem;padding:.4rem .9rem">Start Free Trial</a>
    </div>
  </nav>

  <!-- sections go here in subsequent tasks -->

  </body>
  </html>
  ```

- [ ] **Step 2: Verify in browser**

  Open `http://localhost:3000/landing.html`. You should see: a dark page with a sticky gold nav bar. "BJJ MAT TIMER" brand on the left, Sign In + Start Free Trial buttons on the right.

- [ ] **Step 3: Commit**

  ```bash
  git add public/landing.html
  git commit -m "feat: landing page scaffold — head, CSS foundation, sticky nav"
  ```

---

## Task 3: Hero section

**Files:**
- Modify: `public/landing.html` — add hero HTML after the `<nav>` and before `<!-- sections go here -->`

- [ ] **Step 1: Add hero HTML**

  Replace `<!-- sections go here in subsequent tasks -->` with:

  ```html
  <!-- ── HERO ────────────────────────────────────────────────────── -->
  <section class="lp-hero">
    <p class="lp-hero-pre">For BJJ Gyms</p>
    <h1 class="lp-hero-h1">Every Screen.<br>One Tap.</h1>
    <p class="lp-hero-sub">Real-time countdown timers synced to every TV in your gym. Coach from your phone — no app installs, no hardware, no IT.</p>
    <div class="lp-hero-ctas">
      <a href="/?signup=1" class="btn btn-gold" style="font-size:1.05rem;padding:.8rem 1.75rem">Start Free Trial — 30 Days Free</a>
      <a href="/?room=demo" class="lp-demo-link">Try the Demo →</a>
    </div>
    <!-- Replace src with your screenshot once taken -->
    <div class="lp-shot lp-hero-shot">
      [SCREENSHOT 1: TV display — active round countdown, e.g. "Round 2 of 3 · 4:23 · FIGHT"]
    </div>
  </section>

  <!-- sections go here in subsequent tasks -->
  ```

- [ ] **Step 2: Verify in browser**

  Reload `http://localhost:3000/landing.html`. Above the fold you should see: gold pre-label, large headline "EVERY SCREEN. ONE TAP.", subhead, two CTAs, and a dashed screenshot placeholder below.

- [ ] **Step 3: Commit**

  ```bash
  git add public/landing.html
  git commit -m "feat: landing page hero section"
  ```

---

## Task 4: Problem + How It Works sections

**Files:**
- Modify: `public/landing.html` — add two sections + their CSS into the `<style>` block

- [ ] **Step 1: Add CSS for these sections into the `<style>` block** (paste before the closing `</style>`)

  ```css
  /* ── PROBLEM ──────────────────────────────────────────────── */
  .lp-pain-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1.5rem; margin-bottom: 2rem;
  }
  .lp-pain-card {
    background: #0D0D0D; border: 1px solid #2A2A2A;
    border-radius: 6px; padding: 1.5rem;
  }
  .lp-pain-x {
    font-size: 1.1rem; color: var(--mat-red);
    margin-bottom: .6rem; display: block;
  }
  .lp-pain-card p { font-size: .95rem; line-height: 1.55; color: var(--mat-muted); }
  .lp-pain-card strong { color: var(--mat-text); }
  .lp-transition {
    text-align: center;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 1.1rem; letter-spacing: .15em; text-transform: uppercase;
    color: var(--mat-muted);
  }

  /* ── HOW IT WORKS ─────────────────────────────────────────── */
  .lp-steps {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 2rem;
  }
  .lp-step { text-align: center; }
  .lp-step-num {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 3.5rem; line-height: 1;
    color: var(--mat-gold); opacity: .35;
    margin-bottom: .5rem;
  }
  .lp-step h3 {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 1.3rem; letter-spacing: .08em;
    margin-bottom: .5rem;
  }
  .lp-step p { font-size: .9rem; color: var(--mat-muted); line-height: 1.5; margin-bottom: 1rem; }
  .lp-step-shot { width: 100%; aspect-ratio: 9/16; max-height: 260px; margin: 0 auto; }
  ```

- [ ] **Step 2: Add HTML for both sections** (replace `<!-- sections go here in subsequent tasks -->` with the following, keeping the comment at the bottom)

  ```html
  <!-- ── PROBLEM ─────────────────────────────────────────────────── -->
  <section class="lp-section-dark">
    <div class="lp-inner-mid">
      <p class="lp-eyebrow" style="text-align:center">Sound Familiar?</p>
      <div class="lp-pain-grid">
        <div class="lp-pain-card">
          <span class="lp-pain-x">✕</span>
          <p><strong>You're watching the clock instead of watching your students.</strong> Split attention kills coaching quality — and your phone screen is useless from the far end of the mat.</p>
        </div>
        <div class="lp-pain-card">
          <span class="lp-pain-x">✕</span>
          <p><strong>Phone timers don't work for a room full of people.</strong> Students can't see it. You have to yell the time. Every. Round.</p>
        </div>
        <div class="lp-pain-card">
          <span class="lp-pain-x">✕</span>
          <p><strong>Resetting a stopwatch mid-drill breaks your flow.</strong> You lose track. The drill runs long. The class runs late.</p>
        </div>
      </div>
      <p class="lp-transition">There's a better way.</p>
    </div>
  </section>

  <!-- ── HOW IT WORKS ─────────────────────────────────────────────── -->
  <section class="lp-section">
    <div class="lp-inner-mid">
      <p class="lp-eyebrow" style="text-align:center">How It Works</p>
      <h2 class="lp-h2" style="text-align:center">Up and Running in 60 Seconds</h2>
      <div class="lp-steps">
        <div class="lp-step">
          <div class="lp-step-num">1</div>
          <h3>Open on Your Phone</h3>
          <p>Go to the app on your phone. Pick your mat and coach profile.</p>
          <div class="lp-shot lp-step-shot">[SCREENSHOT 2: phone controller — mat picker]</div>
        </div>
        <div class="lp-step">
          <div class="lp-step-num">2</div>
          <h3>Scan on Any TV</h3>
          <p>Point your wall TV's browser at the display URL — or scan the QR code shown on screen. Any smart TV, Fire Stick, or tablet works.</p>
          <div class="lp-shot lp-step-shot">[SCREENSHOT 3: phone camera scanning QR on TV]</div>
        </div>
        <div class="lp-step">
          <div class="lp-step-num">3</div>
          <h3>Hit Start</h3>
          <p>Every screen updates in real time. Your students see the countdown. You coach.</p>
          <div class="lp-shot lp-step-shot">[SCREENSHOT 4: TV countdown synced with phone]</div>
        </div>
      </div>
    </div>
  </section>

  <!-- sections go here in subsequent tasks -->
  ```

- [ ] **Step 3: Verify in browser**

  Scroll past the hero — you should see: a dark panel with three pain-point cards (✕ icons, bold problem statements), "There's a better way." transition, then a lighter section with three numbered steps and portrait screenshot placeholders.

- [ ] **Step 4: Commit**

  ```bash
  git add public/landing.html
  git commit -m "feat: landing page problem + how it works sections"
  ```

---

## Task 5: Feature blocks

**Files:**
- Modify: `public/landing.html` — add feature CSS + HTML

- [ ] **Step 1: Add CSS for feature rows** (paste before closing `</style>`)

  ```css
  /* ── FEATURES ─────────────────────────────────────────────── */
  .lp-feature-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3rem; align-items: center;
    padding: 3.5rem 0;
    border-bottom: 1px solid #2A2A2A;
  }
  .lp-feature-row:last-child { border-bottom: none; }
  .lp-feature-row.lp-flip { direction: rtl; }
  .lp-feature-row.lp-flip > * { direction: ltr; }
  .lp-feature-text h3 {
    font-family: 'Bebas Neue', sans-serif;
    font-size: clamp(1.5rem, 3vw, 2rem);
    letter-spacing: .08em; margin-bottom: .75rem;
  }
  .lp-feature-text p {
    font-size: .95rem; color: var(--mat-muted);
    line-height: 1.6;
  }
  .lp-feature-shot {
    width: 100%; aspect-ratio: 16/9;
  }
  ```

- [ ] **Step 2: Add feature HTML** (replace `<!-- sections go here in subsequent tasks -->`)

  ```html
  <!-- ── FEATURES ─────────────────────────────────────────────────── -->
  <section class="lp-section-dark">
    <div class="lp-inner">
      <p class="lp-eyebrow" style="text-align:center">Features</p>
      <h2 class="lp-h2" style="text-align:center">Built for the Mat</h2>

      <div class="lp-feature-row">
        <div class="lp-shot lp-feature-shot">[SCREENSHOT 5: TV display — full screen with custom logo]</div>
        <div class="lp-feature-text">
          <h3>Any TV. Any Browser.</h3>
          <p>Smart TV, Fire Stick, Chromecast, tablet on a stand — if it has a browser, it's a display. No app to install, no account to create. Share the URL or scan the QR code and it just works.</p>
        </div>
      </div>

      <div class="lp-feature-row lp-flip">
        <div class="lp-shot lp-feature-shot">[SCREENSHOT 6: controller — mat picker with multiple mats]</div>
        <div class="lp-feature-text">
          <h3>Up to 4 Mats Running Simultaneously</h3>
          <p>Running a gi class on mat 1 and a no-gi class on mat 2? Each mat gets its own independent timer, its own coach, and its own display. No interference, no confusion.</p>
        </div>
      </div>

      <div class="lp-feature-row">
        <div class="lp-shot lp-feature-shot">[SCREENSHOT 7: profile picker modal showing coach cards]</div>
        <div class="lp-feature-text">
          <h3>Your Whole Team, One Subscription</h3>
          <p>Every coach gets their own profile — no email accounts or passwords needed. Coaches pair their phone by scanning the display QR code. Optional PIN protection for each profile.</p>
        </div>
      </div>

      <div class="lp-feature-row lp-flip">
        <div class="lp-shot lp-feature-shot">[SCREENSHOT 8: TV display showing custom gym logo and name]</div>
        <div class="lp-feature-text">
          <h3>Your Gym on Every Screen</h3>
          <p>Replace the default logo and name with your gym's branding. Every display screen shows your gym name, your logo — looks like your gym built it.</p>
        </div>
      </div>

      <div class="lp-feature-row">
        <div class="lp-shot lp-feature-shot">[SCREENSHOT 9: templates modal showing saved presets]</div>
        <div class="lp-feature-text">
          <h3>Load Your Round Presets in One Tap</h3>
          <p>Save your class formats — "Sparring: 5 × 5 min / 60s rest", "Drilling: 8 × 3 min / 30s rest" — and load them instantly. No re-entering settings before every class.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- sections go here in subsequent tasks -->
  ```

- [ ] **Step 3: Verify in browser**

  Scroll past How It Works — you should see 5 alternating left/right feature rows on a dark panel, each with a placeholder on one side and text on the other.

- [ ] **Step 4: Commit**

  ```bash
  git add public/landing.html
  git commit -m "feat: landing page feature blocks"
  ```

---

## Task 6: Pricing card with CSS-only monthly/yearly toggle

**Files:**
- Modify: `public/landing.html` — add pricing CSS + HTML

The toggle works via `input[type=radio]:checked ~ sibling` CSS selectors. The radio inputs must appear **before** the elements they control in the DOM (same parent).

- [ ] **Step 1: Add pricing CSS** (paste before closing `</style>`)

  ```css
  /* ── PRICING ──────────────────────────────────────────────── */
  .lp-pricing-card {
    background: #141414; border: 1px solid var(--mat-gold);
    border-radius: 8px; padding: 2.5rem; max-width: 480px;
    margin: 0 auto; text-align: center;
  }
  .lp-billing-input { display: none; }
  .lp-billing-toggle {
    display: inline-flex; background: #0D0D0D;
    border: 1px solid #2A2A2A; border-radius: 4px;
    overflow: hidden; margin-bottom: 1.75rem;
  }
  .lp-billing-label {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: .85rem; font-weight: 700;
    letter-spacing: .1em; text-transform: uppercase;
    padding: .45rem 1.25rem; cursor: pointer;
    color: var(--mat-muted); transition: all .15s;
  }
  /* Active label styles — driven by checked radio */
  #bill-monthly:checked ~ .lp-billing-toggle label[for="bill-monthly"],
  #bill-yearly:checked  ~ .lp-billing-toggle label[for="bill-yearly"] {
    background: var(--mat-gold); color: #000;
  }
  /* Price display */
  .lp-price-monthly,
  .lp-price-yearly {
    display: flex; align-items: baseline; gap: .35rem;
    justify-content: center; margin-bottom: .35rem;
  }
  .lp-price-yearly { display: none; }
  #bill-yearly:checked ~ .lp-price-monthly { display: none; }
  #bill-yearly:checked ~ .lp-price-yearly  { display: flex; flex-wrap: wrap; }
  .lp-price-amount {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 4rem; letter-spacing: .05em;
    color: var(--mat-gold); line-height: 1;
  }
  .lp-price-per {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 1rem; color: var(--mat-muted);
  }
  .lp-save-badge {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: .75rem; font-weight: 700;
    letter-spacing: .1em; text-transform: uppercase;
    background: rgba(212,160,23,.15); color: var(--mat-gold);
    border: 1px solid rgba(212,160,23,.3);
    border-radius: 3px; padding: .2rem .5rem;
    align-self: center;
  }
  .lp-price-note {
    font-size: .8rem; color: var(--mat-muted); margin-bottom: 1.75rem;
  }
  .lp-includes {
    list-style: none; text-align: left;
    display: flex; flex-direction: column; gap: .6rem;
    margin-bottom: 2rem;
  }
  .lp-includes li {
    font-size: .9rem; color: var(--mat-muted);
    display: flex; align-items: flex-start; gap: .6rem;
  }
  .lp-includes li::before {
    content: '✓'; color: var(--mat-gold);
    font-weight: 700; flex-shrink: 0; margin-top: .05rem;
  }
  .lp-pricing-fine {
    font-size: .75rem; color: var(--mat-muted);
    margin-top: .75rem;
  }
  .lp-pricing-contact {
    text-align: center; margin-top: 1.25rem;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: .9rem; color: var(--mat-muted); letter-spacing: .05em;
  }
  .lp-pricing-contact a { color: var(--mat-gold); border-bottom: 1px solid rgba(212,160,23,.3); }
  ```

- [ ] **Step 2: Add pricing HTML** (replace `<!-- sections go here in subsequent tasks -->`)

  ```html
  <!-- ── PRICING ──────────────────────────────────────────────────── -->
  <section class="lp-section">
    <div class="lp-inner-narrow">
      <p class="lp-eyebrow" style="text-align:center">Pricing</p>
      <h2 class="lp-h2" style="text-align:center">Simple Pricing. One Plan.</h2>

      <div class="lp-pricing-card">
        <!--
          Radio inputs MUST be first children — CSS sibling selectors
          (input:checked ~ sibling) only target subsequent siblings.
        -->
        <input type="radio" name="billing" id="bill-monthly" class="lp-billing-input" checked>
        <input type="radio" name="billing" id="bill-yearly" class="lp-billing-input">

        <div class="lp-billing-toggle">
          <label for="bill-monthly" class="lp-billing-label">Monthly</label>
          <label for="bill-yearly" class="lp-billing-label">Yearly</label>
        </div>

        <div class="lp-price-monthly">
          <span class="lp-price-amount">$29</span>
          <span class="lp-price-per">/month</span>
        </div>
        <div class="lp-price-yearly">
          <span class="lp-price-amount">$249</span>
          <span class="lp-price-per">/year</span>
          <span class="lp-save-badge">2 months free</span>
        </div>

        <p class="lp-price-note">per gym · billed monthly or yearly</p>

        <ul class="lp-includes">
          <li>Up to 4 mat rooms</li>
          <li>Unlimited coach profiles</li>
          <li>Wall TV sync on any browser</li>
          <li>White-label gym branding</li>
          <li>Class templates</li>
          <li>Custom audio (upload your own bell)</li>
          <li>Spotify auto-pause integration</li>
        </ul>

        <a href="/?signup=1" class="btn btn-gold" style="width:100%;font-size:1.05rem;padding:.85rem;display:block;text-align:center">
          Start Free Trial — 30 Days Free
        </a>
        <p class="lp-pricing-fine">No credit card required. Cancel anytime from account settings.</p>
      </div>

      <p class="lp-pricing-contact">
        Questions? <a href="mailto:robreed64@gmail.com">robreed64@gmail.com</a>
      </p>
    </div>
  </section>

  <!-- sections go here in subsequent tasks -->
  ```

- [ ] **Step 3: Verify the toggle in browser**

  Scroll to the pricing section. You should see:
  - "$29/month" with "Monthly" tab active (gold background)
  - Clicking "Yearly" tab switches to "$249/year" + "2 months free" badge without a page reload
  - Clicking "Monthly" switches back

- [ ] **Step 4: Commit**

  ```bash
  git add public/landing.html
  git commit -m "feat: landing page pricing card with CSS-only billing toggle"
  ```

---

## Task 7: FAQ + Final CTA + Footer + responsive CSS

**Files:**
- Modify: `public/landing.html` — add remaining sections + responsive CSS

- [ ] **Step 1: Add CSS for FAQ, CTA, footer, and responsive breakpoints** (paste before closing `</style>`)

  ```css
  /* ── FAQ ──────────────────────────────────────────────────── */
  .lp-faq { display: flex; flex-direction: column; gap: 0; }
  details.lp-faq-item {
    border-bottom: 1px solid #2A2A2A;
  }
  details.lp-faq-item:first-child { border-top: 1px solid #2A2A2A; }
  summary.lp-faq-q {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 1rem; font-weight: 600; letter-spacing: .04em;
    padding: 1rem 0; cursor: pointer; list-style: none;
    display: flex; justify-content: space-between; align-items: center;
    color: var(--mat-text);
  }
  summary.lp-faq-q::-webkit-details-marker { display: none; }
  summary.lp-faq-q::after {
    content: '+'; font-family: 'Bebas Neue', sans-serif;
    font-size: 1.4rem; color: var(--mat-gold); flex-shrink: 0; margin-left: 1rem;
  }
  details[open] summary.lp-faq-q::after { content: '−'; }
  .lp-faq-a {
    font-size: .9rem; color: var(--mat-muted);
    line-height: 1.6; padding-bottom: 1rem;
  }
  .lp-faq-a a { color: var(--mat-gold); border-bottom: 1px solid rgba(212,160,23,.3); }

  /* ── FINAL CTA BANNER ─────────────────────────────────────── */
  .lp-cta-banner {
    padding: 6rem 1.5rem;
    text-align: center;
    background:
      radial-gradient(ellipse 60% 50% at 50% 0%, rgba(212,160,23,.15) 0%, transparent 70%),
      #0D0D0D;
  }
  .lp-cta-banner h2 {
    font-family: 'Bebas Neue', sans-serif;
    font-size: clamp(2.5rem, 7vw, 5rem);
    letter-spacing: .06em; line-height: 1;
    margin-bottom: 1rem;
  }
  .lp-cta-banner p {
    font-size: 1rem; color: var(--mat-muted); margin-bottom: 2rem;
  }
  .lp-cta-banner .lp-demo-link { justify-content: center; margin-top: 1rem; }

  /* ── FOOTER ───────────────────────────────────────────────── */
  .lp-footer {
    background: #0D0D0D; border-top: 1px solid #2A2A2A;
    padding: 1.5rem; display: flex;
    align-items: center; justify-content: space-between;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: .8rem; letter-spacing: .08em;
    color: var(--mat-muted);
  }
  .lp-footer a { color: var(--mat-gold); }

  /* ── RESPONSIVE ───────────────────────────────────────────── */
  @media (max-width: 900px) {
    .lp-pain-grid    { grid-template-columns: 1fr; }
    .lp-steps        { grid-template-columns: 1fr; }
    .lp-feature-row  { grid-template-columns: 1fr; direction: ltr; }
    .lp-feature-row.lp-flip { direction: ltr; }
    .lp-feature-shot { aspect-ratio: 16/9; }
    .lp-step-shot    { aspect-ratio: 16/9; max-height: none; }
  }
  @media (max-width: 600px) {
    .lp-nav-brand span { display: none; }
    .lp-section, .lp-section-dark { padding: 3.5rem 1rem; }
    .lp-pain-grid { gap: 1rem; }
    .lp-steps     { gap: 2.5rem; }
    .lp-footer    { flex-direction: column; gap: .5rem; text-align: center; }
  }
  ```

- [ ] **Step 2: Add FAQ + Final CTA + Footer HTML** (replace `<!-- sections go here in subsequent tasks -->`)

  ```html
  <!-- ── FAQ ──────────────────────────────────────────────────────── -->
  <section class="lp-section-dark">
    <div class="lp-inner-narrow">
      <p class="lp-eyebrow" style="text-align:center">FAQ</p>
      <h2 class="lp-h2" style="text-align:center">Common Questions</h2>
      <div class="lp-faq">

        <details class="lp-faq-item">
          <summary class="lp-faq-q">Do my TVs need special hardware?</summary>
          <p class="lp-faq-a">No. Any TV with a browser works — smart TVs, Amazon Fire Sticks, Chromecasts with a browser, tablets mounted on a stand. If it can open a URL, it's a display.</p>
        </details>

        <details class="lp-faq-item">
          <summary class="lp-faq-q">Do all my coaches need email accounts?</summary>
          <p class="lp-faq-a">No. Coaches pair their phone by scanning the QR code shown on the display — no account, no password. You can also set up a shared kiosk login for devices that stay at the gym.</p>
        </details>

        <details class="lp-faq-item">
          <summary class="lp-faq-q">Does it work on iPhone and Android?</summary>
          <p class="lp-faq-a">Yes. The coach controller runs in any mobile browser and installs to your home screen like a native app. The display works on any browser too.</p>
        </details>

        <details class="lp-faq-item">
          <summary class="lp-faq-q">What happens when my trial ends?</summary>
          <p class="lp-faq-a">You'll see a prompt to subscribe. All your settings, profiles, and templates are preserved — nothing is deleted.</p>
        </details>

        <details class="lp-faq-item">
          <summary class="lp-faq-q">Can I cancel anytime?</summary>
          <p class="lp-faq-a">Yes. Cancel from your account settings in one click. No questions, no retention flow.</p>
        </details>

        <details class="lp-faq-item">
          <summary class="lp-faq-q">What if I have more than 4 mat rooms?</summary>
          <p class="lp-faq-a">Get in touch at <a href="mailto:robreed64@gmail.com">robreed64@gmail.com</a> and we'll figure it out.</p>
        </details>

      </div>
    </div>
  </section>

  <!-- ── FINAL CTA ─────────────────────────────────────────────────── -->
  <section class="lp-cta-banner">
    <h2>Ready to Run a Better Class?</h2>
    <p>30 days free. No credit card. Up and running in under a minute.</p>
    <a href="/?signup=1" class="btn btn-gold" style="font-size:1.1rem;padding:.9rem 2rem">Start Free Trial</a>
    <div>
      <a href="/?room=demo" class="lp-demo-link">Try the Demo first →</a>
    </div>
  </section>

  <!-- ── FOOTER ────────────────────────────────────────────────────── -->
  <footer class="lp-footer">
    <span>© 2026 BJJ Mat Timer</span>
    <a href="mailto:robreed64@gmail.com">robreed64@gmail.com</a>
  </footer>
  ```

- [ ] **Step 3: Verify complete page in browser**

  - Scroll from top to bottom — all 7 sections should be visible with no layout breaks
  - Click FAQ items — they expand/collapse with `+` / `−` toggle, no JS
  - Resize window to 600px — nav hides the brand text, columns stack single
  - Resize to 900px — pain grid goes single column, feature rows stack

- [ ] **Step 4: Commit**

  ```bash
  git add public/landing.html
  git commit -m "feat: landing page FAQ, final CTA, footer, responsive CSS"
  ```

---

## Task 8: Version bump

**Files:**
- Modify: `public/sw.js` line 3
- Modify: `public/index.html` lines 22, 885–886

- [ ] **Step 1: Bump CACHE_NAME in `public/sw.js`**

  Change line 3:
  ```js
  // before
  const CACHE_NAME  = 'bjj-timer-v51';
  // after
  const CACHE_NAME  = 'bjj-timer-v52';
  ```

- [ ] **Step 2: Bump `?v=` params in `public/index.html`**

  Change three occurrences of `?v=51` → `?v=52`:
  ```html
  <!-- line 22 -->
  <link rel="stylesheet" href="/css/main.css?v=52">

  <!-- lines 885–886 -->
  <script src="/js/progress.js?v=52"></script>
  <script src="/js/app.js?v=52"></script>
  ```

- [ ] **Step 3: Verify sw.js CACHE_NAME and index.html all match v52**

  ```bash
  grep -n "v52\|v51" public/sw.js public/index.html
  ```

  Expected: `v52` appears 4 times (1 in sw.js, 3 in index.html). No `v51` results.

- [ ] **Step 4: Commit**

  ```bash
  git add public/sw.js public/index.html
  git commit -m "chore: bump cache version to v52 for landing page release"
  ```

---

## Self-Review Checklist

- [x] **Spec coverage:** sticky nav ✓, hero ✓, problem ✓, how it works ✓, 5 feature blocks ✓, pricing card + toggle ✓, FAQ (6 questions) ✓, final CTA ✓, footer ✓, `?signup=1` routing ✓, `?login=1` routing ✓, version bump ✓, 9 screenshot placeholders ✓
- [x] **No placeholders:** all HTML is complete; screenshot slots are clearly labelled placeholder divs, not "TBD" implementation notes
- [x] **Type consistency:** all CSS class names used in HTML match definitions in `<style>` block; `showSignup()` / `showLogin()` match function names in app.js (lines 355, 337); `_urlParams` confirmed defined earlier in app.js
- [x] **CSS-only toggle structure:** radio inputs are first children of `.lp-pricing-card`, making `.lp-billing-toggle`, `.lp-price-monthly`, `.lp-price-yearly` valid subsequent siblings for `~` combinator
- [x] **Version sequence:** current is v51 (after cleanup PR), landing page bumps to v52
