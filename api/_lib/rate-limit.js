// IP-based rate limiting backed by per-feature Supabase tables — free-tier
// replacement for a paid Vercel WAF rule. Fails open on storage errors so a
// Supabase outage can't block legitimate requests.
const RETENTION_MS = 24 * 60 * 60 * 1000;

async function checkRate(admin, table, ip, { windowMs, perIpMax, globalMax }) {
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  const { count: ipCount, error: ipErr } = await admin
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('ip', ip)
    .gte('created_at', windowStart);
  if (!ipErr && ipCount !== null && ipCount >= perIpMax) return { allowed: false };

  const { count: allCount, error: allErr } = await admin
    .from(table)
    .select('*', { count: 'exact', head: true })
    .gte('created_at', windowStart);
  if (!allErr && allCount !== null && allCount >= globalMax) return { allowed: false };

  await admin.from(table).insert({ ip });

  // Opportunistic cleanup; failures don't matter
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  admin.from(table).delete().lt('created_at', cutoff).then(() => {}, () => {});

  return { allowed: true };
}

const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_PER_IP_MAX = 5;   // attempts per IP per hour
const SIGNUP_GLOBAL_MAX = 50;  // attempts across all IPs per hour

async function checkSignupRate(admin, ip) {
  return checkRate(admin, 'signup_attempts', ip, {
    windowMs: SIGNUP_WINDOW_MS, perIpMax: SIGNUP_PER_IP_MAX, globalMax: SIGNUP_GLOBAL_MAX,
  });
}

// Pairing codes are scanned/typed in over a few minutes, so the window is
// much shorter than signup's — a tighter window also limits how long a
// brute-force guesser gets before tripping the per-IP cap.
const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const PAIRING_PER_IP_MAX = 10;  // redeem attempts per IP per 10 min
const PAIRING_GLOBAL_MAX = 200; // redeem attempts across all IPs per 10 min

async function checkPairingRate(admin, ip) {
  return checkRate(admin, 'pairing_attempts', ip, {
    windowMs: PAIRING_WINDOW_MS, perIpMax: PAIRING_PER_IP_MAX, globalMax: PAIRING_GLOBAL_MAX,
  });
}

// Coach (gym username/password) login — same short window as pairing, since it's a
// password guess surface; per-IP cap limits brute force before tripping.
const GYM_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const GYM_LOGIN_PER_IP_MAX = 10;
const GYM_LOGIN_GLOBAL_MAX = 200;

async function checkGymLoginRate(admin, ip) {
  return checkRate(admin, 'gym_login_attempts', ip, {
    windowMs: GYM_LOGIN_WINDOW_MS, perIpMax: GYM_LOGIN_PER_IP_MAX, globalMax: GYM_LOGIN_GLOBAL_MAX,
  });
}

module.exports = {
  checkSignupRate, PER_IP_MAX: SIGNUP_PER_IP_MAX, GLOBAL_MAX: SIGNUP_GLOBAL_MAX,
  checkPairingRate, PAIRING_PER_IP_MAX, PAIRING_GLOBAL_MAX,
  checkGymLoginRate, GYM_LOGIN_PER_IP_MAX, GYM_LOGIN_GLOBAL_MAX,
};
