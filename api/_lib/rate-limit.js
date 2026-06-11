// Signup rate limiting backed by the signup_attempts Supabase table —
// free-tier replacement for a paid Vercel WAF rule. Fails open on storage
// errors so a Supabase outage can't block legitimate signups.
const WINDOW_MS    = 60 * 60 * 1000;
const PER_IP_MAX   = 5;   // attempts per IP per hour
const GLOBAL_MAX   = 50;  // attempts across all IPs per hour
const RETENTION_MS = 24 * 60 * 60 * 1000;

async function checkSignupRate(admin, ip) {
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();

  const { count: ipCount, error: ipErr } = await admin
    .from('signup_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('ip', ip)
    .gte('created_at', windowStart);
  if (!ipErr && ipCount !== null && ipCount >= PER_IP_MAX) return { allowed: false };

  const { count: allCount, error: allErr } = await admin
    .from('signup_attempts')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', windowStart);
  if (!allErr && allCount !== null && allCount >= GLOBAL_MAX) return { allowed: false };

  await admin.from('signup_attempts').insert({ ip });

  // Opportunistic cleanup; failures don't matter
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  admin.from('signup_attempts').delete().lt('created_at', cutoff).then(() => {}, () => {});

  return { allowed: true };
}

module.exports = { checkSignupRate, PER_IP_MAX, GLOBAL_MAX };
