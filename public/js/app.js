// ─── PARTYKIT SETUP ───────────────────────────────────────────────
const PARTYKIT_HOST = window.PARTYKIT_HOST || 'localhost:1999';

// Room ID comes from ?room= URL param
const _urlParams = new URLSearchParams(location.search);
let roomId = _urlParams.get('room') || null;

let socket = null;        // PartySocket, created when role is chosen
let mode   = null;        // 'controller' | 'display' | null
let _displayTvCode = null;

// Helper: build PartyKit HTTP API URL for this room
function partyApiUrl(path) {
  const proto = PARTYKIT_HOST.startsWith('localhost') ? 'http' : 'https';
  return `${proto}://${PARTYKIT_HOST}/parties/main/${roomId}${path}`;
}

// ─── ROOM TOKEN ───────────────────────────────────────────────────
// Short-lived HMAC token proving this signed-in user may control roomId.
// Sent on controller websocket connects and all PartyKit REST calls.
let _roomToken    = null;
let _roomTokenExp = 0;

function _isDemoRoom() { return roomId?.toLowerCase() === 'demo'; }

async function _mintRoomToken() {
  _roomToken = null; _roomTokenExp = 0;
  if (!roomId || _isDemoRoom()) return null;
  try {
    const { data: { session } } = await _supabase.auth.getSession();
    if (!session) return null;
    const res = await fetch('/api/room-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ roomId }),
    });
    if (!res.ok) return null;
    const { token, exp } = await res.json();
    _roomToken = token; _roomTokenExp = exp;
  } catch(e) {}
  return _roomToken;
}

async function _freshRoomToken() {
  if (!_roomToken || _roomTokenExp - Date.now() < 60_000) await _mintRoomToken();
  return _roomToken;
}

// fetch() against the PartyKit room REST API with the room token attached;
// retries once with a re-minted token on 401.
async function partyFetch(path, opts = {}) {
  const doFetch = () => {
    const headers = { ...(opts.headers || {}) };
    if (_roomToken) headers['Authorization'] = 'Bearer ' + _roomToken;
    return fetch(partyApiUrl(path), { ...opts, headers });
  };
  let res = await doFetch();
  if (res.status === 401 && !_isDemoRoom()) {
    await _mintRoomToken();
    if (_roomToken) res = await doFetch();
  }
  return res;
}

// Helper: send a typed message (replaces socket.emit)
function emit(type, data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data ? { type, ...data } : { type }));
  }
}

// Create a PartySocket connection for the given role + query params
function openSocket(role, extraParams) {
  if (socket) { try { socket.close(); } catch(e) {} }
  // query is a function so PartySocket re-evaluates it on every reconnect,
  // picking up a fresh room token after the old one expires.
  const query = async () => {
    const q = { role, ...(extraParams || {}) };
    if (role === 'controller' && !_isDemoRoom()) {
      const token = await _freshRoomToken();
      if (token) q.token = token;
    }
    return q;
  };
  socket = new PartySocket({
    host:  PARTYKIT_HOST,
    room:  roomId,
    party: 'main',
    query,
  });
  socket.addEventListener('open',    _onOpen);
  socket.addEventListener('close',   _onClose);
  socket.addEventListener('message', _onMessage);
  socket.addEventListener('error',   () => {});
}

// ─── SUPABASE AUTH ────────────────────────────────────────────────
const _supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_PUBLISHABLE_KEY);
let _currentUser = null;
let _gymRole     = null; // 'owner' | 'coach'
let _gymId       = null;
let _gymSub      = null; // { status, trial_ends_at }
let _gymName     = null;
let _allRooms    = []; // populated when gym has multiple rooms

function togglePw(inputId, btn) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
  btn.textContent = el.type === 'text' ? '🙈' : '👁';
}

async function signIn() {
  const email = document.getElementById('authEmail').value.trim();
  const pass  = document.getElementById('authPass').value;
  const errEl = document.getElementById('authError');
  errEl.style.display = 'none';

  const { data, error } = await _supabase.auth.signInWithPassword({ email, password: pass });
  if (error) { errEl.style.display = 'block'; return; }
  await _afterAuth(data.user);
}

async function forgotPassword() {
  const email = document.getElementById('authEmail').value.trim();
  if (!email) { alert('Enter your email address first.'); return; }
  const { error } = await _supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) { alert('Error: ' + error.message); return; }
  alert('Password reset link sent — check your email.');
}

async function signOut() {
  await _supabase.auth.signOut();
  _currentUser = null; _gymRole = null; _gymId = null;
  window.location.href = location.pathname;
}

function showLogin() {
  document.getElementById('marketingView').style.display = 'none';
  document.getElementById('signupView').style.display = 'none';
  document.getElementById('loginView').style.display = 'flex';
}

function showSignup() {
  document.getElementById('marketingView').style.display = 'none';
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('signupForm').style.display = 'block';
  document.getElementById('signupSuccess').style.display = 'none';
  document.getElementById('signupError').style.display = 'none';
  document.getElementById('signupName').value = '';
  document.getElementById('signupGymName').value = '';
  document.getElementById('signupEmail').value = '';
  document.getElementById('signupView').style.display = 'flex';
  setTimeout(() => document.getElementById('signupName').focus(), 50);
}

function backToMarketing() {
  document.getElementById('signupView').style.display = 'none';
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('marketingView').style.display = 'flex';
}

async function submitSignup() {
  const name     = document.getElementById('signupName').value.trim();
  const gymName  = document.getElementById('signupGymName').value.trim();
  const email    = document.getElementById('signupEmail').value.trim();
  const errEl    = document.getElementById('signupError');
  const btn      = document.getElementById('signupBtn');

  errEl.style.display = 'none';

  if (!name || !gymName || !email) {
    errEl.textContent = 'Please fill in all fields.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const res  = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, gymName, email, website: document.getElementById('signupWebsite')?.value || '' }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Something went wrong. Please try again.';
      errEl.style.display = 'block';
    } else {
      document.getElementById('signupForm').style.display = 'none';
      document.getElementById('signupSuccess').style.display = 'block';
    }
  } catch (e) {
    errEl.textContent = 'Network error. Please check your connection and try again.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start Free Trial';
  }
}

// ─── ACCOUNT MODAL ────────────────────────────────────────────────
function openAccountModal() {
  document.getElementById('accountEmailDisplay').textContent = _currentUser?.email || '';
  document.getElementById('acctNewPw').value = '';
  document.getElementById('acctConfirmPw').value = '';
  document.getElementById('acctPwError').style.display = 'none';

  // Billing section — only for gym owners
  const billingSection = document.getElementById('accountBillingSection');
  if (_gymRole === 'owner' && _gymSub) {
    billingSection.style.display = 'block';
    const { status, trial_ends_at } = _gymSub;
    const trialEnd = trial_ends_at ? new Date(trial_ends_at) : null;
    const now = new Date();
    let statusHtml, btnHtml;
    if (status === 'active' || status === 'trialing') {
      statusHtml = '<span style="color:#2ecc71">&#10003; Active</span>';
      btnHtml = `<button class="btn btn-outline" style="font-size:.8rem;padding:.4rem .9rem;width:100%" onclick="openBillingPortal()">Manage Billing</button>`;
    } else if (status === 'trial' && trialEnd && trialEnd > now) {
      const days = Math.ceil((trialEnd - now) / 86400000);
      statusHtml = `Free trial — <span style="color:var(--mat-gold)">${days} day${days !== 1 ? 's' : ''} remaining</span>`;
      btnHtml = `<button class="btn btn-gold" style="font-size:.8rem;padding:.4rem .9rem;width:100%" onclick="startCheckout()">Subscribe Now</button>`;
    } else if (status === 'past_due' || status === 'unpaid') {
      statusHtml = '<span style="color:var(--mat-red)">Payment issue — please update your card</span>';
      btnHtml = `<button class="btn btn-gold" style="font-size:.8rem;padding:.4rem .9rem;width:100%" onclick="openBillingPortal()">Update Payment</button>`;
    } else {
      statusHtml = '<span style="color:var(--mat-muted)">No active subscription</span>';
      btnHtml = `<button class="btn btn-gold" style="font-size:.8rem;padding:.4rem .9rem;width:100%" onclick="startCheckout()">Start Subscription</button>`;
    }
    document.getElementById('accountBillingStatus').innerHTML = `<span style="font-family:var(--font-ui);font-size:.85rem">${statusHtml}</span>`;
    document.getElementById('accountBillingBtn').innerHTML = btnHtml;
  } else {
    billingSection.style.display = 'none';
  }

  document.getElementById('accountModal').style.display = 'flex';
}

function closeAccountModal(e) {
  if (e && e.target !== document.getElementById('accountModal')) return;
  document.getElementById('accountModal').style.display = 'none';
}

async function changePassword() {
  const pw  = document.getElementById('acctNewPw').value;
  const pw2 = document.getElementById('acctConfirmPw').value;
  const errEl = document.getElementById('acctPwError');
  errEl.style.display = 'none';
  if (pw.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; errEl.style.display = 'block'; return; }
  if (pw !== pw2)    { errEl.textContent = 'Passwords do not match.'; errEl.style.display = 'block'; return; }
  const { error } = await _supabase.auth.updateUser({ password: pw });
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return; }
  toast('Password updated');
  closeAccountModal();
}

// ─── BILLING ──────────────────────────────────────────────────────
function _checkSubscription() {
  if (!_gymSub || _gymRole !== 'owner') return;
  const { status, trial_ends_at } = _gymSub;
  const trialEnd = trial_ends_at ? new Date(trial_ends_at) : null;
  const now = new Date();
  const trialActive = status === 'trial' && trialEnd && trialEnd > now;
  const needsUpgrade = (status === 'trial' && (!trialEnd || trialEnd <= now))
    || status === 'canceled' || status === 'past_due' || status === 'unpaid';

  if (trialActive) {
    const days = Math.ceil((trialEnd - now) / 86400000);
    const bar = document.getElementById('roomBar');
    if (bar && !bar.querySelector('.trial-badge')) {
      const badge = document.createElement('span');
      badge.className = 'trial-badge';
      badge.style.cssText = 'font-family:var(--font-ui);font-size:.7rem;letter-spacing:.1em;color:var(--mat-muted);margin-left:auto;padding:.15rem .4rem;border:1px solid var(--mat-border);border-radius:3px;white-space:nowrap';
      badge.textContent = `Trial: ${days}d left`;
      bar.appendChild(badge);
    }
  }

  if (needsUpgrade) {
    _showUpgradeModal(status === 'trial' ? 'Your free trial has ended.' : 'Your subscription is inactive.');
  }
}

