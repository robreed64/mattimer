const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { SITE_URL } = require('./_lib/supabase');
const { applyCors } = require('./_lib/cors');
const { requireCaller, resolveOwnedGym } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireCaller(req, res);
  if (!auth) return;

  const { roomId } = req.body || {};
  const gym = await resolveOwnedGym(auth, res, roomId, {
    select: 'id, name, stripe_customer_id',
    forbiddenMsg: 'Only gym owners can manage billing',
  });
  if (!gym) return;

  let customerId = gym.stripe_customer_id;

  try {
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: auth.caller.email,
        name: gym.name || auth.caller.email,
        metadata: { gym_id: gym.id },
      });
      customerId = customer.id;
      await auth.admin.from('gyms').update({ stripe_customer_id: customerId }).eq('id', gym.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${SITE_URL}${roomId ? `?room=${roomId}` : ''}#checkout=success`,
      cancel_url:  `${SITE_URL}${roomId ? `?room=${roomId}` : ''}`,
      subscription_data: { metadata: { gym_id: gym.id } },
    });

    return res.status(200).json({ url: session.url });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
