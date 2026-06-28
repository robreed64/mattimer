# Landing Page Design Spec
**Date:** 2026-06-28
**File:** `public/landing.html`
**Goal:** Convert BJJ gym owners who are evaluating the product into trial signups.

---

## Context

The existing `#marketingView` in `public/index.html` is a minimal one-card sign-in gateway — not a sales tool. This landing page replaces nothing; it lives at `/landing` as a separate file, designed to be pointed at by a custom domain (e.g. bjjtimer.com) when one is acquired. It links into the existing trial signup flow via `/?signup=1`.

No social proof exists yet. Sections are designed so testimonials and a "gyms using it" count can be dropped in later without restructuring the page.

---

## Visual Style

Matches the app exactly — landing.html links to the existing `/css/main.css` plus a `<style>` block for landing-specific layout. No new CSS file needed.

| Token | Value |
|---|---|
| Background | `#0D0D0D` |
| Surface | `#141414` |
| Border | `#2A2A2A` |
| Gold accent | `#D4A017` |
| Red accent | `#C0392B` |
| Text | `#F0EDE8` |
| Muted text | `#888` |
| Display font | Bebas Neue (loaded via Google Fonts, same as app) |
| UI font | Barlow Condensed |
| Body font | Barlow |

Background texture on hero and final CTA: radial warm-gold glow at top-center over `#0D0D0D`, matching the app's landing screen. Flat dark panel (`#141414`) on alternating sections.

---

## Navigation Bar (sticky, top)

Slim bar (48px), `background: #141414`, `border-bottom: 1px solid #2A2A2A`, `position: sticky; top: 0; z-index: 100`.

- **Left:** SVG logo mark (24px) + "BJJ MAT TIMER" in Bebas Neue, gold
- **Right:** "Sign In" (outline button, small) · "Start Free Trial" (gold button, small)

Both buttons link to the app: Sign In → `/?login=1`, Start Free Trial → `/?signup=1`.

---

## Section 1 — Hero

**Layout:** Full viewport height. Centered column, max-width 700px.

**Content:**
- Pre-headline (small caps, gold, Barlow Condensed): `FOR BJJ GYMS`
- Headline (Bebas Neue, clamp 3.5–6rem): `EVERY SCREEN. ONE TAP.`
- Subheadline (Barlow, 1.1rem, muted): `Real-time countdown timers synced to every TV in your gym. Coach from your phone — no app installs, no hardware, no IT.`
- CTA row:
  - Primary: "Start Free Trial — 30 Days Free" (gold button, large)
  - Secondary: "Try the Demo →" (text link, muted gold)
- Screenshot: A single large image of the TV display screen showing a round in progress (e.g. "Round 2 of 3" / "4:23" / FIGHT phase label / progress ring). Rounded corners, subtle gold drop shadow. **[SCREENSHOT PLACEHOLDER: TV display — active round countdown]**

Both CTAs: Start Free Trial → `/?signup=1`, Try Demo → `/?room=demo`.

---

## Section 2 — The Problem

**Layout:** Dark panel (`#141414`), centered, max-width 800px. Three pain points side-by-side on desktop, stacked on mobile.

**Headline (Bebas Neue, 2rem):** `SOUND FAMILIAR?`

**Three pain points** (each: red ✕ icon + bold first phrase + short elaboration):

1. **"You're watching the clock instead of watching your students."**
   Split attention kills coaching quality — and your phone screen is useless from the far end of the mat.

2. **"Phone timers don't work for a room full of people."**
   Students can't see it. You have to yell the time. Every. Round.

3. **"Resetting a stopwatch mid-drill breaks your flow."**
   You lose track. The drill runs long. The class runs late.

**Transition line** (centered, muted, below the three cards):
`There's a better way.`

---

## Section 3 — How It Works

**Layout:** Light surface (`#141414` with subtle border-top), centered, max-width 900px.

**Headline:** `UP AND RUNNING IN 60 SECONDS`

