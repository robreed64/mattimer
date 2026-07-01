const { adminClient } = require('./_lib/supabase');
const { applyCors } = require('./_lib/cors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email' });

  const { error } = await adminClient().from('waitlist').insert({ email });

  // 23505 = unique_violation — already signed up, treat as success
  if (error && error.code !== '23505') {
    console.error('waitlist insert error', error);
    return res.status(500).json({ error: 'Something went wrong' });
  }

  return res.status(200).json({ ok: true });
};
