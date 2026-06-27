# Realtime server (PartyKit) staging runbook

## Why

The Vercel frontend gets a fresh preview URL on every push, but **PartyKit has one
environment** — `npx partykit deploy` (`npm run deploy`) goes straight to the
party that live gyms are connected to. A bad room-protocol change can disrupt a
class in progress. This runbook sets up a **separate staging party** so realtime
changes can be tested off-production.

It needs no app code: the frontend already supports pointing at an arbitrary
party host via a `localStorage` override (`public/partykit-config.js`).

## One-time setup: a staging party project

`partykit deploy --name <name>` overrides the project name in `partykit.json`,
creating a **separate deployment with its own Durable Object namespace and env**
(so staging storage is fully isolated from production gym data).

```bash
# Deploy the current party/main.js as a staging project
npx partykit deploy --name bjj-timer-staging

# Give it its own secrets (independent of production)
npx partykit env add PARTY_AUTH_SECRET --name bjj-timer-staging
# Leave REQUIRE_AUTH unset on staging (warn-only) while iterating.
```

Staging host will be: `bjj-timer-staging.<your-account>.partykit.dev`
(e.g. `bjj-timer-staging.robreed64.partykit.dev`).

## Test loop

1. **Deploy your party change to staging only:**
   ```bash
   npx partykit deploy --name bjj-timer-staging
   ```
   Production (`npm run deploy`) is untouched.

2. **Point a browser at staging.** On the production site or a Vercel preview,
   open the console and run:
   ```js
   localStorage.PARTYKIT_HOST = 'bjj-timer-staging.robreed64.partykit.dev';
   // reload; the frontend now talks to the staging party
   ```
   The `demo` room is open (no auth) and a good place to exercise timers/TVs.
   Staging has no real gym data — create test rooms or use `demo`.

3. **Revert your browser to production** when done:
   ```js
   delete localStorage.PARTYKIT_HOST;  // reload
   ```

4. **Ship to production** once it looks good:
   ```bash
   npm run deploy   # = partykit deploy (production)
   ```

## Notes

- **Isolation:** staging and production are separate DO namespaces — staging
  cannot read or write production gym storage. Safe to experiment.
- **Secrets:** if you want staging tokens to interoperate with the production
  Vercel mint endpoint, its `PARTY_AUTH_SECRET` must match Vercel's. For pure
  staging tests against the `demo` room (auth-exempt), the secret value doesn't
  matter. See [`reference: REQUIRE_AUTH lockout`] before enabling `REQUIRE_AUTH`
  anywhere.
- **Two-target deploy:** this is the realtime half of the split documented in
  `CLAUDE.md` — frontend ships via Vercel (git push), party ships via
  `partykit deploy`.