**Three numbered steps** (horizontal on desktop, vertical on mobile). Each step has a number (large, gold, Bebas Neue), a headline, one sentence of copy, and a screenshot slot.

1. **Open on your phone**
   Go to the app on your phone. Pick your mat and coach profile.
   **[SCREENSHOT PLACEHOLDER: Phone showing controller view — mat picker]**

2. **Scan on any TV**
   Point your wall TV's browser at the display URL — or scan the QR code shown on screen. Any smart TV, Fire Stick, or tablet works.
   **[SCREENSHOT PLACEHOLDER: Phone camera scanning QR code on TV screen]**

3. **Hit start**
   Every screen updates in real time. Your students see the countdown. You coach.
   **[SCREENSHOT PLACEHOLDER: TV showing countdown synced with phone controller]**

---

## Section 4 — Features

**Layout:** Alternating left/right rows (image left + text right, then text left + image right), full-width, dark background. On mobile: stacked, image above text.

Each feature block: headline (Bebas Neue, 1.8rem), 2–3 sentence description, screenshot slot. Max-width 1100px.

### Feature 1: Wall TV Sync
**Headline:** `ANY TV. ANY BROWSER.`
Smart TV, Fire Stick, Chromecast, tablet on a stand — if it has a browser, it's a display. No app to install, no account to create. Share the URL or scan the QR code and it just works.
**[SCREENSHOT PLACEHOLDER: TV wall display full-screen — idle clock or active timer]**

### Feature 2: Multi-Mat
**Headline:** `UP TO 4 MATS RUNNING SIMULTANEOUSLY`
Running a gi class on mat 1 and a no-gi class on mat 2? Each mat gets its own independent timer, its own coach, and its own display. No interference, no confusion.
**[SCREENSHOT PLACEHOLDER: Controller showing mat picker with multiple mats selected]**

### Feature 3: Coach Profiles
**Headline:** `YOUR WHOLE TEAM, ONE SUBSCRIPTION`
Every coach gets their own profile — no email accounts or passwords needed. Coaches pair their phone by scanning the display QR code. Optional PIN protection for each profile.
**[SCREENSHOT PLACEHOLDER: Profile picker modal showing coach cards]**

### Feature 4: White Label
**Headline:** `YOUR GYM ON EVERY SCREEN`
Replace the default logo and name with your gym's branding. Every display screen shows your gym name, your logo, your colors. Looks like your gym built it.
**[SCREENSHOT PLACEHOLDER: TV display showing custom gym logo and name]**

### Feature 5: Class Templates
**Headline:** `LOAD YOUR ROUND PRESETS IN ONE TAP`
Save your class formats — "Sparring: 5 × 5 min / 60s rest", "Drilling: 8 × 3 min / 30s rest" — and load them instantly. No re-entering settings before every class.
**[SCREENSHOT PLACEHOLDER: Templates modal showing saved presets]**

---

## Section 5 — Pricing

**Layout:** Centered, dark background, max-width 500px. Single pricing card.

**Headline:** `SIMPLE PRICING. ONE PLAN.`

**Card** (`background: #141414`, gold border, rounded corners):
- **$29 / month** (large, Bebas Neue, gold)
- Toggle: Monthly / Yearly — two `<label>` radio buttons styled as a pill toggle, no JS. Switching shows **$249 / year** with "Save 2 months" badge (CSS `input:checked ~` selector)
- Included list (checkmarks, gold):
  - Up to 4 mat rooms
  - Unlimited coach profiles
  - Wall TV sync on any browser
  - White-label gym branding
  - Class templates
  - Custom audio (upload your own bell)
  - Spotify auto-pause integration
- **CTA:** "Start Free Trial — 30 Days Free" (gold button, full width)
- Fine print (muted, small): "No credit card required. Cancel anytime from account settings."

**Below card:** "Questions? [robreed64@gmail.com](mailto:robreed64@gmail.com)" in gold.

---

## Section 6 — FAQ

**Layout:** Dark panel, centered, max-width 700px. Vertically stacked accordion items (click to expand). No JS required — use `<details>`/`<summary>`.

