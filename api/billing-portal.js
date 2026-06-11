const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { SITE_URL } = require('./_lib/supabase');
const { applyCors } = require('./_lib/cors');
const { requireCaller, resolveOwnedGym } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireCaller(req, res);
  if (!auth) return;

  const gym = await resolveOwnedGym(auth, res, (req.body || {}).roomId, {
    select: 'stripe_customer_id',
    forbiddenMsg: 'Only gym owners can manage billing',
  });
  if (!gym) return;

  if (!gym.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found. Start a subscription first.' });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: gym.stripe_customer_id,
    return_url: SITE_URL,
  });

  return res.status(200).json({ url: session.url });
};