function _showUpgradeModal(reason) {
  // Remove any existing paywall modal
  document.getElementById('paywallModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'paywallModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem';
  modal.innerHTML = `
    <div style="background:var(--mat-panel);border:1px solid var(--mat-border);border-radius:8px;padding:2.5rem;width:100%;max-width:380px;text-align:center">
      <div style="font-family:var(--font-display);font-size:1.8rem;letter-spacing:.1em;color:var(--mat-gold);margin-bottom:.5rem">BJJ MAT TIMER</div>
      <div style="font-family:var(--font-ui);font-size:.9rem;color:var(--mat-muted);margin-bottom:1.5rem">${reason}</div>
      <button class="btn btn-gold" style="width:100%;font-size:1rem;padding:.85rem;margin-bottom:.75rem" onclick="startCheckout()">Start Subscription</button>
      <button class="btn btn-outline" style="width:100%;font-size:.85rem;padding:.65rem" onclick="signOut()">Sign Out</button>
    </div>`;
  document.body.appendChild(modal);
}

async function startCheckout() {
  try {
    toast('Opening checkout…');
    const { data: { session } } = await _supabase.auth.getSession();
    if (!session) { toast('Session expired — please sign in again.'); return; }
    const res = await fetch('/api/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ roomId }),
    });
    const data = await res.json();
    if (!data.url) { toast('Error: ' + (data.error || 'Could not start checkout')); return; }
    window.location.href = data.url;
  } catch(e) {
    toast('Error: ' + e.message);
  }
}

async function openBillingPortal() {
  try {
    toast('Opening billing portal…');
    const { data: { session } } = await _supabase.auth.getSession();
    if (!session) { toast('Session expired — please sign in again.'); return; }
    const res = await fetch('/api/billing-portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ roomId }),
    });
    const data = await res.json();
    if (!data.url) { toast('Error: ' + (data.error || 'Could not open billing portal')); return; }
    window.location.href = data.url;
  } catch(e) {
    toast('Error: ' + e.message);
  }
}

// ─── DEMO MODE ────────────────────────────────────────────────────
function _enterDemoMode() {
  _gymRole = 'owner';
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('roomBar').style.display = 'flex';
  document.getElementById('demoBanner').style.display = 'flex';
  const codeEl = document.getElementById('roomCodeDisplay');
  if (codeEl) codeEl.textContent = 'Demo';
  partyFetch('/api/config').then(r => r.json()).then(cfg => {
    tvCodes  = cfg.tvCodes;
    branding = { ...branding, ...cfg.branding };
    applyBranding();
  }).catch(() => {});
}

// ─── ONBOARDING CHECKLIST ─────────────────────────────────────────
async function showOnboardingIfNeeded() {
  if (_gymRole !== 'owner' || !_gymId) return;
  const key = 'onboarding_dismissed_' + _gymId;
  if (localStorage.getItem(key)) return;

  // Check how many team members exist (excluding self)
  const { data: members } = await _supabase
    .from('gym_users')
    .select('id')
    .eq('gym_id', _gymId)
    .neq('user_id', _currentUser.id);

  const hasName  = branding.appName && branding.appName !== 'BJJ Mat Timer';
  const hasLogo  = !!branding.logoDataUrl;
  const hasTeam  = members && members.length > 0;

  // Don't show if everything is done
  if (hasName && hasLogo && hasTeam) return;

  const steps = [
    { done: hasName,  text: 'Name your gym',          action: 'openBrandingModal()',  hint: 'Set your gym name and tagline in branding settings' },
    { done: hasLogo,  text: 'Upload your logo',        action: 'openBrandingModal()',  hint: 'Add your gym logo for the display screens' },
    { done: hasTeam,  text: 'Invite your first instructor', action: 'openCoachesModal()', hint: 'Add a coach or instructor to your team' },
  ];

  const stepsHtml = steps.map(s => `
    <div style="display:flex;align-items:center;gap:.75rem;padding:.4rem 0;border-bottom:1px solid var(--mat-border)">
      <span style="font-size:1rem;flex-shrink:0">${s.done ? '✅' : '⬜'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--font-ui);font-size:.85rem;color:${s.done ? 'var(--mat-muted)' : 'var(--mat-text)'};${s.done ? 'text-decoration:line-through' : ''}">${s.text}</div>
        ${!s.done ? `<div style="font-family:var(--font-ui);font-size:.72rem;color:var(--mat-muted)">${s.hint}</div>` : ''}
      </div>
      ${!s.done ? `<button onclick="${s.action};document.getElementById('onboardingCard').style.display='none'" style="background:none;border:1px solid var(--mat-border);border-radius:3px;color:var(--mat-gold);font-family:var(--font-ui);font-size:.72rem;padding:.2rem .5rem;cursor:pointer;flex-shrink:0">Do it →</button>` : ''}
    </div>`).join('');

  document.getElementById('onboardingSteps').innerHTML = stepsHtml;
  document.getElementById('onboardingCard').style.display = 'block';
}

function dismissOnboarding() {
  if (_gymId) localStorage.setItem('onboarding_dismissed_' + _gymId, '1');
  document.getElementById('onboardingCard').style.display = 'none';
}

async function _afterAuth(user) {
  _currentUser = user;

  const isAdmin = user.app_metadata?.role === 'admin';
  const roomParam = new URLSearchParams(location.search).get('room');

  // Admin without a specific room → go to admin panel
  if (isAdmin && !roomParam) {
    window.location.href = '/admin.html';
    return;
  }

  // Admin entering a specific gym → treat as owner
  if (isAdmin && roomParam) {
    _gymRole = 'owner';
    roomId   = roomParam;
    _mintRoomToken();
    document.getElementById('loginView').style.display = 'none';
    document.getElementById('roomBar').style.display = 'flex';
    const codeEl = document.getElementById('roomCodeDisplay');
    if (codeEl) codeEl.textContent = roomParam;
    // Show admin back-link in room bar
    const bar = document.getElementById('roomBar');
    if (bar && !bar.querySelector('.admin-back-link')) {
      const link = document.createElement('a');
      link.href = '/admin.html';
      link.textContent = '← Admin';
      link.className = 'admin-back-link';
      link.style.cssText = 'font-family:var(--font-ui);font-size:.75rem;letter-spacing:.1em;color:var(--mat-gold);text-decoration:none;margin-left:auto;padding:.25rem .5rem;border:1px solid var(--mat-gold);border-radius:3px';
      bar.appendChild(link);
    }
    document.getElementById('teamBtn')?.style.setProperty('display', 'inline-flex');
    document.getElementById('brandingBtn')?.style.setProperty('display', 'inline-flex');
    return;
  }

  // Look up the user's gym
  const { data: membership } = await _supabase
    .from('gym_users')
    .select('role, gym_id, gyms(room_code, name, subscription_status, trial_ends_at)')
    .eq('user_id', user.id)
    .single();

  if (!membership) {
    document.getElementById('loginView').style.display = 'flex';
    document.getElementById('authError').textContent = 'No gym assigned to your account. Contact your administrator.';
    document.getElementById('authError').style.display = 'block';
    await _supabase.auth.signOut();
    return;
  }

  _gymRole = membership.role;
  _gymId   = membership.gym_id;
  _gymName = membership.gyms.name;
  _gymSub  = { status: membership.gyms.subscription_status, trial_ends_at: membership.gyms.trial_ends_at };

  // Check for additional rooms (owners only — coaches always go to the main room)
  if (_gymRole === 'owner') {
    const { data: extraRooms } = await _supabase
      .from('gym_rooms')
      .select('id, name, room_code')
      .eq('gym_id', _gymId)
      .order('created_at');
    if (extraRooms && extraRooms.length > 0) {
      _allRooms = [
        { id: null, name: 'Main Mat', room_code: membership.gyms.room_code },
        ...extraRooms,
      ];
      document.getElementById('loginView').style.display = 'none';
      _showRoomPicker();
      return;
    }
  }

  roomId = membership.gyms.room_code;
  _finishRoomSetup();
}

// Check session on every page load
(async function initAuth() {
  // Demo mode — skip auth entirely for ?room=demo
  if (roomId?.toLowerCase() === 'demo') {
    _enterDemoMode();
    return;
  }

  const hashParams = new URLSearchParams(location.hash.replace('#', ''));
  const tokenType   = hashParams.get('type');
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token') || '';

  if ((tokenType === 'invite' || tokenType === 'recovery') && accessToken) {
    // Exchange the one-time tokens for a real session before showing the form
    const { error: sessErr } = await _supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (sessErr) {
      document.getElementById('loginView').style.display = 'flex';
      const err = document.getElementById('authError');
      if (err) { err.textContent = 'Invalid or expired invite link. Ask your admin to resend it.'; err.style.display = 'block'; }
      return;
    }
    _showSetPassword();
    return;
  }

  const { data: { session } } = await _supabase.auth.getSession();
  if (!session) {
    if (roomId) {
      document.getElementById('loginView').style.display = 'flex';
    } else {
      document.getElementById('marketingView').style.display = 'flex';
    }
    return;
  }
  await _afterAuth(session.user);

  // Stripe checkout return
  if (location.hash === '#checkout=success') {
    history.replaceState(null, '', location.href.replace('#checkout=success', ''));
    toast('Payment successful — your subscription is now active!');
  }

  if (roomId) {
    document.getElementById('roomBar').style.display = 'flex';
    const el = document.getElementById('roomCodeDisplay');
    if (el && el.textContent === roomId) el.textContent = roomId;
  }
})();