**Headline:** `COMMON QUESTIONS`

**Questions:**

1. **Do my TVs need special hardware?**
   No. Any TV with a browser works — smart TVs, Amazon Fire Sticks, Chromecasts with a browser, tablets mounted on a stand. If it can open a URL, it's a display.

2. **Do all my coaches need email accounts?**
   No. Coaches pair their phone by scanning the QR code shown on the display — no account, no password. You can also set up a shared kiosk login for devices that stay at the gym.

3. **Does it work on iPhone and Android?**
   Yes. The coach controller runs in any mobile browser and installs to your home screen like a native app. The display works on any browser too.

4. **What happens when my trial ends?**
   You'll see a prompt to subscribe. All your settings, profiles, and templates are preserved — nothing is deleted.

5. **Can I cancel anytime?**
   Yes. Cancel from your account settings in one click. No questions, no retention flow.

6. **What if I have more than 4 mat rooms?**
   Get in touch at [robreed64@gmail.com](mailto:robreed64@gmail.com) and we'll figure it out.

---

## Section 7 — Final CTA

**Layout:** Full-width banner, same warm radial glow as hero. Centered, max-width 600px.

**Headline (Bebas Neue, clamp 2.5–5rem):** `READY TO RUN A BETTER CLASS?`

**Subhead:** `30 days free. No credit card. Up and running in under a minute.`

**CTA:** "Start Free Trial" (gold button, large)
**Secondary:** "Try the Demo first →" (text link)

---

## Footer

Minimal. `background: #0D0D0D`, `border-top: 1px solid #2A2A2A`.

- Left: © 2026 BJJ Mat Timer
- Right: [robreed64@gmail.com](mailto:robreed64@gmail.com)

---

## Technical Notes

### Signup flow integration
Landing page is static HTML — no app.js. CTAs link to:
- Start Free Trial → `/?signup=1`
- Sign In → `/?login=1`
- Try Demo → `/?room=demo`

`app.js` needs a small addition: on page load, check URL params before showing the default marketing view:
- `?signup=1` → call `showSignup()` directly
- `?login=1` → call `showLogin()` directly

This is a ~5-line addition to the existing init block.

### Stylesheet
`<link rel="stylesheet" href="/css/main.css?v=51">` — reuses all design tokens. Landing-specific layout (hero, section grid, pricing card, FAQ accordion) goes in a `<style>` block within `landing.html`.

### Google Fonts
Same `<link>` as `index.html`: Bebas Neue + Barlow Condensed + Barlow.

### Responsive breakpoints
- ≥ 900px: feature rows alternate left/right; 3-up grids are horizontal
- 600–899px: feature rows stack, image above text; 3-up grids 2 columns
- < 600px: everything stacked single column; hero font clamps down

### Screenshot placeholders
During development, placeholder divs with `background: #1C1C1C; border: 2px dashed #2A2A2A; border-radius: 8px` and a centered label. Replace with `<img>` tags once screenshots are ready.

### Version bump
Changes touch `public/` via the new file and the `?signup=1` addition to `app.js` → bump sw.js CACHE_NAME and `?v=` params to v52.

---

## Screenshot Shoot List

When you take screenshots, here are the 8 shots the page needs:

| # | What to capture | Used in |
|---|---|---|
| 1 | TV display — active round countdown (e.g. Round 2 of 3, 4:23, FIGHT phase, progress ring) | Hero |
| 2 | Phone controller — mat picker modal | How it works step 1 |
| 3 | QR code scan (phone camera on TV screen) | How it works step 2 |
| 4 | TV display synced to phone (both visible) | How it works step 3 |
| 5 | TV display — idle clock or full-screen branding | Feature: TV Sync |
| 6 | Controller — mat picker showing multiple mats | Feature: Multi-Mat |
| 7 | Profile picker modal | Feature: Coach Profiles |
| 8 | TV display showing custom gym logo and name | Feature: White Label |
| 9 | Templates modal | Feature: Templates |
