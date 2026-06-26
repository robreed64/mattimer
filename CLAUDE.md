# CLAUDE.md

BJJ Mat Timer — multi-tenant SaaS mat timer for BJJ gyms.
**`README.md` is the source of truth** for architecture, env vars, deploy commands,
and the full Supabase data model. Read it first. This file covers only the
standing rules and gotchas that aren't obvious from the code.

## The system is two separately-deployed apps

| Part | Lives in | Ships via | Host |
|---|---|---|---|
| Frontend + serverless API | `public/`, `api/` | `vercel --prod` (git push to `main`) | Vercel |
| Realtime room server | `party/main.js` | `npm run deploy` (`partykit deploy`) | PartyKit (Cloudflare DOs) |

**A change to `party/` is NOT live until you `partykit deploy` — pushing to git
only deploys the frontend.** Anything touching the room protocol usually needs
*both* deployed, frontend and party, ideally together.

## Editing anything in `public/` → bump three versions in lockstep

`public/sw.js` caches the app shell aggressively; stale PWA clients (esp. iOS
home-screen) silently mask deployed fixes. When you change any file under
`public/`, bump **all three** together:

1. `CACHE_NAME` in `public/sw.js`
2. `?v=NN` on the CSS link in `public/index.html`
3. `?v=NN` on the `app.js` script tag in `public/index.html`

Bumping only `CACHE_NAME` is not enough — the HTTP cache keeps serving the old
`?v=` URL. To verify the latest code is live, use an **incognito window** (a normal
refresh on a PWA is often too sticky).

A pre-commit hook (`.githooks/pre-commit`) enforces this: it blocks any commit
that touches `public/` unless all three versions are equal *and* bumped vs the
last commit. Activate it once per clone (it's tracked but the config isn't):

```bash
git config core.hooksPath .githooks
```

Bypass a specific commit with `git commit --no-verify` if you really mean to.

## Realtime timer: the alarm handler must be `onAlarm()`

In `party/main.js` the per-second countdown ticks via a Durable Object alarm.
PartyKit dispatches to **`onAlarm()`** — a method named `alarm()` (the raw DO
convention) is *never called* and fails silently. Symptom: "Start does nothing,
Pause jumps to the right time." Don't gate `setAlarm` on an in-memory flag;
`storage.setAlarm` is idempotent, so reschedule unconditionally.

## Features that need manual out-of-band setup before they work

These have no migration runner / no automated provisioning:

- **New Supabase tables/columns** — created by hand in the SQL editor. The exact
  DDL for `signup_attempts`, `pairing_*`, `gym_devices`, and the kiosk-login
  columns is in README.md's "Data model" section.
- **Spotify integration** — needs a one-time app at developer.spotify.com, a
  Client ID pasted into `public/spotify-config.js`, registered redirect URIs
  (incl. the literal `http://127.0.0.1:3000/` for dev), and a **Premium** account.

## Auth model (quick orientation)

- `api/` functions use the Supabase **service-role** key and verify the caller's
  Supabase JWT (except `signup` and `stripe-webhook`).
- Coaches/kiosks don't need Supabase accounts: they get self-verifying HMAC room
  tokens signed with `PARTY_AUTH_SECRET` (`lib/room-token.js`), obtained via
  device pairing or shared per-gym kiosk login.

## Commands

```bash
npm install
npx partykit dev     # realtime server  → localhost:1999
vercel dev           # frontend + api/  → localhost:3000
npm test             # node --test (test/)
npm run lint         # eslint
```