function _showSetPassword() {
  const lv = document.getElementById('loginView');
  lv.style.display = 'flex';
  lv.innerHTML = `
    <div style="background:var(--mat-panel);border:1px solid var(--mat-border);border-radius:8px;padding:2.5rem;width:100%;max-width:380px">
      <div style="font-family:var(--font-display);font-size:2rem;letter-spacing:.15em;color:var(--mat-gold);text-align:center;margin-bottom:.25rem">BJJ MAT TIMER</div>
      <div style="font-family:var(--font-ui);font-size:.75rem;letter-spacing:.3em;color:var(--mat-muted);text-align:center;margin-bottom:2rem;text-transform:uppercase">Set your password</div>
      <div style="display:flex;flex-direction:column;gap:.75rem;margin-bottom:1.25rem">
        <div>
          <label style="font-family:var(--font-ui);font-size:.75rem;letter-spacing:.15em;color:var(--mat-muted);text-transform:uppercase;display:block;margin-bottom:.35rem">New Password</label>
          <div style="display:flex;align-items:center;gap:.5rem">
            <input type="password" id="setPassInput" placeholder="Min 8 characters" autocapitalize="none" autocorrect="off"
              style="flex:1;min-width:0;background:var(--mat-dark);border:1px solid var(--mat-border);border-radius:4px;color:var(--mat-text);font-family:var(--font-ui);font-size:1rem;padding:.7rem 1rem;outline:none"
              onkeydown="if(event.key==='Enter')setNewPassword()">
            <button type="button" onclick="togglePw('setPassInput',this)" tabindex="-1"
              style="flex-shrink:0;background:none;border:1px solid var(--mat-border);border-radius:4px;cursor:pointer;color:var(--mat-muted);font-size:.9rem;padding:.6rem .65rem;line-height:1">👁</button>
          </div>
        </div>
      </div>
      <button class="btn btn-gold" style="width:100%;font-size:1.1rem;padding:.85rem" onclick="setNewPassword()">Set Password &amp; Sign In</button>
      <div id="setPassError" style="display:none;color:var(--mat-red);font-family:var(--font-ui);font-size:.85rem;text-align:center;margin-top:.75rem"></div>
    </div>`;
}

async function setNewPassword() {
  const pass = document.getElementById('setPassInput').value;
  const errEl = document.getElementById('setPassError');
  errEl.style.display = 'none';
  if (pass.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; errEl.style.display = 'block'; return; }

  const { data, error } = await _supabase.auth.updateUser({ password: pass });
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return; }

  // Clear the hash so the token isn't reused, then route normally
  history.replaceState(null, '', location.pathname);
  await _afterAuth(data.user);
}

// ─── ROOM HELPERS ─────────────────────────────────────────────────
function copyRoomLink() {
  const url = `${location.origin}${location.pathname}?room=${roomId}`;
  navigator.clipboard.writeText(url)
    .then(() => toast('Room link copied!'))
    .catch(() => prompt('Room link:', url));
}

function changeRoom() {
  location.href = location.pathname;
}

// ─── ROOM HELPERS (multi-room) ────────────────────────────────────
function _showRoomPicker() {
  const list = document.getElementById('gymRoomList');
  list.innerHTML = _allRooms.map(r => `
    <button class="btn btn-outline" style="width:100%;text-align:left;padding:.75rem 1rem;display:flex;justify-content:space-between;align-items:center" onclick="selectRoom('${escHtml(r.room_code)}')">
      <span style="font-family:var(--font-ui);font-size:.95rem">${escHtml(r.name)}</span>
      <span style="font-family:var(--font-display);font-size:1.2rem;letter-spacing:.15em;color:var(--mat-gold)">${escHtml(r.room_code)}</span>
    </button>
  `).join('');
  document.getElementById('gymRoomPicker').style.display = 'flex';
}

function selectRoom(code) {
  roomId = code;
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.replaceState(null, '', url.toString());
  _finishRoomSetup();
}

async function _finishRoomSetup() {
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('gymRoomPicker').style.display = 'none';
  document.getElementById('roomBar').style.display = 'flex';
  const codeEl = document.getElementById('roomCodeDisplay');
  if (codeEl) codeEl.textContent = _gymName || roomId;

  await _mintRoomToken();

  if (_gymRole === 'owner') {
    const btn = document.getElementById('coachesBtn');
    if (btn) btn.style.display = '';
  }

  partyFetch('/api/config').then(r => r.json()).then(cfg => {
    tvCodes  = cfg.tvCodes;
    branding = { ...branding, ...cfg.branding };
    applyBranding();
    restoreAudioSlots(cfg.audioSlots);
    showOnboardingIfNeeded();
    if (_gymRole === 'owner') {
      _checkSubscription();
      loadRecentSessions();
    }
  }).catch(() => {});

  if (_gymRole === 'coach') {
    document.querySelectorAll('.brand-btn').forEach(b => b.style.display = 'none');
  }
}

// ─── SESSION HISTORY ──────────────────────────────────────────────
async function loadRecentSessions() {
  if (_gymRole !== 'owner' || !roomId) return;
  const res = await partyFetch('/api/sessions').catch(() => null);
  if (!res?.ok) return;
  const { sessions } = await res.json();
  if (!sessions?.length) return;
  const card = document.getElementById('activityCard');
  const list = document.getElementById('activityList');
  if (!card || !list) return;
  list.innerHTML = sessions.map(s => {
    const d = new Date(s.date);
    const mins = Math.floor(s.duration / 60);
    const dur = mins >= 1 ? mins + 'm' : s.duration + 's';
    return `<div style="display:flex;align-items:center;gap:.75rem;padding:.3rem 0;border-bottom:1px solid var(--mat-border);font-family:var(--font-ui);font-size:.82rem">
      <span style="color:var(--mat-muted);width:6ch;flex-shrink:0">${d.toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>
      <span style="color:var(--mat-text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(s.name)}</span>
      <span style="color:var(--mat-muted);flex-shrink:0">${dur}</span>
    </div>`;
  }).join('');
  card.style.display = 'block';
}

function dismissActivity() {
  const card = document.getElementById('activityCard');
  if (card) card.style.display = 'none';
}

// ─── TV CODE REGENERATION ─────────────────────────────────────────
async function regenerateTvCode(slot) {
  const btn = document.getElementById('regenBtn-' + slot);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const res = await partyFetch(`/api/tvCodes/${slot}/regenerate`, { method: 'POST' });
    const data = await res.json();
    if (data.tvCodes) {
      tvCodes = data.tvCodes;
      for (let i = 1; i <= 4; i++) {
        const landingEl = document.getElementById('landing-tv-code-' + i);
        if (landingEl) landingEl.textContent = tvCodes[i - 1];
        const modalEl = document.getElementById('tvCode-' + i);
        if (modalEl) modalEl.textContent = tvCodes[i - 1];
      }
      toast('TV ' + slot + ' code regenerated');
    }
  } catch(e) { toast('Error regenerating code'); }
  if (btn) { btn.disabled = false; btn.textContent = 'Regen'; }
}

