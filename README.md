# BJJ Mat Timer

Multi-tenant SaaS mat timer for BJJ gyms. A coach controls round timers from a phone or laptop; wall TVs and tablets show the synced countdown. Gyms sign up self-service, get a 30-day trial, and subscribe via Stripe.

Production: https://bjj-timer-gamma.vercel.app

## Architecture

```
Browser (public/)  ──static──  Vercel
   │                              │
   │ websocket + per-room REST    │ serverless functions (api/)
   ▼                              ▼
PartyKit room (party/main.js)   Supabase (auth, gyms, gym_users, gym_rooms)
one Durable Object per gym      Stripe (checkout, portal, webhook)
```

- **`public/`** — static frontend (vanilla JS, PWA). `index.html` is the whole app: marketing page, auth, controller UI, TV/display views. `admin.html` is the platform back office.
- **`party/main.js`** — realtime server on PartyKit (Cloudflare Durable Objects), one room per gym: controller slots, TV claim/release, profiles, branding, session history. Deployed to `bjj-timer.robreed64.partykit.dev`.
- **`api/`** — Vercel serverless functions: signup, invites, rooms, Stripe checkout/portal/webhook. All use the Supabase service-role key and verify the caller's Supabase JWT (except `signup` and `stripe-webhook`).

## Local development

```bash
npm install
npx partykit dev     # realtime server on localhost:1999
vercel dev           # static frontend + api/ on localhost:3000
```

## Deploy

```bash
npm run deploy       # partykit deploy (realtime server)
vercel --prod        # frontend + api
```

## Environment variables (Vercel)

| Var | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key for admin operations |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_PRICE_ID` | subscription price |
| `STRIPE_WEBHOOK_SECRET` | webhook signature verification |
| `PARTY_AUTH_SECRET` | HMAC secret for room tokens (set the same value in PartyKit via `npx partykit env add PARTY_AUTH_SECRET`) |

PartyKit-side vars (`npx partykit env add …`):

| Var | Purpose |
|---|---|
| `PARTY_AUTH_SECRET` | same value as on Vercel; verifies room tokens |
| `REQUIRE_AUTH` | set to `1` to enforce room auth (unset = warn-only logging while rolling out) |
| `ALLOWED_ORIGINS` | comma-separated CORS origin allowlist for the room REST API (unset = `*`) |

Browser-safe config lives in `public/supabase-config.js` (publishable key) and `public/partykit-config.js` (party host).

## Data model (Supabase)

- `gyms` — name, `room_code` (6 chars), `subscription_status` (trial/active/past_due/canceled), `trial_ends_at`, Stripe customer/subscription ids
- `gym_users` — user ↔ gym membership with role `owner` | `coach`
- `gym_rooms` — extra rooms per gym

- `signup_attempts` — IP + timestamp rows backing the in-code signup rate
  limit (5/hour per IP, 50/hour global; rows pruned after 24h). Create it
  once in the Supabase SQL editor:

  ```sql
  create table signup_attempts (
    id bigint generated always as identity primary key,
    ip text not null,
    created_at timestamptz not null default now()
  );
  create index signup_attempts_ip_time on signup_attempts (ip, created_at);
  alter table signup_attempts enable row level security; -- no policies: service role only
  ```

Platform admins carry `app_metadata.role = 'admin'` and use `/admin.html`.

## Legacy LAN/Electron version

The original offline product (Electron + Express + Socket.io on the gym LAN) was removed after the SaaS migration. It is preserved at the git tag `legacy-lan-server`:

```bash
git checkout legacy-lan-server
```