// ─── MULTI-ROOM MANAGEMENT ────────────────────────────────────────
async function loadRoomsList() {
  const { data: { session } } = await _supabase.auth.getSession();
  const res = await fetch(`/api/create-room?roomId=${encodeURIComponent(roomId)}`, {
    headers: { 'Authorization': 'Bearer ' + session.access_token },
  });
  if (!res.ok) return;
  const { rooms } = await res.json();
  const list = document.getElementById('roomsList');
  if (!list) return;
  let html = `<div style="display:flex;align-items:center;justify-content:space-between;padding:.4rem .6rem;background:var(--mat-dark);border-radius:4px;border:1px solid var(--mat-border)">
    <span style="font-family:var(--font-ui);font-size:.82rem">Main Mat</span>
    <span style="font-family:var(--font-display);font-size:.85rem;letter-spacing:.15em;color:var(--mat-gold)">${roomId}</span>
  </div>`;
  if (rooms) {
    for (const r of rooms) {
      const roomUrl = `${location.origin}${location.pathname}?room=${encodeURIComponent(r.room_code)}`;
      html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:.4rem .6rem;background:var(--mat-dark);border-radius:4px;border:1px solid var(--mat-border)">
        <div>
          <div style="font-family:var(--font-ui);font-size:.82rem">${escHtml(r.name)}</div>
          <div style="font-family:var(--font-display);font-size:.72rem;letter-spacing:.12em;color:var(--mat-gold)">${r.room_code}</div>
        </div>
        <div style="display:flex;gap:.35rem;align-items:center">
          <button class="btn btn-outline" style="font-size:.7rem;padding:.25rem .5rem" onclick="navigator.clipboard.writeText('${roomUrl}').then(()=>toast('Link copied!'))">Copy Link</button>
          <button style="background:none;border:none;color:var(--mat-muted);cursor:pointer;font-size:.85rem;padding:.15rem .35rem;border-radius:3px" onclick="deleteRoom('${r.id}')" title="Remove">✕</button>
        </div>
      </div>`;
    }
  }
  list.innerHTML = html;
}

async function addRoomPrompt() {
  const name = prompt('Room name (e.g. "Kids Mat", "MMA Cage"):');
  if (!name?.trim()) return;
  const { data: { session } } = await _supabase.auth.getSession();
  const res = await fetch('/api/create-room', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
    body: JSON.stringify({ name: name.trim(), roomId }),
  });
  const data = await res.json();
  if (!res.ok) { toast('Error: ' + (data.error || 'Could not create room')); return; }
  toast(`Room "${data.name}" created — code: ${data.code}`);
  loadRoomsList();
}

async function deleteRoom(id) {
  if (!confirm('Remove this room? Anyone using its code will lose access.')) return;
  const { data: { session } } = await _supabase.auth.getSession();
  const res = await fetch('/api/create-room', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
    body: JSON.stringify({ id, roomId }),
  });
  const data = await res.json();
  if (!res.ok) { toast('Error: ' + (data.error || 'Could not remove room')); return; }
  toast('Room removed.');
  loadRoomsList();
}

// ─── COACHES PANEL (owner only) ───────────────────────────────────
async function openCoachesModal() {
  document.getElementById('coachesModal').style.display = 'flex';
  document.getElementById('newCoachEmail').value = '';
  await loadCoaches();
}

function closeCoachesModal(e) {
  if (e && e.target !== document.getElementById('coachesModal')) return;
  document.getElementById('coachesModal').style.display = 'none';
}

async function loadCoaches() {
  const list = document.getElementById('coachList');
  list.innerHTML = '<div style="color:var(--mat-muted);font-size:.85rem;padding:.25rem 0">Loading…</div>';

  const { data, error } = await _supabase
    .from('gym_users')
    .select('id, role, user_id, name, email')
    .eq('gym_id', _gymId)
    .neq('user_id', _currentUser?.id);

  if (error || !data?.length) {
    list.innerHTML = '<div style="color:var(--mat-muted);font-family:var(--font-ui);font-size:.85rem;padding:.25rem 0">No team members yet.</div>';
    return;
  }

  list.innerHTML = data.map(c => {
    const label = c.name ? `${escHtml(c.name)} <span style="color:var(--mat-muted);font-size:.8rem">${escHtml(c.email || '')}</span>` : escHtml(c.email || c.user_id);
    const hasSettings = c.role === 'owner';
    const settingsBtnLabel = hasSettings ? '⚙ Settings On' : '⚙ Settings Off';
    const settingsBtnStyle = hasSettings
      ? 'border-color:var(--mat-gold);color:var(--mat-gold)'
      : 'border-color:var(--mat-border);color:var(--mat-muted)';
    return `<div style="display:flex;align-items:center;justify-content:space-between;background:var(--mat-dark);border:1px solid var(--mat-border);border-radius:4px;padding:.5rem .75rem;gap:.5rem">
      <span style="font-family:var(--font-ui);font-size:.9rem;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span>
      <div style="display:flex;gap:.4rem;flex-shrink:0">
        <button onclick="toggleMemberSettings('${c.id}','${c.role}')" style="background:none;border:1px solid;border-radius:3px;${settingsBtnStyle};font-family:var(--font-ui);font-size:.72rem;padding:.2rem .5rem;cursor:pointer">${settingsBtnLabel}</button>
        <button onclick="removeCoach('${c.id}')" style="background:none;border:none;color:var(--mat-muted);cursor:pointer;font-size:.8rem;padding:.2rem .4rem" title="Remove">✕</button>
      </div>
    </div>`;
  }).join('');
}

async function toggleMemberSettings(gymUserId, currentRole) {
  if (_gymRole !== 'owner') return;
  const newRole = currentRole === 'owner' ? 'coach' : 'owner';
  const { error } = await _supabase.from('gym_users').update({ role: newRole }).eq('id', gymUserId);
  if (error) { toast('Error: ' + error.message); return; }
  toast(newRole === 'owner' ? 'Settings access granted' : 'Settings access removed');
  await loadCoaches();
}

async function addCoach() {
  const email = document.getElementById('newCoachEmail').value.trim();
  if (!email) { toast('Email is required'); return; }

  const { data: { session } } = await _supabase.auth.getSession();
  const res = await fetch('/api/create-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
    body: JSON.stringify({ email, gymId: _gymId }),
  });
  const data = await res.json();
  if (!data.ok) { toast('Error: ' + (data.error || 'Unknown error')); return; }
  toast('Invite created');
  document.getElementById('newCoachEmail').value = '';
  document.getElementById('coachInviteLink').value = data.inviteLink;
  document.getElementById('coachInviteBox').style.display = 'block';
  await loadCoaches();
}

function copyCoachInvite() {
  const val = document.getElementById('coachInviteLink').value;
  navigator.clipboard.writeText(val).then(() => toast('Link copied!')).catch(() => {});
}

async function removeCoach(gymUserId) {
  if (_gymRole !== 'owner') return;
  if (!confirm('Remove this instructor from your gym?')) return;
  const { error } = await _supabase.from('gym_users').delete().eq('id', gymUserId);
  if (error) { toast('Error: ' + error.message); return; }
  toast('Instructor removed');
  await loadCoaches();
}

// ─── STATE ────────────────────────────────────────────────────────

// ─── STATE ────────────────────────────────────────────────────────
const state = {
  roundDuration: 5 * 60, restDuration: 60, totalRounds: 10,
  currentRound: 1, timeRemaining: 5 * 60, running: false,
  phase: 'fight', warningEnabled: true, warningThreshold: 30,
  showRound: false, overlayMsg: '',
};

let timerInterval = null;
let tvCodes = [];
let branding = { appName: 'BJJ Mat Timer', tagline: 'Competition · Training · Sparring', logoDataUrl: '' };

// ─── CONTROLLER IDENTITY ──────────────────────────────────────────
let myCtrlSlot  = null;
let myCtrlColor = null;
let myCtrlName  = '';
let myTvClaims  = new Set();

const CTRL_COLOR_HEX = {
  blue: '#3B82F6', green: '#10B981', amber: '#F59E0B', pink: '#EC4899',
};
const CTRL_COLOR_LABEL = {
  blue: 'Controller 1', green: 'Controller 2', amber: 'Controller 3', pink: 'Controller 4',
};

// ─── AUDIO ENGINE ─────────────────────────────────────────────────
let audioCtx = null;
let soundTheme = localStorage.getItem('mattimer_sound_theme') || 'classic';
function setSoundTheme(t) { soundTheme = t; localStorage.setItem('mattimer_sound_theme', t); }
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function beep(freq, dur, type='sine', vol=0.6, delay=0) {
  const ctx = getAudioCtx(), t = ctx.currentTime + delay;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type = type; osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.start(t); osc.stop(t + dur + 0.05);
}
function playCountdownBeep() { beep(880, 0.08, 'square', 0.4); }
function playAccentBeep() { beep(1320, 0.12, 'square', 0.55); beep(1100, 0.08, 'square', 0.3, 0.12); }
function playBuzzer() {
  const ctx = getAudioCtx(), now = ctx.currentTime, dur = 1.8;
  [[120,90,'sawtooth',0.7],[240,180,'square',0.35],[480,480,'sawtooth',0.15]].forEach(([f1,f2,type,vol],i) => {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.connect(g); g.connect(ctx.destination); osc.type = type;
    osc.frequency.setValueAtTime(f1, now); osc.frequency.linearRampToValueAtTime(f2, now + dur);
    const d = i === 2 ? 0.6 : dur;
    g.gain.setValueAtTime(vol, now); g.gain.exponentialRampToValueAtTime(0.001, now + d);
    osc.start(now); osc.stop(now + d + 0.1);
  });
}
function testBuzzer() { SOUND_THEMES[soundTheme].buzzerSound(); }

// ─── SOUND THEMES ─────────────────────────────────────────────────
function _ringBell(freq, dur, vol, delay = 0) {
  const ctx = getAudioCtx(), t = ctx.currentTime + delay;
  [freq, freq * 2.76, freq * 5.4].forEach((f, i) => {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.connect(g); g.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.value = f;
    const v = vol * [1, 0.4, 0.15][i];
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.start(t); osc.stop(t + dur + 0.1);
  });
}
function _digitalAlarm() {
  for (let i = 0; i < 4; i++) { beep(800, 0.12, 'sine', 0.4, i * 0.25); beep(600, 0.12, 'sine', 0.4, i * 0.25 + 0.13); }
}
const SOUND_THEMES = {
  classic: {
    countdownBeep() { playCountdownBeep(); },
    accentBeep()    { playAccentBeep(); },
    startSound()    { beep(660, 0.12, 'sine', 0.5); },
    restSound()     { beep(330, 0.3, 'sine', 0.45); beep(294, 0.3, 'sine', 0.35, 0.25); },
    buzzerSound()   { playBuzzer(); },
  },
  bell: {
    countdownBeep() { beep(1800, 0.05, 'sine', 0.3); },
    accentBeep()    { _ringBell(500, 0.3, 0.7); _ringBell(500, 0.3, 0.7, 0.08); },
    startSound()    { _ringBell(500, 1.5, 0.9); },
    restSound()     { _ringBell(330, 1.2, 0.6); },
    buzzerSound()   { _ringBell(500, 1.0, 0.9); _ringBell(500, 1.0, 0.9, 0.28); _ringBell(500, 1.0, 0.9, 0.56); },
  },
  digital: {
    countdownBeep() { beep(1000, 0.07, 'sine', 0.35); },
    accentBeep()    { beep(1000, 0.08, 'sine', 0.4); beep(1500, 0.08, 'sine', 0.4, 0.1); },
    startSound()    { beep(523, 0.1, 'sine', 0.4); beep(659, 0.1, 'sine', 0.4, 0.1); beep(784, 0.15, 'sine', 0.45, 0.2); },
    restSound()     { beep(660, 0.12, 'sine', 0.35); beep(523, 0.15, 'sine', 0.35, 0.15); },
    buzzerSound()   { _digitalAlarm(); },
  },
  minimal: {
    countdownBeep() { beep(440, 0.06, 'sine', 0.15); },
    accentBeep()    { beep(660, 0.08, 'sine', 0.2); },
    startSound()    { beep(880, 0.12, 'sine', 0.25); },
    restSound()     { beep(440, 0.15, 'sine', 0.2); },
    buzzerSound()   { beep(330, 0.3, 'sine', 0.3); beep(294, 0.3, 'sine', 0.25, 0.35); },
  },
};

// ─── CUSTOM AUDIO FILES ───────────────────────────────────────────
const customAudio = { start: null, stop: null, rest: null };

function setAudioSlot(slot, url, name) {
  customAudio[slot] = { url, name };
  const nameEl = document.getElementById('audio' + cap(slot) + 'Name');
  if (nameEl) { nameEl.textContent = name; nameEl.closest('.audio-file-btn').classList.add('loaded'); }
}

function loadAudioFile(slot, input) {
  const file = input.files[0]; if (!file) return;
  const localUrl = URL.createObjectURL(file);
  setAudioSlot(slot, localUrl, file.name);
  toast('Uploading ' + cap(slot) + ' sound...');
  partyFetch('/api/audio/' + slot, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'audio/mpeg', 'X-Filename': file.name },
    body: file,
  })
  .then(r => r.json())
  .then(data => {
    if (data.ok) {
      URL.revokeObjectURL(localUrl);
      customAudio[slot] = { url: data.url, name: data.name };
      toast('✓ ' + cap(slot) + ' sound saved');
    }
  })
  .catch(() => toast('⚠ ' + cap(slot) + ' sound loaded (not saved to disk)'));
}

async function clearAudioFile(slot) {
  customAudio[slot] = null;
  const nameEl = document.getElementById('audio' + cap(slot) + 'Name');
  if (nameEl) { nameEl.textContent = 'Choose file'; nameEl.closest('.audio-file-btn').classList.remove('loaded'); }
  const input = document.getElementById('audio' + cap(slot)); if (input) input.value = '';
  try {
    await partyFetch('/api/audio/' + slot, { method: 'DELETE' });
    emit('audio:clear', { slot });
    toast(cap(slot) + ' sound removed');
  } catch(e) {
    toast(cap(slot) + ' sound removed (offline)');
  }
}

function previewCustomAudio(slot) {
  if (!customAudio[slot]) { toast('No ' + slot + ' audio loaded'); return; }
  playCustomAudio(slot);
}

function playCustomAudio(slot) {
  if (!customAudio[slot]?.url) return false;
  getAudioCtx();
  new Audio(customAudio[slot].url).play().catch(() => {});
  return true;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function restoreAudioSlots(audioSlots) {
  if (!audioSlots) return;
  for (const [slot, info] of Object.entries(audioSlots)) {
    if (info?.url) { setAudioSlot(slot, info.url, info.name); }
  }
}

// ─── LANDING ──────────────────────────────────────────────────────
// Fetch config (TV codes + branding) on load — only when room is known
if (roomId) {
  partyFetch('/api/config').then(r => r.json()).then(cfg => {
    tvCodes  = cfg.tvCodes;
    branding = { ...branding, ...cfg.branding };
    applyBranding();
    restoreAudioSlots(cfg.audioSlots);
  }).catch(()=>{});
}

// ─── PROFILE SYSTEM ───────────────────────────────────────────────
let profiles = [];
let _pendingProfile = null;

function promptControllerPassword() {
  if (_currentUser?.app_metadata?.role === 'admin') {
    myCtrlName = _currentUser.email || 'Admin';
    startController();
    return;
  }
  openProfilePicker();
}

function loadProfiles() {
  if (!roomId) { profiles = []; return Promise.resolve(); }
  return partyFetch('/api/profiles')
    .then(r => r.json())
    .then(data => { profiles = Array.isArray(data) ? data : []; })
    .catch(() => { profiles = profiles || []; });
}

function openProfilePicker() {
  loadProfiles().then(() => {
    renderProfileGrid();
    const modal = document.getElementById('profilePickerModal');
    if (modal) modal.style.display = 'flex';
  });
}

function closeProfilePicker(e) {
  if (e && e.target !== document.getElementById('profilePickerModal')) return;
  document.getElementById('profilePickerModal').style.display = 'none';
}

function renderProfileGrid() {
  const grid = document.getElementById('profileGrid');
  if (!grid) return;
  if (!profiles.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;font-family:var(--font-ui);font-size:.85rem;color:var(--mat-muted);padding:1rem">No profiles yet — create one below</div>';
    return;
  }
  grid.innerHTML = profiles.map(p => `
    <div class="profile-card" onclick="selectProfile('${p.id}')" style="border-color:${p.color}44">
      <div class="profile-color-bar" style="background:${p.color}"></div>
      <button class="profile-delete" onclick="event.stopPropagation();deleteProfile('${p.id}')" title="Delete">✕</button>
      <div class="profile-name">${escHtml(p.name)}</div>
      <div class="profile-meta">${p.hasPin ? '🔒 PIN protected' : 'No PIN'}</div>
    </div>
  `).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function selectProfile(id) {
  const profile = profiles.find(p => p.id === id);
  if (!profile) return;
  _pendingProfile = profile;
  document.getElementById('profilePickerModal').style.display = 'none';
  if (profile.hasPin) { openPinModal(profile); } else { loginWithProfile(profile); }
}

async function deleteProfile(id) {
  const profile = profiles.find(p => p.id === id);
  if (!profile || !confirm('Delete profile "' + profile.name + '"?')) return;
  await partyFetch('/api/profiles/' + id, { method: 'DELETE' });
  await loadProfiles();
  renderProfileGrid();
}

function openCreateProfile() {
  document.getElementById('profilePickerModal').style.display = 'none';
  document.getElementById('newProfileName').value = '';
  document.getElementById('newProfilePin').value  = '';
  document.getElementById('createProfileModal').style.display = 'flex';
  setTimeout(() => document.getElementById('newProfileName').focus(), 80);
}

function closeCreateProfile(e) {
  if (e && e.target !== document.getElementById('createProfileModal')) return;
  document.getElementById('createProfileModal').style.display = 'none';
  openProfilePicker();
}

async function submitCreateProfile() {
  const name = document.getElementById('newProfileName').value.trim();
  const pin  = document.getElementById('newProfilePin').value;
  if (!name) { document.getElementById('newProfileName').focus(); return; }
  document.getElementById('createProfileModal').style.display = 'none';
  const res  = await partyFetch('/api/profiles', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, pin }),
  });
  const data = await res.json();
  if (data.ok) {
    await loadProfiles();
    const profile = profiles.find(p => p.id === data.id) || { id: data.id, name, color: data.color, hasPin: !!pin, settings: {} };
    loginWithProfile(profile);
  }
}

function openPinModal(profile) {
  const dot = document.getElementById('pinProfileDot');
  const title = document.getElementById('pinProfileTitle');
  const input = document.getElementById('pinInput');
  const err   = document.getElementById('pinError');
  if (dot)   dot.style.background = profile.color || '#D4A017';
  if (title) title.textContent    = profile.name;
  if (input) input.value = '';
  if (err)   err.style.display   = 'none';
  document.getElementById('pinModal').style.display = 'flex';
  setTimeout(() => input && input.focus(), 80);
}

function closePinModal(e) {
  if (e && e.target !== document.getElementById('pinModal')) return;
  document.getElementById('pinModal').style.display = 'none';
  openProfilePicker();
}

async function submitPin() {
  const input = document.getElementById('pinInput');
  const err   = document.getElementById('pinError');
  const pin   = input ? input.value : '';
  if (!_pendingProfile) return;
  const res = await partyFetch('/api/profiles/' + _pendingProfile.id + '/login', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ pin }),
  });
  if (res.ok) {
    const data = await res.json();
    document.getElementById('pinModal').style.display = 'none';
    loginWithProfile(data.profile);
  } else {
    if (err) err.style.display = 'block';
    if (input) { input.value=''; input.focus(); input.style.borderColor='var(--mat-red)'; setTimeout(()=>{input.style.borderColor='var(--mat-border)';},1000); }
  }
}

function loginWithProfile(profile) {
  myCtrlName  = profile.name;
  _pendingProfile = profile;
  if (profile.settings) {
    const s = profile.settings;
    if (s.roundDuration  !== undefined) { state.roundDuration = s.roundDuration; state.timeRemaining = s.roundDuration; }
    if (s.restDuration   !== undefined) state.restDuration   = s.restDuration;
    if (s.totalRounds    !== undefined) state.totalRounds    = s.totalRounds;
    if (s.warningEnabled !== undefined) state.warningEnabled = s.warningEnabled;
    if (s.warningThreshold !== undefined) state.warningThreshold = s.warningThreshold;
    if (s.showRound      !== undefined) state.showRound      = s.showRound;
  }
  startController();
}

function closePasswordModal() {
  ['profilePickerModal','createProfileModal','pinModal'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
}
function submitPassword() { submitPin(); }

// ─── SESSION NAME ─────────────────────────────────────────────────
function openSessionModal() {
  const input = document.getElementById('sessionNameInput');
  if (input) { input.value = myCtrlName || ''; }
  document.getElementById('sessionModal').style.display = 'flex';
  setTimeout(() => input && input.focus(), 80);
}

function closeSessionModal(e) {
  if (e && e.target !== document.getElementById('sessionModal')) return;
  document.getElementById('sessionModal').style.display = 'none';
}

function submitSessionName(fallback) {
  const input = document.getElementById('sessionNameInput');
  const name  = (input ? input.value.trim() : '') || fallback || 'Unnamed Class';
  myCtrlName  = name;
  document.getElementById('sessionModal').style.display = 'none';
  startController();
}

function openRenameSession() {
  const input = document.getElementById('sessionNameInput');
  if (input) input.value = myCtrlName || '';
  document.getElementById('sessionModal').style.display = 'flex';
  setTimeout(() => input && input.focus(), 80);
  // Override submit to just rename without re-joining
  const submitBtn = document.querySelector('#sessionModal .btn-gold');
  if (submitBtn) {
    submitBtn._origOnclick = submitBtn.onclick;
    submitBtn.onclick = () => {
      const inp = document.getElementById('sessionNameInput');
      const newName = (inp ? inp.value.trim() : '') || myCtrlName || 'Unnamed Class';
      myCtrlName = newName;
      document.getElementById('sessionModal').style.display = 'none';
      emit('ctrl:rename', { name: newName });
      applyControllerColor();
    };
  }
}

function startController() {
  mode = 'controller';
  openSocket('controller', {
    name:      encodeURIComponent(myCtrlName || 'Unnamed Class'),
    color:     _pendingProfile?.color || '',
    profileId: _pendingProfile?.id    || '',
  });
  document.getElementById('landing').style.display    = 'none';
  document.getElementById('controller').style.display = 'block';
  updateUI();
}

// ─── LANDING: tap TV card to connect this device as that display ──
function connectAsDisplay(num) {
  const code = tvCodes[num - 1];
  if (!code) {
    showConnecting('Connecting…');
    const waitForCodes = setInterval(() => {
      const c = tvCodes[num - 1];
      if (c) { clearInterval(waitForCodes); hideConnecting(); connectAsDisplay(num); }
    }, 200);
    setTimeout(() => { clearInterval(waitForCodes); hideConnecting(); toast('Could not connect — is the room code loaded?'); }, 5000);
    return;
  }
  _displayTvCode = code;
  mode = 'display';
  showConnecting('Connecting as TV ' + num + '…');
  openSocket('tv', { code });
  // showDisplay is called from _onOpen once connected
}

// ─── PARTYKIT EVENT HANDLERS ──────────────────────────────────────
function _onOpen() {
  hideReconnectOverlay();
  // TV bookmark: ?room=X&tv=CODE — auto-join as display
  const tvCode = _urlParams.get('tv');
  if (tvCode && mode !== 'controller') {
    _displayTvCode = tvCode.toUpperCase();
    mode = 'display';
    // socket was opened with role=tv&code=... already — just show display
    _showDisplayView();
    return;
  }
  if (mode === 'display') _showDisplayView();
}

function _showDisplayView() {
  document.getElementById('landing').style.display = 'none';
  const d = document.getElementById('display');
  d.style.display = 'flex';
  d.style.flexDirection = 'column';
  generateDisplayQr();
  requestLastKnownState();
  setDisplayStatus('connected', 'Live');
  hideConnecting();
}

function _onClose() {
  if (mode !== 'display') return;
  showReconnectOverlay('Reconnecting…');
  setDisplayStatus('connecting', 'Reconnecting...');
  requestLastKnownState();
}

let dispSwRaf = null;

function _onMessage(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch(e) { return; }

  switch (msg.type) {

    case 'config': {
      tvCodes  = msg.tvCodes;
      branding = { ...branding, ...msg.branding };
      if (msg.ctrlSlot)  myCtrlSlot  = msg.ctrlSlot;
      if (msg.ctrlColor) myCtrlColor = msg.ctrlColor;
      applyBranding();
      applyControllerColor();
      break;
    }

    case 'monitor:status': {
      if (mode !== 'controller') break;
      const { tvOwner, tvDisplays, floating, ctrlSlots, ctrlNames } = msg;
      for (let i = 1; i <= 4; i++) {
        const dispCount  = tvDisplays?.[i] || 0;
        const ownerSlot  = tvOwner?.[i] || null;
        const ownerColor = ownerSlot ? CTRL_COLOR_HEX[['','blue','green','amber','pink'][ownerSlot]] : null;
        const ownerName  = ownerSlot ? (ctrlNames?.[ownerSlot] || 'Unnamed Class') : null;
        const isMine     = ownerSlot === myCtrlSlot;
        const panel      = document.getElementById('monitor-' + i);
        const statusEl   = document.getElementById('monitor-status-' + i);
        const claimBtn   = document.getElementById('monitor-claim-' + i);
        panel?.classList.remove('active','owned','foreign');
        if (dispCount > 0 || ownerSlot) panel?.classList.add('active');
        if (panel) {
          if (ownerColor) {
            panel.style.background = ownerColor + '12';
            panel.style.borderColor = ownerColor + '55';
            panel.style.borderLeftColor = ownerColor;
          } else {
            panel.style.background = '';
            panel.style.borderColor = '';
            panel.style.borderLeftColor = 'var(--mat-border)';
          }
        }
        if (statusEl) {
          if (ownerSlot && dispCount > 0)      statusEl.textContent = (isMine ? 'My class' : ownerName) + (dispCount > 1 ? ' · ' + dispCount + ' screens' : '');
          else if (ownerSlot)                  statusEl.textContent = (isMine ? 'My class' : ownerName) + ' · no screen';
          else if (dispCount > 0)              statusEl.textContent = dispCount + ' screen' + (dispCount > 1 ? 's' : '') + ' · unclaimed';
          else                                 statusEl.textContent = 'Available';
        }
        const dotEl = document.getElementById('monitor-dot-' + i);
        if (dotEl) { dotEl.style.background = ownerColor || (dispCount > 0 ? '#555' : ''); dotEl.style.boxShadow = ownerColor ? `0 0 6px ${ownerColor}` : ''; }
        if (claimBtn) {
          if (isMine) {
            claimBtn.textContent = '✕ Release'; claimBtn.style.color = CTRL_COLOR_HEX[myCtrlColor] || ''; claimBtn.style.borderColor = (CTRL_COLOR_HEX[myCtrlColor] || '') + '88'; claimBtn.onclick = () => releaseTv(i);
          } else if (!ownerSlot) {
            claimBtn.textContent = '+ Claim'; claimBtn.style.color = ''; claimBtn.style.borderColor = ''; claimBtn.onclick = () => claimTv(i);
          } else {
            claimBtn.textContent = 'In use'; claimBtn.style.color = '#555'; claimBtn.style.borderColor = ''; claimBtn.onclick = null;
          }
        }
        const landingStatus = document.getElementById('landing-tv-status-' + i);
        const landingCard   = document.getElementById('landing-tv-' + i);
        const landingHint   = document.getElementById('landing-tv-hint-' + i);
        if (dispCount > 0) {
          landingCard?.classList.add('connected','tv-taken');
          if (landingHint) landingHint.textContent = '● In use';
          if (landingStatus) { landingStatus.style.background = ownerColor || getSlotColor(i); landingStatus.style.boxShadow = `0 0 8px ${ownerColor || getSlotColor(i)}`; }
        } else {
          landingCard?.classList.remove('connected','tv-taken');
          if (landingHint) landingHint.textContent = 'tap to connect';
          if (landingStatus) { landingStatus.style.background = ''; landingStatus.style.boxShadow = ''; }
        }
      }
      const floatPanel = document.getElementById('monitor-floating');
      const floatCount = document.getElementById('monitor-floating-count');
      const floatDot   = document.getElementById('monitor-floating-dot');
      if (floating > 0) {
        floatPanel?.classList.add('active');
        if (floatCount) floatCount.textContent = floating + ' connected';
        if (floatDot) { floatDot.style.background = 'var(--tv-float)'; floatDot.style.boxShadow = '0 0 6px var(--tv-float)'; }
      } else {
        floatPanel?.classList.remove('active');
        if (floatCount) floatCount.textContent = '0 connected';
        if (floatDot) { floatDot.style.background = ''; floatDot.style.boxShadow = ''; }
      }
      break;
    }

    case 'state':   { if (mode === 'display') { const { type: _, ...s } = msg; applyStateSnapshot(s); } break; }
    case 'overlay': { if (mode === 'display') showOverlay(msg.msg); break; }
    case 'branding': { branding = { ...branding, ...msg }; applyBranding(); break; }
    case 'tvCodes': {
      if (msg.tvCodes) {
        tvCodes = msg.tvCodes;
        for (let i = 1; i <= 4; i++) {
          const el = document.getElementById('landing-tv-code-' + i);
          if (el) el.textContent = tvCodes[i - 1];
        }
      }
      break;
    }
    case 'profiles:updated': { profiles = msg.profiles || msg; break; }

    case 'audio:clear': {
      customAudio[msg.slot] = null;
      const nameEl = document.getElementById('audio' + cap(msg.slot) + 'Name');
      if (nameEl) { nameEl.textContent = 'Choose file'; nameEl.closest('.audio-file-btn')?.classList.remove('loaded'); }
      break;
    }

    case 'ctrl:color': {
      if (mode === 'display') applyDisplayCtrlColor(msg.color, msg.name);
      break;
    }

    case 'tab': {
      if (mode !== 'display') break;
      const timer = document.getElementById('displayPanelTimer');
      const sw    = document.getElementById('displayPanelStopwatch');
      if (msg.tab === 'stopwatch') { if (timer) timer.style.display = 'none'; if (sw) sw.style.display = 'flex'; }
      else                         { if (timer) timer.style.display = 'block'; if (sw) sw.style.display = 'none'; }
      break;
    }

    case 'sw:state': {
      if (mode !== 'display') break;
      cancelAnimationFrame(dispSwRaf);
      const latency = Date.now() - msg.ts;
      let dispElapsed = msg.elapsed + (msg.running ? latency : 0);
      const swEl = document.getElementById('displaySwTime');
      function dispSwTick() {
        if (msg.running) dispElapsed += 16;
        if (swEl) swEl.innerHTML = (() => {
          const mins = Math.floor(dispElapsed/60000), secs = Math.floor((dispElapsed%60000)/1000), cs = Math.floor((dispElapsed%1000)/10);
          return `${mins}:${String(secs).padStart(2,'0')}<span style="font-size:.4em;opacity:.55">.${String(cs).padStart(2,'0')}</span>`;
        })();
        if (msg.running) dispSwRaf = requestAnimationFrame(dispSwTick);
      }
      dispSwTick();
      break;
    }

    case 'sound': {
      if (mode !== 'display') break;
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const theme = SOUND_THEMES[msg.theme] || SOUND_THEMES.classic;
        const play = () => {
          switch (msg.soundType) {
            case 'beep':   theme.countdownBeep(); break;
            case 'accent': theme.accentBeep(); break;
            case 'buzzer': if (!playCustomAudio('stop'))  theme.buzzerSound(); break;
            case 'start':  if (!playCustomAudio('start')) theme.startSound(); break;
            case 'rest':   if (!playCustomAudio('rest'))  theme.restSound(); break;
          }
        };
        if (audioCtx.state === 'suspended') audioCtx.resume().then(play).catch(()=>{});
        else play();
      } catch(e) {}
      break;
    }

    case 'error': { hideConnecting(); toast('Error: ' + msg.msg); break; }
    case 'tv:taken': {
      mode = null; _displayTvCode = null;
      document.getElementById('display').style.display = 'none';
      document.getElementById('landing').style.display = 'flex';
      toast('⚠ TV ' + msg.slot + ' is already in use — choose a different screen');
      break;
    }
  }
}

// ─── RECONNECT OVERLAY ────────────────────────────────────────────
function showReconnectOverlay(text) {
  const el = document.getElementById('displayReconnect');
  const textEl = document.getElementById('reconnectText');
  if (el) el.style.display = 'flex';
  if (textEl) textEl.textContent = text;
}
function hideReconnectOverlay() {
  const el = document.getElementById('displayReconnect');
  if (el) el.style.display = 'none';
}

// Auto-connect as TV display if ?room=X&tv=CODE is in the URL
(function checkTvBookmark() {
  const tvCode = _urlParams.get('tv');
  if (tvCode && roomId) {
    _displayTvCode = tvCode.toUpperCase();
    mode = 'display';
    openSocket('tv', { code: _displayTvCode });
  }
})();

// ─── TV CLAIM / RELEASE ───────────────────────────────────────────
function claimTv(tvSlot) {
  emit('tv:claim', { tvSlot });
  myTvClaims.add(tvSlot);
}
function releaseTv(tvSlot) {
  emit('tv:release', { tvSlot });
  myTvClaims.delete(tvSlot);
}

// ─── CONTROLLER COLOR IDENTITY ────────────────────────────────────
function applyControllerColor() {
  if (!myCtrlColor) return;
  const hex  = CTRL_COLOR_HEX[myCtrlColor] || '#D4A017';
  const name = myCtrlName || 'Unnamed Class';
  const dot  = document.getElementById('ctrlDot');
  if (dot) { dot.style.background = hex; dot.style.boxShadow = `0 0 6px ${hex}`; }
  const statusText = document.getElementById('ctrlStatusText');
  if (statusText) statusText.textContent = name;
  const ctrlEl = document.getElementById('controller');
  if (ctrlEl) ctrlEl.style.setProperty('--my-ctrl-color', hex);
}

// ─── DISPLAY: show which controller owns it ───────────────────────
function applyDisplayCtrlColor(color, name) {
  const hex    = color ? CTRL_COLOR_HEX[color] : null;
  const inner  = document.getElementById('displayInner');
  const textEl = document.getElementById('displayStatusText');
  const dot    = document.getElementById('displayDot');
  if (inner) inner.style.borderTop = hex ? `3px solid ${hex}` : '';
  if (textEl) {
    textEl.textContent = name || '';
    textEl.style.color = hex || '';
  }
  if (dot && hex) { dot.style.background = hex; dot.style.boxShadow = `0 0 5px ${hex}`; }
}

function getSlotColor(slot) {
  return ['','#3B82F6','#10B981','#F59E0B','#EC4899'][slot] || '#888';
}

// Display audio is now handled inside _onMessage (case 'sound')


// ─── TIMER LOGIC ──────────────────────────────────────────────────
function toggleStartPause() { state.running ? pauseTimer() : startTimer(); }

function startTimer() {
  state.running = true;
  getAudioCtx();
  const playedCustom = playCustomAudio('start');
  if (!playedCustom) beep(660, 0.12, 'sine', 0.5);
  emit('sound', { soundType: 'start' });
  if (!timerInterval) timerInterval = setInterval(tick, 1000);
  document.getElementById('startPauseBtn').textContent = '⏸ Pause';
  document.getElementById('startPauseBtn').className = 'btn btn-red btn-massive';
  broadcastState();
}

function pauseTimer() {
  state.running = false;
  clearInterval(timerInterval); timerInterval = null;
  document.getElementById('startPauseBtn').textContent = '▶ Resume';
  document.getElementById('startPauseBtn').className = 'btn btn-green btn-massive';
  broadcastState();
}

function tick() {
  if (!state.running) return;
  const prev = state.timeRemaining;
  state.timeRemaining--;
  handleTickSounds(prev, state.timeRemaining);
  if (state.timeRemaining <= 0) handlePhaseEnd();
  else { throttledBroadcast(); updateUI(); }
}

let _lastBroadcast = 0;
function throttledBroadcast() {
  const now = Date.now();
  if (now - _lastBroadcast > 900) { broadcastState(); _lastBroadcast = now; }
}
function broadcastState() { emit('state', { ...state }); }

function handleTickSounds(prev, newTime) {
  const beepOn = document.getElementById('soundBeepToggle')?.checked ?? true;
  if (state.phase !== 'fight') return;
  if (beepOn && newTime > 0 && newTime <= 10) {
    if (newTime <= 3) { SOUND_THEMES[soundTheme].accentBeep(); emit('sound', { soundType: 'accent', theme: soundTheme }); }
    else              { SOUND_THEMES[soundTheme].countdownBeep(); emit('sound', { soundType: 'beep', theme: soundTheme }); }
  }
}

function handlePhaseEnd() {
  const buzzerOn = document.getElementById('soundBuzzerToggle')?.checked ?? true;
  if (state.phase === 'fight') {
    const playedCustom = playCustomAudio('stop');
    if (!playedCustom && buzzerOn) SOUND_THEMES[soundTheme].buzzerSound();
    if (playedCustom || buzzerOn) emit('sound', { soundType: 'buzzer', theme: soundTheme });
  }
  if (state.phase === 'fight') {
    if (state.currentRound >= state.totalRounds) {
      state.running = false; state.timeRemaining = 0;
      clearInterval(timerInterval); timerInterval = null;
      document.getElementById('startPauseBtn').textContent = '▶ Start';
      document.getElementById('startPauseBtn').className = 'btn btn-green btn-massive';
      emit('overlay', { msg: 'TIME!' });
      broadcastState();
    } else if (state.restDuration > 0) {
      state.phase = 'rest'; state.timeRemaining = state.restDuration;
      const playedCustomRest = playCustomAudio('rest');
      if (!playedCustomRest) SOUND_THEMES[soundTheme].restSound();
      emit('sound', { soundType: 'rest', theme: soundTheme });
      emit('overlay', { msg: 'REST' });
    } else {
      const playedCustomStart = playCustomAudio('start');
      if (!playedCustomStart) SOUND_THEMES[soundTheme].startSound();
      emit('sound', { soundType: 'start', theme: soundTheme });
      nextRound();
    }
  } else {
    state.currentRound++; state.phase = 'fight'; state.timeRemaining = state.roundDuration;
    const playedCustomStart = playCustomAudio('start');
    if (!playedCustomStart) SOUND_THEMES[soundTheme].startSound();
    emit('sound', { soundType: 'start', theme: soundTheme });
    emit('overlay', { msg: 'FIGHT!' });
    setTimeout(() => emit('overlay', { msg: '' }), 2500);
  }
  updateUI(); broadcastState();
}

function resetTimer() {
  clearInterval(timerInterval); timerInterval = null;
  state.running = false; state.currentRound = 1; state.phase = 'fight';
  state.timeRemaining = state.roundDuration;
  document.getElementById('startPauseBtn').textContent = '▶ Start';
  document.getElementById('startPauseBtn').className = 'btn btn-green btn-massive';
  updateUI(); broadcastState(); emit('overlay', { msg: '' });
}

function nextRound() {
  if (state.currentRound < state.totalRounds) state.currentRound++;
  state.phase = 'fight'; state.timeRemaining = state.roundDuration; state.running = false;
  clearInterval(timerInterval); timerInterval = null;
  document.getElementById('startPauseBtn').textContent = '▶ Start';
  document.getElementById('startPauseBtn').className = 'btn btn-green btn-massive';
  updateUI(); broadcastState();
}

// ─── SETTINGS MODAL ───────────────────────────────────────────────
function openSettingsModal() {
  document.getElementById('settingsModal').style.display = 'flex';
  const sel = document.getElementById('soundThemeSelect');
  if (sel) sel.value = soundTheme;
}
function closeSettingsModal(e) {
  if (e && e.target !== document.getElementById('settingsModal')) return;
  document.getElementById('settingsModal').style.display = 'none';
}

// ─── DURATION (1–10 min pills) ────────────────────────────────────
function setDurationMin(min) {
  state.roundDuration = min * 60;
  if (!state.running) state.timeRemaining = state.roundDuration;
  document.querySelectorAll('.dur-pill').forEach((b, i) => {
    b.classList.toggle('active', i + 1 === min);
  });
  updateUI(); broadcastState();
  if (_pendingProfile?.id) {
    emit('profile:save', { profileId: _pendingProfile.id, settings: { roundDuration: state.roundDuration } });
  }
}

// Legacy stubs kept for any inline references (no-ops now)
function setPreset(min, sec) { setDurationMin(min); }
function setCustomTime() {}

function updateConfig() {
  state.totalRounds      = parseInt(document.getElementById('totalRoundsInput').value)||1;
  state.restDuration     = parseInt(document.getElementById('restTimeInput').value)||0;
  state.warningEnabled   = document.getElementById('warningToggle').checked;
  state.warningThreshold = parseInt(document.getElementById('warningThreshold').value)||30;
  state.showRound        = document.getElementById('showRoundToggle').checked;
  updateUI(); broadcastState();
  // Auto-save settings back to profile
  if (_pendingProfile?.id) {
    emit('profile:save', {
      profileId: _pendingProfile.id,
      settings: {
        roundDuration:    state.roundDuration,
        restDuration:     state.restDuration,
        totalRounds:      state.totalRounds,
        warningEnabled:   state.warningEnabled,
        warningThreshold: state.warningThreshold,
        showRound:        state.showRound,
      },
    });
  }
}

// ─── MESSAGES ─────────────────────────────────────────────────────
function sendMsg() { const m = document.getElementById('msgInput').value.trim(); emit('overlay', { msg: m }); }
function sendQuickMsg(m) { document.getElementById('msgInput').value = m; emit('overlay', { msg: m }); }

// ─── UI UPDATE ────────────────────────────────────────────────────
function formatTime(s) { return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0'); }
function getTimerClass() {
  if (state.phase === 'fight' && state.warningEnabled) {
    if (state.timeRemaining <= 10) return 'danger';
    if (state.timeRemaining <= state.warningThreshold) return 'warning';
  }
  return '';
}
function updateUI() {
  if (mode !== 'controller') return;
  const timeStr = formatTime(state.timeRemaining), cls = getTimerClass();
  const ctrlTimer = document.getElementById('ctrlTimer');
  ctrlTimer.textContent = timeStr; ctrlTimer.className = 'ctrl-timer-display ' + cls;
  document.getElementById('ctrlRoundLabel').textContent = state.phase === 'rest' ? 'Rest' : `Round ${state.currentRound} of ${state.totalRounds}`;
  const pl = document.getElementById('ctrlPhaseLabel');
  pl.textContent = state.phase === 'fight' ? 'Fight' : 'Rest';
  pl.className = 'phase-label ' + state.phase;
}

function applyStateSnapshot(s) {
  Object.assign(state, s);
  const timeStr = formatTime(state.timeRemaining), cls = getTimerClass();
  document.getElementById('displayTime').textContent = timeStr;
  document.getElementById('displayTime').className = 'display-time ' + cls;
  const roundEl = document.getElementById('displayRound');
  if (roundEl) {
    roundEl.textContent = state.phase === 'rest' ? 'REST' : `Round ${state.currentRound} of ${state.totalRounds}`;
    roundEl.style.display = state.showRound ? '' : 'none';
  }
  const dPhase = document.getElementById('displayPhase');
  dPhase.textContent = state.phase === 'fight' ? 'FIGHT' : 'REST';
  dPhase.className = 'display-phase ' + state.phase;
  document.getElementById('displayInner').classList.toggle('phase-rest', state.phase === 'rest');

  // Persist last known state to service worker so display survives server restart
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SAVE_STATE', state: { ...state } });
  }
}

function showOverlay(msg) {
  const overlay = document.getElementById('displayOverlay');
  document.getElementById('overlayMsg').textContent = msg;
  if (msg) {
    overlay.classList.add('visible');
    if (msg !== 'STOP') setTimeout(() => overlay.classList.remove('visible'), 3000);
  } else { overlay.classList.remove('visible'); }
}

// ─── STATUS ───────────────────────────────────────────────────────
function setDisplayStatus(status, text) {
  const dot = document.getElementById('displayDot');
  if (dot) dot.className = 'status-dot ' + status;
  // status text is now shown in displayStatusText span (hidden by default, fine to update)
  const textEl = document.getElementById('displayStatusText');
  if (textEl) textEl.textContent = '';
}

// ─── TABS ─────────────────────────────────────────────────────────
let activeTab = 'timer';
function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tabTimer').classList.toggle('active', tab === 'timer');
  document.getElementById('tabStopwatch').classList.toggle('active', tab === 'stopwatch');
  document.getElementById('panelTimer').classList.toggle('hidden', tab !== 'timer');
  document.getElementById('panelStopwatch').classList.toggle('hidden', tab !== 'stopwatch');
  emit('tab', { tab });
}

// ─── STOPWATCH ────────────────────────────────────────────────────
let swRunning = false, swElapsed = 0, swStartTime = null, swRafId = null;
let swBroadcastTimer = null;

function swFormatDisplay(ms) {
  const mins = Math.floor(ms/60000);
  const secs = Math.floor((ms%60000)/1000);
  const cs   = Math.floor((ms%1000)/10);
  return `${mins}:${String(secs).padStart(2,'0')}<span style="font-size:.4em;opacity:.55">.${String(cs).padStart(2,'0')}</span>`;
}

function swBroadcast() {
  emit('sw:state', { elapsed: swElapsed, running: swRunning, ts: Date.now() });
}

function swTick() {
  if (!swRunning) return;
  swElapsed += Date.now() - swStartTime; swStartTime = Date.now();
  document.getElementById('swDisplay').innerHTML = swFormatDisplay(swElapsed);
  swRafId = requestAnimationFrame(swTick);
}

function swToggle() {
  if (swRunning) {
    swRunning = false; cancelAnimationFrame(swRafId);
    clearInterval(swBroadcastTimer);
    document.getElementById('swStartPauseBtn').textContent = '▶ Resume';
    document.getElementById('swStartPauseBtn').className = 'btn btn-green btn-massive';
  } else {
    swRunning = true; swStartTime = Date.now(); getAudioCtx();
    document.getElementById('swStartPauseBtn').textContent = '⏸ Pause';
    document.getElementById('swStartPauseBtn').className = 'btn btn-red btn-massive';
    swRafId = requestAnimationFrame(swTick);
    // Broadcast every second so displays stay in sync
    swBroadcastTimer = setInterval(swBroadcast, 1000);
  }
  swBroadcast();
}

function swReset() {
  swRunning = false; cancelAnimationFrame(swRafId);
  clearInterval(swBroadcastTimer);
  swElapsed = 0; swStartTime = null;
  document.getElementById('swDisplay').innerHTML = swFormatDisplay(0);
  document.getElementById('swStartPauseBtn').textContent = '▶ Start';
  document.getElementById('swStartPauseBtn').className = 'btn btn-green btn-massive';
  swBroadcast();
}

// ─── BRANDING ─────────────────────────────────────────────────────
function applyBranding() {
  const name   = branding.appName || 'BJJ Mat Timer';
  const tagline = branding.tagline || 'Competition · Training · Sparring';
  const logo   = branding.logoDataUrl || '';
  document.title = name;

  // Landing
  const titleEl = document.getElementById('landingTitle');    if (titleEl) titleEl.textContent = name;
  const tagEl   = document.getElementById('landingTagline');  if (tagEl)   tagEl.textContent = tagline;
  // Display corner
  const cornerEl = document.getElementById('displayCornerName'); if (cornerEl) cornerEl.textContent = name;

  // Logo — landing
  const svgEl = document.getElementById('landingLogoSvg'), imgEl = document.getElementById('landingLogoImg');
  if (logo) { if (svgEl) svgEl.style.display='none'; if (imgEl){imgEl.src=logo;imgEl.style.display='block';} }
  else       { if (svgEl) svgEl.style.display='block'; if (imgEl) imgEl.style.display='none'; }
}
function openBrandingModal() {
  document.getElementById('bName').value     = branding.appName || '';
  document.getElementById('bTagline').value  = branding.tagline || '';
  const logo = branding.logoDataUrl || '';
  const img = document.getElementById('logoPreviewImg'), def = document.getElementById('logoPreviewDefault');
  const bImg = document.getElementById('bPreviewImg'), bSvg = document.getElementById('bPreviewDefaultSvg');
  if (logo) {
    img.src=logo; img.style.display='block'; def.style.display='none';
    bImg.src=logo; bImg.style.display='block'; bSvg.style.display='none';
    document.getElementById('logoUploadName').textContent='Logo loaded';
    document.getElementById('logoUpload').closest('.audio-file-btn').classList.add('loaded');
  } else {
    img.style.display='none'; def.style.display='';
    bImg.style.display='none'; bSvg.style.display='block';
    document.getElementById('logoUploadName').textContent='Choose image file';
    document.getElementById('logoUpload').closest('.audio-file-btn').classList.remove('loaded');
  }
  updateBrandPreview();

  // TV codes section (owners only)
  const tvSection = document.getElementById('tvCodesSection');
  const tvList = document.getElementById('tvCodesList');
  if (_gymRole === 'owner' && tvCodes && tvSection && tvList) {
    tvSection.style.display = '';
    tvList.innerHTML = tvCodes.map((code, i) => `
      <div style="background:var(--mat-dark);border:1px solid var(--mat-border);border-radius:4px;padding:.5rem .75rem;display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-family:var(--font-ui);font-size:.7rem;color:var(--mat-muted);letter-spacing:.15em;text-transform:uppercase">TV ${i + 1}</div>
          <div id="tvCode-${i + 1}" style="font-family:var(--font-display);font-size:1.1rem;letter-spacing:.2em;color:var(--mat-gold)">${code}</div>
        </div>
        <button id="regenBtn-${i + 1}" class="btn btn-outline" style="font-size:.72rem;padding:.3rem .6rem" onclick="regenerateTvCode(${i + 1})">Regen</button>
      </div>
    `).join('');
  }

  // Rooms section (owners only)
  const roomsSection = document.getElementById('roomsSection');
  if (_gymRole === 'owner' && roomsSection) {
    roomsSection.style.display = '';
    loadRoomsList();
  }

  document.getElementById('brandingModal').style.display='flex';
}
function closeBrandingModal(e) {
  if (e && e.target !== document.getElementById('brandingModal')) return;
  document.getElementById('brandingModal').style.display='none';
}
function handleLogoUpload(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const d = e.target.result;
    document.getElementById('logoPreviewImg').src=d; document.getElementById('logoPreviewImg').style.display='block';
    document.getElementById('logoPreviewDefault').style.display='none';
    document.getElementById('bPreviewImg').src=d; document.getElementById('bPreviewImg').style.display='block';
    document.getElementById('bPreviewDefaultSvg').style.display='none';
    input._pendingDataUrl=d;
    document.getElementById('logoUploadName').textContent=file.name;
    input.closest('.audio-file-btn').classList.add('loaded');
  };
  reader.readAsDataURL(file);
}
function clearLogo() {
  branding.logoDataUrl='';
  document.getElementById('logoPreviewImg').style.display='none'; document.getElementById('logoPreviewDefault').style.display='';
  document.getElementById('bPreviewImg').style.display='none'; document.getElementById('bPreviewDefaultSvg').style.display='block';
  document.getElementById('logoUploadName').textContent='Choose image file';
  document.getElementById('logoUpload').closest('.audio-file-btn').classList.remove('loaded');
  document.getElementById('logoUpload').value=''; document.getElementById('logoUpload')._pendingDataUrl=null;
  updateBrandPreview();
}
function updateBrandPreview() {
  document.getElementById('bPreviewName').textContent = document.getElementById('bName').value || 'BJJ Mat Timer';
  document.getElementById('bPreviewTagline').textContent = document.getElementById('bTagline').value || 'Competition · Training · Sparring';
}
document.addEventListener('DOMContentLoaded', () => {
  ['bName','bTagline'].forEach(id => { const el=document.getElementById(id); if(el) el.addEventListener('input',updateBrandPreview); });
});
async function saveBranding() {
  const logoInput = document.getElementById('logoUpload');
  branding.appName   = document.getElementById('bName').value.trim() || 'BJJ Mat Timer';
  branding.tagline   = document.getElementById('bTagline').value.trim() || 'Competition · Training · Sparring';
  if (logoInput._pendingDataUrl) branding.logoDataUrl = logoInput._pendingDataUrl;
  if (roomId) await partyFetch('/api/branding', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ...branding }) });
  applyBranding();
  document.getElementById('brandingModal').style.display='none';
  toast('✓ Settings saved');
}

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (mode !== 'controller') return;
  if (e.target.tagName === 'INPUT') return;
  if (activeTab === 'timer') {
    if (e.code==='Space') { e.preventDefault(); toggleStartPause(); }
    if (e.code==='KeyR') resetTimer();
    if (e.code==='KeyN') nextRound();
  } else {
    if (e.code==='Space') { e.preventDefault(); swToggle(); }
    if (e.code==='KeyR') swReset();
  }
});

// ─── QR CODE (display screen bottom-right) ───────────────────────
let _qrGenerated = false;

function generateDisplayQr() {
  if (_qrGenerated) return;
  const container = document.getElementById('displayQrCode');
  const label     = document.getElementById('displayQrLabel');
  if (!container) return;
  // QR shows the room URL so phones can scan and join the same room
  const url = roomId
    ? `${location.origin}${location.pathname}?room=${roomId}`
    : location.origin;
  renderQr(container, label, url, url.replace(/^https?:\/\//, ''), '');
}

function renderQr(container, label, url, ipDisplay, localName) {
  try {
    container.innerHTML = '';
    new QRCode(container, {
      text:         url,
      width:        110,
      height:       110,
      colorDark:    '#000000',
      colorLight:   '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
    if (label) label.style.display = 'none';
    _qrGenerated = true;
  } catch(e) {
    setTimeout(generateDisplayQr, 500);
  }
}

// ─── DISPLAY CLOCK ────────────────────────────────────────────────
function updateDisplayClock() {
  const now = new Date();
  let h = now.getHours();
  const min = String(now.getMinutes()).padStart(2,'0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  const timeEl = document.getElementById('displayTime2');
  if (timeEl) timeEl.textContent = `${h}:${min} ${ampm}`;
}
updateDisplayClock();
setInterval(updateDisplayClock, 1000);

// ─── HELPERS ──────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el=document.getElementById('toast'); el.textContent=msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),3000);
}
let connectingEl=null;
function showConnecting(msg) {
  if (connectingEl) return;
  connectingEl=document.createElement('div'); connectingEl.className='connecting-overlay';
  connectingEl.innerHTML=`<div class="spinner"></div><span style="color:var(--mat-muted);font-size:.9rem;letter-spacing:.2em">${msg}</span>`;
  document.body.appendChild(connectingEl);
}
function hideConnecting() { if (connectingEl) { connectingEl.remove(); connectingEl=null; } }

// ─── PWA Service Worker ───────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});

  // Listen for messages from SW (last known state response)
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'LAST_STATE' && e.data.state && mode === 'display') {
      // Apply cached state so display isn't blank while reconnecting
      applyStateSnapshot(e.data.state);
    }
  });
}

// When display connects, ask SW for last known state immediately
// (handles page reload while server is offline)
function requestLastKnownState() {
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'GET_STATE' });
  }
}

// ─── TV URL helper (updated for room-based URLs) ──────────────────
function copyTvLink(num) {
  const code = tvCodes[num - 1]; if (!code) return;
  const url = `${location.origin}${location.pathname}?room=${roomId}&tv=${code}`;
  navigator.clipboard.writeText(url).then(() => toast(`TV ${num} link copied!`)).catch(() => prompt('TV ' + num + ' link:', url));
}
