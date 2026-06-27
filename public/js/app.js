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

// ─── DEVICE PAIRING ───────────────────────────────────────────────
// A phone that redeemed a pairing code (scanned off the gym's display QR)
// has no Supabase account — it authenticates with a long-lived device
// token stored here instead. See api/pairing-redeem.js / api/device-token.js.
const DEVICE_STORAGE_KEY = 'mattimer_device';
// Coach/kiosk login (gym username+password): a long-lived kiosk-auth token stored
// here lets a shared gym device re-mint room tokens without re-entering the
// password. See api/coach-auth.js (action: login/refresh).
const KIOSK_STORAGE_KEY = 'mattimer_kiosk';

function _loadDeviceRecord() {
  try {
    const raw = localStorage.getItem(DEVICE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

function _saveDeviceRecord(rec) {
  try { localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(rec)); } catch(e) {}
}

function _loadKioskRecord() {
  try {
    const raw = localStorage.getItem(KIOSK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

function _saveKioskRecord(rec) {
  try { localStorage.setItem(KIOSK_STORAGE_KEY, JSON.stringify(rec)); } catch(e) {}
}

// Exchanges a stored long-lived token (device or kiosk) for a fresh room token;
// clears the stored record on rejection (revoked, coach login turned off, or
// subscription lapsed). Shared by the device-pairing and coach/kiosk paths.
async function _mintFromStoredToken(url, body, storageKey) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { localStorage.removeItem(storageKey); return null; }
    const { roomToken, roomTokenExp } = await res.json();
    _roomToken = roomToken; _roomTokenExp = roomTokenExp;
    return _roomToken;
  } catch(e) { return null; }
}

function _mintKioskRoomToken(kiosk) {
  return _mintFromStoredToken('/api/coach-auth', { action: 'refresh', roomId, kioskToken: kiosk.kioskToken }, KIOSK_STORAGE_KEY);
}

function _mintDeviceRoomToken(device) {
  return _mintFromStoredToken('/api/device-token', { roomId, deviceToken: device.deviceToken }, DEVICE_STORAGE_KEY);
}

async function _mintRoomToken() {
  _roomToken = null; _roomTokenExp = 0;
  if (!roomId || _isDemoRoom()) return null;
  const { data: { session } } = await _supabase.auth.getSession();
  if (session) {
    try {
      const res = await fetch('/api/room-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ roomId }),
      });
      if (res.ok) {
        const { token, exp } = await res.json();
        _roomToken = token; _roomTokenExp = exp;
      }
    } catch(e) {}
    return _roomToken;
  }

  // No Supabase session — fall back to a paired device's long-lived token.
  const device = _loadDeviceRecord();
  if (device?.deviceToken && device.roomCode === roomId) {
    return _mintDeviceRoomToken(device);
  }
  // …or a coach/kiosk login's long-lived token.
  const kiosk = _loadKioskRecord();
  if (kiosk?.kioskToken && kiosk.roomCode === roomId) {
    return _mintKioskRoomToken(kiosk);
  }
  return null;
}

// Redeems a one-time pairing code (`?pair=<code>`) for room access with no
// Supabase login on the phone, then drops straight into the existing
// profile-picker/PIN flow. Returns true if it fully handled page load.
async function _redeemPairingCode(code) {
  const url = new URL(location.href);
  url.searchParams.delete('pair');
  history.replaceState(null, '', url.toString());

  try {
    const res = await fetch('/api/pairing-redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById('loginView').style.display = 'flex';
      const err = document.getElementById('authError');
      if (err) {
        err.textContent = data.error || 'That pairing code is invalid or expired. Ask the gym to show a new one.';
        err.style.display = 'block';
      }
      return true;
    }
    _saveDeviceRecord({ deviceId: data.deviceId, deviceToken: data.deviceToken, roomCode: data.roomCode });
    roomId = data.roomCode;
    _roomToken = data.roomToken; _roomTokenExp = data.roomTokenExp;
    _gymRole = 'coach';
    await _finishRoomSetup();
    openMatPicker();
    return true;
  } catch(e) {
    return false;
  }
}

// Silently resumes a stored coach session (no Supabase login) for this room:
// mint a room token, then drop into the mat picker. Shared by device + kiosk.
async function _resumeStoredSession(record, mintFn) {
  if (!record || record.roomCode !== roomId) return false;
  const token = await mintFn(record);
  if (!token) return false;
  _gymRole = 'coach';
  await _finishRoomSetup();
  openMatPicker();
  return true;
}

// A previously-paired phone (stored device token for this room).
function _resumeDeviceSession() {
  const device = _loadDeviceRecord();
  if (!device?.deviceToken) return Promise.resolve(false);
  return _resumeStoredSession(device, _mintDeviceRoomToken);
}

// A coach/kiosk login (stored kiosk token) so a shared gym device stays signed in.
function _resumeKioskSession() {
  const kiosk = _loadKioskRecord();
  if (!kiosk?.kioskToken) return Promise.resolve(false);
  return _resumeStoredSession(kiosk, _mintKioskRoomToken);
}

// Coach signs in with the gym's shared username + password (no email account).
// Mirrors _redeemPairingCode: stores a kiosk token and drops into the mat picker.
async function gymLogin() {
  const username = (document.getElementById('coachUsername').value || '').trim().toLowerCase();
  const password = document.getElementById('coachPassword').value || '';
  const err = document.getElementById('coachAuthError');
  if (err) err.style.display = 'none';
  if (!username || !password) {
    if (err) { err.textContent = 'Enter your gym username and password.'; err.style.display = 'block'; }
    return;
  }
  try {
    const res = await fetch('/api/coach-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (err) { err.textContent = data.error || 'Invalid username or password.'; err.style.display = 'block'; }
      return;
    }
    _saveKioskRecord({ kioskToken: data.kioskToken, roomCode: data.roomCode });
    roomId = data.roomCode;
    // Put the room in the URL so a reload resumes via _resumeKioskSession.
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    history.replaceState(null, '', url.toString());
    _roomToken = data.roomToken; _roomTokenExp = data.roomTokenExp;
    _gymRole = 'coach';
    _gymName = data.gymName || _gymName;
    document.getElementById('coachLoginView').style.display = 'none';
    await _finishRoomSetup();
    openMatPicker();
  } catch(e) {
    if (err) { err.textContent = 'Network error. Please try again.'; err.style.display = 'block'; }
  }
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

// Account modal's primary action differs by who's using the device: a real
// Supabase owner signs out; a paired coach (no Supabase account) just ends
// their current profile session — the device stays paired to the gym.
function accountSignOutClick() {
  document.getElementById('accountModal').style.display = 'none';
  if (_currentUser) signOut(); else logoutCoach();
}

// A coach logs out, but the GYM stays signed in on the device (the kiosk token
// is kept, so it auto-resumes next visit). Release the mat and return to the
// coach (profile) picker for the next coach. The current mat selection is kept,
// so the next coach who picks their name + PIN runs the same mat; use the
// header "⇄ Switch" instead to pick a different mat.
function logoutCoach() {
  document.getElementById('accountModal').style.display = 'none';
  if ((state.running || swRunning) && !confirm('Log out and end the current session on this mat?')) return;
  if (socket) {
    try { emit('ctrl:release'); } catch(e) {}
    try { socket.close(); } catch(e) {}
  }
  mode = null;
  myCtrlName = null; _pendingProfile = null;
  document.getElementById('controller').style.display = 'none';
  document.getElementById('landing').style.display = 'flex';
  openProfilePicker();
}

function showLogin() {
  document.getElementById('marketingView').style.display = 'none';
  document.getElementById('signupView').style.display = 'none';
  document.getElementById('coachLoginView').style.display = 'none';
  document.getElementById('loginView').style.display = 'flex';
}

// Coach (gym username/password) sign-in view.
function showCoachLogin() {
  document.getElementById('marketingView').style.display = 'none';
  document.getElementById('signupView').style.display = 'none';
  document.getElementById('loginView').style.display = 'none';
  const err = document.getElementById('coachAuthError');
  if (err) err.style.display = 'none';
  document.getElementById('coachLoginView').style.display = 'flex';
  setTimeout(() => document.getElementById('coachUsername').focus(), 50);
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
  document.getElementById('coachLoginView').style.display = 'none';
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

  const hasUser = !!_currentUser;
  document.getElementById('accountChangePasswordSection').style.display = hasUser ? '' : 'none';
  // A coach "logs out" back to the coach picker (the gym stays signed in on the
  // device); an owner signs their account out entirely.
  document.getElementById('accountSignOutBtn').textContent = hasUser ? 'Sign Out' : 'Log out';

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

  // Coach Login (gym username/password) — owners only
  const kioskSection = document.getElementById('accountKioskSection');
  if (kioskSection) {
    if (_gymRole === 'owner') {
      kioskSection.style.display = 'block';
      document.getElementById('kioskUsername').value = '';
      document.getElementById('kioskPassword').value = '';
      document.getElementById('kioskCredMsg').style.display = 'none';
      _refreshKioskUsername();
    } else {
      kioskSection.style.display = 'none';
    }
  }

  document.getElementById('accountModal').style.display = 'flex';
}

// Owner-authenticated POST to /api/coach-auth. Returns { res, data }, or null
// when the owner isn't signed in (so callers can prompt to sign in again rather
// than throwing on a missing session). Centralizes the Bearer + action shape.
async function _coachAuthCall(action, body) {
  const { data: { session } } = await _supabase.auth.getSession();
  if (!session) return null;
  const res = await fetch('/api/coach-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
    body: JSON.stringify({ action, ...(body || {}) }),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function _refreshKioskUsername() {
  const label = document.getElementById('kioskCurrentUser');
  if (!label) return;
  label.textContent = 'Loading…';
  try {
    const r = await _coachAuthCall('credentials-get');
    const u = r && r.res.ok ? r.data.username : null;
    label.textContent = u ? ('Current username: ' + u) : (r ? 'Not set up yet' : '');
    document.getElementById('kioskDisableBtn').style.display = u ? '' : 'none';
  } catch(e) { label.textContent = ''; }
}

async function saveKioskCredentials() {
  const username = (document.getElementById('kioskUsername').value || '').trim().toLowerCase();
  const password = document.getElementById('kioskPassword').value || '';
  const msg = document.getElementById('kioskCredMsg');
  const show = (t, c) => { msg.style.display = 'block'; msg.style.color = c; msg.textContent = t; };
  if (!username || !password) { show('Enter a username and password.', 'var(--mat-red)'); return; }
  try {
    const r = await _coachAuthCall('credentials-set', { username, password });
    if (!r) { show('Your owner session expired — please sign in again.', 'var(--mat-red)'); return; }
    if (!r.res.ok) { show(r.data.error || 'Could not save coach login.', 'var(--mat-red)'); return; }
    document.getElementById('kioskUsername').value = '';
    document.getElementById('kioskPassword').value = '';
    show('Coach login saved.', 'var(--mat-gold)');
    _refreshKioskUsername();
  } catch(e) { show('Network error. Please try again.', 'var(--mat-red)'); }
}

async function disableKioskLogin() {
  if (!confirm('Turn off coach login? Coaches will no longer be able to sign in with the gym username and password.')) return;
  const msg = document.getElementById('kioskCredMsg');
  const show = (t, c) => { msg.style.display = 'block'; msg.style.color = c; msg.textContent = t; };
  try {
    const r = await _coachAuthCall('credentials-clear');
    if (!r) { show('Your owner session expired — please sign in again.', 'var(--mat-red)'); return; }
    if (!r.res.ok) { show(r.data.error || 'Could not disable.', 'var(--mat-red)'); return; }
    show('Coach login turned off.', 'var(--mat-muted)');
    _refreshKioskUsername();
  } catch(e) {
    show('Could not turn off coach login — it may still be active. Please try again.', 'var(--mat-red)');
  }
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
  document.getElementById('landingSettingsBtn')?.style.setProperty('display', '');
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
    document.getElementById('landingSettingsBtn')?.style.setProperty('display', '');
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

  // Pairing barcode — a phone scanning the gym's display QR lands here
  // with no Supabase account at all; redeem the one-time code instead.
  const pairCode = _urlParams.get('pair');
  if (pairCode && await _redeemPairingCode(pairCode)) return;

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
    // A previously-paired phone has no Supabase session but may still
    // hold a long-lived device token for this room — try that next.
    if (roomId && await _resumeDeviceSession()) return;
    // …or a coach/kiosk login on a shared gym device.
    if (roomId && await _resumeKioskSession()) return;
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
  // Discard any token minted for the previous room — _finishRoomSetup()
  // now reuses an unexpired token via _freshRoomToken() rather than always
  // re-minting, so a stale cross-room token must be cleared explicitly.
  _roomToken = null; _roomTokenExp = 0;
  _finishRoomSetup();
}

async function _finishRoomSetup() {
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('gymRoomPicker').style.display = 'none';
  document.getElementById('roomBar').style.display = 'flex';
  const codeEl = document.getElementById('roomCodeDisplay');
  if (codeEl) codeEl.textContent = _gymName || roomId;

  // _freshRoomToken() reuses an already-minted token (e.g. one a device
  // just got from pairing-redeem/device-token) instead of re-minting it.
  await _freshRoomToken();

  if (_gymRole === 'owner') {
    const btn = document.getElementById('coachesBtn');
    if (btn) btn.style.display = '';
    document.getElementById('landingSettingsBtn')?.style.setProperty('display', '');
  }

  partyFetch('/api/config').then(r => r.json()).then(cfg => {
    tvCodes  = cfg.tvCodes;
    branding = { ...branding, ...cfg.branding };
    applyBranding();
    restoreAudioSlots(cfg.audioSlots);
    showOnboardingIfNeeded();
    if (_gymRole === 'owner') {
      _checkSubscription();
    }
  }).catch(() => {});

  if (_gymRole === 'coach') {
    document.querySelectorAll('.brand-btn').forEach(b => b.style.display = 'none');
  }
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
  // Only owners can invite/create team members.
  const inv = document.getElementById('inviteCoachSection');
  if (inv) inv.style.display = _gymRole === 'owner' ? 'block' : 'none';
  const msg = document.getElementById('inviteCoachMsg');
  if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
  await loadCoaches();
}

// Invite a coach by email — creates their account + gym membership via the
// owner-only /api/create-user endpoint (Supabase sends the invite email).
async function inviteCoach() {
  if (_gymRole !== 'owner') return;
  const nameEl  = document.getElementById('inviteCoachName');
  const emailEl = document.getElementById('inviteCoachEmail');
  const btn     = document.getElementById('inviteCoachBtn');
  const msg     = document.getElementById('inviteCoachMsg');
  const email = (emailEl.value || '').trim();
  const name  = (nameEl.value || '').trim();
  const showMsg = (text, color) => { msg.style.display = 'block'; msg.style.color = color; msg.textContent = text; };
  if (!email) { emailEl.focus(); return; }

  btn.disabled = true;
  showMsg('Sending invite…', 'var(--mat-muted)');
  try {
    const { data: { session } } = await _supabase.auth.getSession();
    const res = await fetch('/api/create-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ name, email, gymId: _gymId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showMsg(data.error || 'Could not send invite', 'var(--mat-red)'); return; }
    showMsg('Invite sent to ' + email, 'var(--mat-gold)');
    nameEl.value = ''; emailEl.value = '';
    await loadCoaches();
  } catch (e) {
    showMsg('Could not send invite — check your connection', 'var(--mat-red)');
  } finally {
    btn.disabled = false;
  }
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
  showRound: true, overlayMsg: '',
};

let tvCodes = [];
let branding = { appName: 'BJJ Mat Timer', tagline: 'Competition · Training · Sparring', logoDataUrl: '' };

// ─── CONTROLLER IDENTITY ──────────────────────────────────────────
let myCtrlSlot  = null;   // which mat (1-4) this device is controlling
let myCtrlColor = null;
let myCtrlName  = '';
let _wasReplaced = false;  // set when another device took over our mat
let _freshLogin = false;   // true between a deliberate startController and its config reply

const CTRL_COLOR_HEX = {
  blue: '#3B82F6', green: '#10B981', amber: '#F59E0B', pink: '#EC4899',
};
const CTRL_COLOR_LABEL = {
  blue: 'Controller 1', green: 'Controller 2', amber: 'Controller 3', pink: 'Controller 4',
};

// ─── AUDIO ENGINE ─────────────────────────────────────────────────
let audioCtx = null;
const VALID_THEMES = new Set(['classic', 'bell', 'digital', 'minimal']);
let soundTheme = VALID_THEMES.has(localStorage.getItem('mattimer_sound_theme'))
  ? localStorage.getItem('mattimer_sound_theme') : 'classic';
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
function testStart()  { SOUND_THEMES[soundTheme].startSound(); }

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

// Entry to running a timer: first pick which mat, then identify the coach.
function promptControllerPassword() {
  openMatPicker();
}

// ─── MAT PICKER (multi-select: run several mats as one timer) ─────
let _selectedMats = [];   // mats chosen for this session, lowest = primary
let _matStatus = {};      // last-known occupancy from the server
let _takeoverMats = new Set(); // in-use mats the coach confirmed taking over

function openMatPicker() {
  const modal = document.getElementById('matPickerModal');
  if (!modal) return;
  _selectedMats = [];
  _takeoverMats = new Set();
  _matStatus = {};
  renderMatGrid();
  modal.style.display = 'flex';
  // Pull live occupancy so coaches see which mats are open vs. in use.
  partyFetch('/api/mats').then(r => r.json()).then(d => { _matStatus = d.mats || {}; renderMatGrid(); }).catch(() => {});
}

function closeMatPicker(e) {
  if (e && e.target !== document.getElementById('matPickerModal')) return;
  document.getElementById('matPickerModal').style.display = 'none';
}

function renderMatGrid() {
  const grid = document.getElementById('matGrid');
  if (!grid) return;
  grid.innerHTML = [1,2,3,4].map(n => {
    const m = _matStatus[n] || {};
    const inUse = m.occupied;
    const picked = _selectedMats.includes(n);
    let sub;
    if (picked && _takeoverMats.has(n)) sub = 'Taking over';
    else if (inUse) sub = (m.inProgress ? `In progress — ${escHtml(m.name || 'Coach')} away` : `In use — ${escHtml(m.name || 'Coach')}`) + ' · tap to take over';
    else sub = picked ? 'Selected' : 'Tap to select';
    const accent = m.color || getSlotColor(n);
    const cls = 'mat-card' + (inUse ? ' mat-in-use' : '') + (picked ? ' mat-picked' : '');
    return `<button class="${cls}" onclick="toggleMat(${n})" style="border-left-color:${accent}">
      <span class="mat-card-num">Mat ${n}</span>
      <span class="mat-card-status">${sub}</span>
    </button>`;
  }).join('');
  const btn = document.getElementById('matConfirmBtn');
  if (btn) {
    const k = _selectedMats.length;
    btn.disabled = k === 0;
    btn.textContent = k <= 1 ? 'Run this mat' : `Run ${k} mats together`;
  }
}

function toggleMat(n) {
  const i = _selectedMats.indexOf(n);
  if (i === -1) {
    const m = _matStatus[n];
    if (m?.occupied) {
      // Deliberate takeover of an in-use mat — confirm, since it resets the
      // current coach's timer and bounces them if they're still connected.
      const who = m.name || 'another coach';
      const label = m.inProgress ? `${who} (away)` : who;
      if (!confirm(`Mat ${n} is in use by ${label}. Take it over? This resets their timer.`)) return;
      _takeoverMats.add(n);
    }
    _selectedMats.push(n);
  } else {
    _selectedMats.splice(i, 1);
    _takeoverMats.delete(n);
  }
  _selectedMats.sort((a, b) => a - b);
  renderMatGrid();
}

function confirmMats() {
  if (_selectedMats.length === 0) return;
  document.getElementById('matPickerModal').style.display = 'none';
  // Platform admins skip coach profiles and go straight in.
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
  const isOwner = _gymRole === 'owner';
  grid.innerHTML = profiles.map(p => `
    <div class="profile-card" onclick="selectProfile('${p.id}')" style="border-color:${p.color}44">
      <div class="profile-color-bar" style="background:${p.color}"></div>
      ${isOwner ? `<button class="profile-edit" onclick="event.stopPropagation();openEditProfile('${p.id}')" title="Edit name / change PIN">✎</button>
      <button class="profile-delete" onclick="event.stopPropagation();deleteProfile('${p.id}')" title="Delete">✕</button>` : ''}
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

// ─── EDIT PROFILE (rename / change PIN) ───────────────────────────
let _editProfileId = null;

function openEditProfile(id) {
  const profile = profiles.find(p => p.id === id);
  if (!profile) return;
  _editProfileId = id;
  document.getElementById('profilePickerModal').style.display = 'none';
  document.getElementById('editProfileName').value = profile.name || '';
  document.getElementById('editProfilePin').value = '';
  document.getElementById('editProfilePin').placeholder = profile.hasPin ? 'New PIN (current kept if blank)' : 'Set a PIN';
  document.getElementById('editProfileModal').style.display = 'flex';
  setTimeout(() => document.getElementById('editProfileName').focus(), 80);
}

function closeEditProfile(e) {
  if (e && e.target !== document.getElementById('editProfileModal')) return;
  document.getElementById('editProfileModal').style.display = 'none';
  _editProfileId = null;
  openProfilePicker();
}

async function submitEditProfile() {
  if (!_editProfileId) return;
  const name = document.getElementById('editProfileName').value.trim();
  const pin  = document.getElementById('editProfilePin').value.trim();
  if (!name) { document.getElementById('editProfileName').focus(); return; }
  const body = { name };
  if (pin) body.pin = pin; // blank = keep current PIN
  const res = await partyFetch('/api/profiles/' + _editProfileId, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.status; try { detail = (await res.json()).error || res.status; } catch {}
    toast('Could not save profile: ' + detail); return;
  }
  document.getElementById('editProfileModal').style.display = 'none';
  _editProfileId = null;
  await loadProfiles();
  toast(pin ? '✓ PIN updated' : '✓ Profile saved');
  openProfilePicker();
}

async function removeProfilePin() {
  if (!_editProfileId) return;
  if (!confirm('Remove the PIN? Anyone will be able to use this profile without one.')) return;
  const name = document.getElementById('editProfileName').value.trim();
  const res = await partyFetch('/api/profiles/' + _editProfileId, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name: name || undefined, pin: '' }), // empty pin clears it
  });
  if (!res.ok) {
    let detail = res.status; try { detail = (await res.json()).error || res.status; } catch {}
    toast('Could not remove PIN: ' + detail); return;
  }
  document.getElementById('editProfileModal').style.display = 'none';
  _editProfileId = null;
  await loadProfiles();
  toast('✓ PIN removed');
  openProfilePicker();
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

function _getCtrlDeviceId() {
  let id = localStorage.getItem('mattimer_ctrl_device_id');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem('mattimer_ctrl_device_id', id);
  }
  return id;
}

let myCtrlMats = [];

function _controllerSocketParams() {
  const mats = (myCtrlMats.length ? myCtrlMats : _selectedMats);
  return {
    mats:      (mats.length ? mats : [1]).join(','),
    name:      encodeURIComponent(myCtrlName || 'Unnamed Class'),
    color:     _pendingProfile?.color || '',
    profileId: _pendingProfile?.id    || '',
    clientId:  _getCtrlDeviceId(),
    takeover:  (mats || []).some(m => _takeoverMats.has(+m)) ? '1' : '',
  };
}

function startController() {
  mode = 'controller';
  _wasReplaced = false;
  _freshLogin = true; // a deliberate login (vs. a sleep/resume reconnect)
  myCtrlMats = _selectedMats.slice();
  myCtrlSlot = myCtrlMats[0] || 1;
  openSocket('controller', _controllerSocketParams());
  document.getElementById('landing').style.display    = 'none';
  document.getElementById('controller').style.display = 'block';
  _updateMatLabel();
  updateUI();
}

// "Mat N" (or "Mats 1, 3") label in the controller status bar.
function _updateMatLabel() {
  const el = document.getElementById('matLabel');
  if (!el) return;
  const mats = myCtrlMats.length ? myCtrlMats : (myCtrlSlot ? [myCtrlSlot] : []);
  el.textContent = mats.length > 1 ? `Mats ${mats.join(', ')}` : `Mat ${mats[0] || ''}`.trim();
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
  _refreshDisplayMode();
}

function _onClose(ev) {
  if (mode !== 'display') return;
  showReconnectOverlay('Reconnecting…');
  setDisplayStatus('connecting', 'Reconnecting...');
  requestLastKnownState();
}

let dispSwRaf = null;
let dispSwShown = 0;        // last stopwatch ms rendered on the TV
let dispSwRunning = false;  // is the TV stopwatch currently counting up?

function _onMessage(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch(e) { return; }

  switch (msg.type) {

    case 'config': {
      tvCodes  = msg.tvCodes;
      branding = { ...branding, ...msg.branding };
      if (msg.ctrlSlot)  myCtrlSlot = msg.ctrlSlot;
      if (Array.isArray(msg.mats) && msg.mats.length) myCtrlMats = msg.mats.slice();
      if (msg.ctrlColor) myCtrlColor = msg.ctrlColor;
      applyBranding();
      applyControllerColor();
      _updateMatLabel();
      const serverRunning = !!(msg.timerState && msg.timerState.running);
      if (_freshLogin && !serverRunning) {
        // Deliberate login on an idle mat: keep this coach's profile presets
        // (already in local state from loginWithProfile) and push them so the
        // mat and its TV reflect this class's timing.
        emit('timer:config', {
          roundDuration: state.roundDuration, restDuration: state.restDuration,
          totalRounds: state.totalRounds, warningEnabled: state.warningEnabled,
          warningThreshold: state.warningThreshold, showRound: state.showRound,
        });
      } else if (msg.timerState) {
        // Reconnect (sleep/resume) or taking over a live round: adopt the
        // server's authoritative timer so we pick up exactly where it is.
        applyControllerStateSnapshot(msg.timerState, { silent: true });
      }
      // On a reconnect/takeover (not a deliberate fresh login), also restore the
      // server-owned stopwatch and active tab so an iOS-sleep resume continues.
      if (!_freshLogin) {
        if (msg.stopwatchState) swAdoptSnapshot(msg.stopwatchState);
        if (msg.tab) _applyTabUI(msg.tab === 'stopwatch' ? 'stopwatch' : 'timer');
      }
      _freshLogin = false;
      // We now own these mats — drop any takeover intent so a later sleep/resume
      // reconnect (which reuses these params) never re-kicks anyone.
      _takeoverMats = new Set();
      break;
    }

    // Live per-mat occupancy — only meaningful while the mat picker is open.
    case 'mat:status': {
      if (document.getElementById('matPickerModal')?.style.display === 'flex') {
        _matStatus = msg.mats || {};
        renderMatGrid();
      }
      break;
    }

    // Another device took over this mat — stop fighting for it and bounce the
    // coach back to the mat picker.
    case 'replaced': {
      _wasReplaced = true;
      if (socket) { try { socket.close(); } catch(e) {} }
      mode = null;
      document.getElementById('controller').style.display = 'none';
      document.getElementById('landing').style.display = 'flex';
      toast('This mat was taken over on another device.');
      openMatPicker();
      break;
    }

    case 'state': {
      const { type: _, ...s } = msg;
      if (mode === 'display')    applyStateSnapshot(s);
      else if (mode === 'controller') applyControllerStateSnapshot(s);
      break;
    }
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
      _displayTab = msg.tab === 'stopwatch' ? 'stopwatch' : 'timer';
      _refreshDisplayMode();
      break;
    }

    case 'sw:state': {
      if (mode !== 'display') break;
      const latency = Date.now() - msg.ts;
      // Seed from the authoritative elapsed, then count via a real-time anchor
      // (performance.now delta) rather than +16/frame. This stays wall-clock
      // accurate between the 1 Hz frames AND through a multi-minute controller
      // sleep where no further frames arrive; each new sw:state re-seeds.
      const seed   = msg.elapsed + (msg.running ? latency : 0);
      // Ignore a stale/out-of-order running frame that would snap the clock
      // backwards (running elapsed never legitimately decreases). Leave the
      // current rAF loop counting so the display stays smooth.
      if (msg.running && dispSwRunning && seed < dispSwShown - 750) break;
      cancelAnimationFrame(dispSwRaf);
      dispSwRunning = msg.running;
      const anchor = performance.now();
      const swEl   = document.getElementById('displaySwTime');
      function dispSwTick() {
        const disp = msg.running ? seed + (performance.now() - anchor) : seed;
        dispSwShown = disp;
        if (swEl) swEl.innerHTML = (() => {
          const mins = Math.floor(disp/60000), secs = Math.floor((disp%60000)/1000);
          return `${mins}:${String(secs).padStart(2,'0')}`;
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
        const theme = SOUND_THEMES[soundTheme] || SOUND_THEMES.classic;
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

// ─── VISIBILITY RECOVERY ──────────────────────────────────────────
// A backgrounded/locked phone can leave its WebSocket reporting OPEN while
// the OS has silently suspended the network stack underneath it — a press
// like "Resume" appears to send fine client-side but never reaches the
// server until something forces a fresh connection. Force a clean
// reconnect whenever the page regains visibility after being hidden for a
// while, so a zombied connection can't silently swallow commands.
let _hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { _hiddenAt = Date.now(); return; }
  const wasHiddenAWhile = _hiddenAt && (Date.now() - _hiddenAt >= 5000);
  _hiddenAt = null;
  if (!wasHiddenAWhile || !roomId || _wasReplaced) return;
  // Reconnect to the same mat with the same clientId — the server treats this
  // as a silent same-device reclaim and replies with the live timer state.
  if (mode === 'controller') {
    openSocket('controller', _controllerSocketParams());
  } else if (mode === 'display' && _displayTvCode) {
    openSocket('tv', { code: _displayTvCode });
  }
});

// Auto-connect as TV display if ?room=X&tv=CODE is in the URL
(function checkTvBookmark() {
  const tvCode = _urlParams.get('tv');
  if (tvCode && roomId) {
    _displayTvCode = tvCode.toUpperCase();
    mode = 'display';
    openSocket('tv', { code: _displayTvCode });
  }
})();

// Ends the current coach's session (closes the controller socket, which frees
// the mat on the server) and returns to the mat picker. Does not touch the
// device's pairing in localStorage, so this phone stays connected to the gym.
function exitToProfilePicker() {
  // Deliberate switch = release the mat(s) now so they're free to pick again and
  // their screens return to idle. Confirm first if a class is actively running.
  if ((state.running || swRunning) && !confirm('End the current session on this mat and switch?')) return;
  if (socket) {
    try { emit('ctrl:release'); } catch(e) {}
    try { socket.close(); } catch(e) {}
  }
  mode = null;
  myCtrlName = null; _pendingProfile = null; myCtrlMats = [];
  document.getElementById('controller').style.display = 'none';
  document.getElementById('landing').style.display = 'flex';
  openMatPicker();
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
  // A named coach means the mat is in use → show the timer; otherwise it's idle.
  _displayCoachActive = !!name;
  _refreshDisplayMode();
}

function getSlotColor(slot) {
  return ['','#3B82F6','#10B981','#F59E0B','#EC4899'][slot] || '#888';
}

// Display audio is now handled inside _onMessage (case 'sound')


// ─── TIMER LOGIC ──────────────────────────────────────────────────
function toggleStartPause() { state.running ? pauseTimer() : startTimer(); }

function _updateStartPauseBtn() {
  const btn = document.getElementById('startPauseBtn');
  if (!btn) return;
  if (state.running) {
    btn.textContent = '⏸ Pause'; btn.className = 'btn btn-red btn-massive';
  } else {
    const resumed = state.timeRemaining > 0 && state.timeRemaining < state.roundDuration;
    btn.textContent = resumed ? '▶ Resume' : '▶ Start';
    btn.className = 'btn btn-green btn-massive';
  }
}

function startTimer(silent = false) {
  getAudioCtx();
  if (!silent) {
    const playedCustom = playCustomAudio('start');
    if (!playedCustom) SOUND_THEMES[soundTheme].startSound();
  }
  emit('timer:start');
  // Optimistic UI — server state will confirm within one tick
  state.running = true;
  _updateStartPauseBtn(); updateUI();
}

function pauseTimer() {
  emit('timer:pause');
  state.running = false;
  _updateStartPauseBtn(); updateUI();
}

function resetTimer() {
  emit('timer:reset');
  state.running = false; state.currentRound = 1; state.phase = 'fight';
  state.timeRemaining = state.roundDuration;
  _updateStartPauseBtn(); updateUI();
}

function nextRound() {
  emit('timer:nextRound');
  state.running = false;
  if (state.currentRound < state.totalRounds) state.currentRound++;
  state.phase = 'fight'; state.timeRemaining = state.roundDuration;
  _updateStartPauseBtn(); updateUI();
}

// Applies state received from the server to the controller UI and plays sounds
// for phase transitions. Pass silent:true on initial load to skip sounds.
function applyControllerStateSnapshot(s, { silent = false } = {}) {
  const prevPhase   = state.phase;
  const prevRunning = state.running;
  const prevRound   = state.currentRound;
  Object.assign(state, s);

  if (!silent) {
    const beepOn   = document.getElementById('soundBeepToggle')?.checked ?? true;
    const buzzerOn = document.getElementById('soundBuzzerToggle')?.checked ?? true;

    // Countdown beeps (server also sends these to TVs; controller plays locally)
    if (s.phase === 'fight' && s.running && s.timeRemaining > 0 && s.timeRemaining <= 10 && beepOn) {
      if (s.timeRemaining <= 3) SOUND_THEMES[soundTheme].accentBeep();
      else                      SOUND_THEMES[soundTheme].countdownBeep();
    }
    // Spotify auto pause/resume (coach controller only; no-op unless connected
    // + enabled). Fire-and-forget so a slow/failed Spotify call never blocks the
    // timer. See public/js/spotify.js.
    const sp = (mode === 'controller' && window.spotifyEnabled?.()) ? window : null;
    const spOpts = sp ? window.spotifyOpts() : null;

    // Fight → rest
    if (prevPhase === 'fight' && s.phase === 'rest') {
      if (buzzerOn) { const pc = playCustomAudio('stop'); if (!pc) SOUND_THEMES[soundTheme].buzzerSound(); }
      const pr = playCustomAudio('rest'); if (!pr) SOUND_THEMES[soundTheme].restSound();
      if (sp && spOpts.pauseRest) sp.spotifyPause();
    }
    // Rest → fight (start of new round)
    if (prevPhase === 'rest' && s.phase === 'fight') {
      const ps = playCustomAudio('start'); if (!ps) SOUND_THEMES[soundTheme].startSound();
      if (sp) sp.spotifyResume();
    }
    // Fight → fight, new round with no rest period
    if (prevPhase === 'fight' && s.phase === 'fight' && s.currentRound > prevRound && prevRunning) {
      const ps = playCustomAudio('start'); if (!ps) SOUND_THEMES[soundTheme].startSound();
      if (sp) sp.spotifyResume();
    }
    // Timer fully ended (fight, last round, running→stopped)
    if (prevRunning && !s.running && s.timeRemaining === 0) {
      if (buzzerOn) { const pc = playCustomAudio('stop'); if (!pc) SOUND_THEMES[soundTheme].buzzerSound(); }
      if (sp && spOpts.pauseEnd) sp.spotifyPause();
    }
    // Manual pause mid-round (coach paused the timer, round not over)
    if (prevRunning && !s.running && s.timeRemaining > 0) {
      if (sp && spOpts.pauseManual) sp.spotifyPause();
    }
    // Timer started/resumed (first start or resume after a manual pause)
    if (!prevRunning && s.running) {
      if (sp) sp.spotifyResume();
    }
  }

  updateUI(); _updateStartPauseBtn(); _seedTimerInterp();
}

// ─── SETTINGS MODAL ───────────────────────────────────────────────
function openSettingsModal() {
  document.getElementById('settingsModal').style.display = 'flex';
  const sel = document.getElementById('soundThemeSelect');
  if (sel) sel.value = soundTheme;
  window.spotifyRefreshUi?.();
}
function closeSettingsModal(e) {
  if (e && e.target !== document.getElementById('settingsModal')) return;
  document.getElementById('settingsModal').style.display = 'none';
}

// ─── DURATION (1–10 min pills) ────────────────────────────────────
function setDurationMin(min) {
  state.roundDuration = min * 60;
  // Picking a duration restarts the round at the new time (the server restarts a
  // running fight round too); reflect it immediately rather than waiting a tick.
  if (!state.running || state.phase === 'fight') state.timeRemaining = state.roundDuration;
  document.querySelectorAll('.dur-pill').forEach((b, i) => {
    b.classList.toggle('active', i + 1 === min);
  });
  updateUI();
  emit('timer:config', { roundDuration: state.roundDuration });
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
  updateUI();
  emit('timer:config', {
    roundDuration: state.roundDuration, restDuration: state.restDuration,
    totalRounds: state.totalRounds, warningEnabled: state.warningEnabled,
    warningThreshold: state.warningThreshold, showRound: state.showRound,
  });
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
function getTimerClass(remaining = state.timeRemaining) {
  if (state.phase === 'fight' && state.warningEnabled) {
    if (remaining <= 10) return 'danger';
    if (remaining <= state.warningThreshold) return 'warning';
  }
  return '';
}
function updateUI() {
  if (mode !== 'controller') return;
  _paintTimer(state.timeRemaining);
  document.getElementById('ctrlRoundLabel').textContent = state.phase === 'rest' ? 'Rest' : `Round ${state.currentRound} of ${state.totalRounds}`;
  const pl = document.getElementById('ctrlPhaseLabel');
  pl.textContent = state.phase === 'fight' ? 'Fight' : 'Rest';
  pl.className = 'phase-label ' + state.phase;
}

// ─── TIMER INTERPOLATION ──────────────────────────────────────────
// The server pushes timer state ~1 Hz; between pushes we count down locally
// from a wall-clock anchor (performance.now), so a brief gap in the broadcast
// stream — a TV's flaky WebSocket, a render stall on an underpowered TV stick,
// a momentary server delay — doesn't freeze the on-screen clock. Every server
// `state` message re-seeds this loop, so the server stays authoritative; local
// counting only fills the gaps. Display-only: sounds/phase changes still come
// from the server. Mirrors the stopwatch's anchor model (see sw:state).
let _timerRaf = null, _timerSeedMs = 0, _timerAnchor = 0, _timerLastSec = -1;

function _stopTimerInterp() {
  if (_timerRaf) cancelAnimationFrame(_timerRaf);
  _timerRaf = null;
}

// Paint the active timer face (TV or controller) for a given remaining-seconds.
function _paintTimer(sec) {
  const timeStr = formatTime(sec), cls = getTimerClass(sec);
  if (mode === 'display') {
    const el = document.getElementById('displayTime');
    if (el) { el.textContent = timeStr; el.className = 'display-time ' + cls; }
  } else if (mode === 'controller') {
    const el = document.getElementById('ctrlTimer');
    if (el) { el.textContent = timeStr; el.className = 'ctrl-timer-display ' + cls; }
  }
}

// Re-seed local interpolation from the latest authoritative snapshot. Counts
// down only while the timer is running; when paused/stopped we leave the
// snapshot's painted value in place.
function _seedTimerInterp() {
  _stopTimerInterp();
  _paintTimer(state.timeRemaining);   // paint the authoritative snapshot immediately (covers the paused/stopped case)
  // The server reports ceil(realRemaining) (it floors elapsed), so seeding from
  // timeRemaining seconds and ceil-ing the live value keeps us in lockstep.
  _timerSeedMs = state.timeRemaining * 1000;
  _timerAnchor = performance.now();
  _timerLastSec = state.timeRemaining;
  if (state.running && state.timeRemaining > 0) _timerRaf = requestAnimationFrame(_timerInterpTick);
}

function _timerInterpTick() {
  const liveMs = Math.max(0, _timerSeedMs - (performance.now() - _timerAnchor));
  // Display value is whole seconds, so repaint only when the second rolls over —
  // the rAF runs ~60 Hz but the DOM only needs touching ~1 Hz.
  const sec = Math.ceil(liveMs / 1000);
  if (sec !== _timerLastSec) { _timerLastSec = sec; _paintTimer(sec); }
  // Hold at 0 once we run out; the server's phase-end message re-seeds us into
  // the next round/rest within a tick.
  if (liveMs <= 0) { _timerRaf = null; return; }
  _timerRaf = requestAnimationFrame(_timerInterpTick);
}

function applyStateSnapshot(s) {
  Object.assign(state, s);
  // The timer face (#displayTime) is painted by _seedTimerInterp() → _paintTimer() below.
  const roundEl = document.getElementById('displayRound');
  if (roundEl) {
    roundEl.textContent = `Round ${state.currentRound} of ${state.totalRounds}`;
    roundEl.style.display = state.showRound ? '' : 'none';
  }
  const dPhase = document.getElementById('displayPhase');
  dPhase.textContent = state.phase === 'fight' ? 'FIGHT' : 'REST';
  dPhase.className = 'display-phase ' + state.phase;
  document.getElementById('displayInner').classList.toggle('phase-rest', state.phase === 'rest');

  applyProgress(state);
  _seedTimerInterp();

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
// Toggle the controller's tab UI without telling the server — used when adopting
// the server's remembered tab on reconnect (so we don't echo it back).
function _applyTabUI(tab) {
  activeTab = tab;
  document.getElementById('tabTimer').classList.toggle('active', tab === 'timer');
  document.getElementById('tabStopwatch').classList.toggle('active', tab === 'stopwatch');
  document.getElementById('panelTimer').classList.toggle('hidden', tab !== 'timer');
  document.getElementById('panelStopwatch').classList.toggle('hidden', tab !== 'stopwatch');
}
function switchTab(tab) {
  // Seamless handoff: when leaving a *running* clock, pause it and resume the
  // one we switch to (silently) so exactly one clock runs across the switch.
  const from = activeTab;
  if (from !== tab) {
    if (from === 'timer' && tab === 'stopwatch' && state.running) {
      pauseTimer();
      if (!swRunning) swToggle();
    } else if (from === 'stopwatch' && tab === 'timer' && swRunning) {
      swToggle();
      if (!state.running && state.timeRemaining > 0) startTimer(true);
    }
  }
  _applyTabUI(tab);
  emit('tab', { tab });
}

// ─── STOPWATCH ────────────────────────────────────────────────────
// Wall-clock model: while running, live elapsed = Date.now() - swStartTime;
// while paused, swElapsed holds the frozen value. The broadcast value is always
// derived from the wall clock (not a per-frame accumulator), so a backgrounded
// phone whose rAF is frozen still reports the correct, advancing elapsed instead
// of a stale value that would make the TV jitter back and forth.
let swRunning = false, swElapsed = 0, swStartTime = null, swRafId = null;
let swBroadcastTimer = null;

function swCurrentElapsed() {
  return swRunning && swStartTime != null ? Date.now() - swStartTime : swElapsed;
}

function swFormatDisplay(ms) {
  const mins = Math.floor(ms/60000);
  const secs = Math.floor((ms%60000)/1000);
  return `${mins}:${String(secs).padStart(2,'0')}`;
}

function swBroadcast() {
  emit('sw:state', { elapsed: swCurrentElapsed(), running: swRunning, ts: Date.now() });
}

function swTick() {
  if (!swRunning) return;
  // rAF is purely for smooth on-screen rendering now — correctness is wall-clock based.
  document.getElementById('swDisplay').innerHTML = swFormatDisplay(swCurrentElapsed());
  swRafId = requestAnimationFrame(swTick);
}

function swToggle() {
  if (swRunning) {
    swElapsed = Date.now() - swStartTime; swStartTime = null; swRunning = false;
    cancelAnimationFrame(swRafId);
    clearInterval(swBroadcastTimer);
    document.getElementById('swStartPauseBtn').textContent = '▶ Resume';
    document.getElementById('swStartPauseBtn').className = 'btn btn-green btn-massive';
  } else {
    swStartTime = Date.now() - swElapsed; swRunning = true; getAudioCtx();
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

// Adopt the server's authoritative stopwatch on reconnect (sleep/resume) so the
// controller resumes from the exact live elapsed. snap = { running, elapsed, ts }
// already re-anchored server-side; we add any remaining in-flight time.
function swAdoptSnapshot(snap) {
  cancelAnimationFrame(swRafId);
  clearInterval(swBroadcastTimer);
  const live = (snap.elapsed || 0) + (snap.running ? Date.now() - snap.ts : 0);
  swElapsed = live;
  swRunning = !!snap.running;
  document.getElementById('swDisplay').innerHTML = swFormatDisplay(live);
  const btn = document.getElementById('swStartPauseBtn');
  if (swRunning) {
    swStartTime = Date.now() - live;
    btn.textContent = '⏸ Pause'; btn.className = 'btn btn-red btn-massive';
    swRafId = requestAnimationFrame(swTick);
    swBroadcastTimer = setInterval(swBroadcast, 1000);
  } else {
    swStartTime = null;
    btn.textContent = live > 0 ? '▶ Resume' : '▶ Start';
    btn.className = 'btn btn-green btn-massive';
  }
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

  // Idle-clock setting may have changed — refresh what an idle TV shows.
  _refreshDisplayMode();
}

// ─── DISPLAY MODE (idle clock vs. timer) ──────────────────────────
let _displayCoachActive = false; // is a coach currently running this mat?
let _displayTab = 'timer';       // which panel the controller last selected

// True when the idle clock (digital or analog) is on screen: idle-clock setting
// enabled and no coach is running this mat.
function _isIdleClockMode() {
  return mode === 'display' && !!branding.idleClock && !_displayCoachActive;
}

// Decide what an idle TV shows: a big time-of-day clock when the idle-clock
// setting is on and no coach is running this mat; otherwise the timer/stopwatch.
function _refreshDisplayMode() {
  if (mode !== 'display') return;
  const big    = document.getElementById('displayBigClock');
  const analog = document.getElementById('displayAnalogClock');
  const timer  = document.getElementById('displayPanelTimer');
  const sw     = document.getElementById('displayPanelStopwatch');
  const clockMode = _isIdleClockMode();
  if (clockMode) {
    if (timer) timer.style.display = 'none';
    if (sw)    sw.style.display = 'none';
    if (branding.idleClockAnalog) {
      if (big)    big.style.display = 'none';
      if (analog) analog.style.display = 'block';
      _updateAnalogClock();
    } else {
      if (analog) analog.style.display = 'none';
      if (big)    big.style.display = 'flex';
      _updateBigClock();
    }
  } else {
    if (big)    big.style.display = 'none';
    if (analog) analog.style.display = 'none';
    if (_displayTab === 'stopwatch') { if (timer) timer.style.display='none'; if (sw) sw.style.display='flex'; }
    else                             { if (timer) timer.style.display='block'; if (sw) sw.style.display='none'; }
  }
  // Bottom-left shows the date in clock mode, the time otherwise — refresh now.
  updateDisplayClock();
  applyProgress(state);
}

// True when the countdown timer panel is the active display view (not the
// stopwatch tab, not an idle wall-clock). Mirrors the show condition for
// #displayPanelTimer in _refreshDisplayMode().
function timerPanelActive() {
  return mode === 'display' && !_isIdleClockMode() && _displayTab === 'timer';
}

// Drive the bottom progress bar. Running → deplete to empty over the remaining
// seconds via a linear CSS transform transition; paused/reset → freeze at the
// current fraction. Seeds from the same timeRemaining as the number, so the two
// stay in sync without touching the throttled rAF interpolation loop.
function applyProgress(s) {
  const ring = document.getElementById('displayRing');
  const prog = document.getElementById('displayRingProg');
  if (!ring || !prog) return;
  const full = s.phase === 'rest' ? s.restDuration : s.roundDuration;
  if (!timerPanelActive() || !full || full <= 0) { ring.style.display = 'none'; return; }
  ring.style.display = '';
  const frac = roundProgress(s);
  prog.style.transition = 'none';                          // freeze at the current fraction
  prog.style.strokeDashoffset = String(100 * (1 - frac));  // visible arc = frac of the ring
  void prog.getBoundingClientRect();                        // force reflow so the transition starts here
  if (s.running && s.timeRemaining > 0) {
    prog.style.transition = 'stroke-dashoffset ' + s.timeRemaining + 's linear';
    prog.style.strokeDashoffset = '100';                    // deplete to empty over the remaining time
  }
}

function _updateBigClock() {
  const el = document.getElementById('displayBigClock');
  if (!el || el.style.display === 'none') return;
  const now = new Date();
  let h = now.getHours();
  const min = String(now.getMinutes()).padStart(2,'0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  el.innerHTML = `${h}:${min}<span style="font-size:.4em;opacity:.6;letter-spacing:.05em"> ${ampm}</span>`;
}

// Build the 12 hour ticks once (major marks at 12/3/6/9). No rim numbers — the
// hour and minute numbers ride the hand tips instead (see _updateAnalogClock).
function _buildAnalogTicks() {
  const g = document.getElementById('acTicks');
  if (g && !g.childElementCount) {
    const ns = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < 12; i++) {
      const ang = i * 30 * Math.PI / 180;
      const outer = 96, inner = i % 3 === 0 ? 80 : 86;
      const ln = document.createElementNS(ns, 'line');
      ln.setAttribute('x1', (100 + outer * Math.sin(ang)).toFixed(2));
      ln.setAttribute('y1', (100 - outer * Math.cos(ang)).toFixed(2));
      ln.setAttribute('x2', (100 + inner * Math.sin(ang)).toFixed(2));
      ln.setAttribute('y2', (100 - inner * Math.cos(ang)).toFixed(2));
      ln.setAttribute('class', 'clock-tick' + (i % 3 === 0 ? ' major' : ''));
      g.appendChild(ln);
    }
  }
}

function _updateAnalogClock() {
  const svg = document.getElementById('displayAnalogClock');
  if (!svg || svg.style.display === 'none') return;
  _buildAnalogTicks();
  const now = new Date();
  const s = now.getSeconds(), m = now.getMinutes(), h = now.getHours();
  const rot = (id, deg) => {
    const el = document.getElementById(id);
    if (el) el.setAttribute('transform', `rotate(${deg} 100 100)`);
  };
  rot('acHour', (h % 12 + m / 60) * 30);
  rot('acMin',  (m + s / 60) * 6);
  rot('acSec',  s * 6);
  // Position the number badges at the hand tips (group is only translated, never
  // rotated, so the digits stay upright). Radii match the hand lengths.
  const place = (id, deg, r, text) => {
    const grp = document.getElementById(id);
    if (!grp) return;
    const a = (deg - 90) * Math.PI / 180;          // 0deg = 12 o'clock
    const x = 100 + r * Math.cos(a), y = 100 + r * Math.sin(a);
    grp.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    const t = grp.querySelector('text');
    if (t) t.textContent = text;
  };
  place('acHourLabel', (h % 12 + m / 60) * 30, 80, h % 12 || 12); // out by the hour ticks
  place('acMinLabel',  (m + s / 60) * 6,       66, m);            // just inside, at the minute-hand tip
}
function openBrandingModal() {
  document.getElementById('bName').value     = branding.appName || '';
  document.getElementById('bTagline').value  = branding.tagline || '';
  document.getElementById('bIdleClock').checked = !!branding.idleClock;
  document.getElementById('bIdleClockAnalog').checked = !!branding.idleClockAnalog;
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
  branding.idleClock = document.getElementById('bIdleClock').checked;
  branding.idleClockAnalog = document.getElementById('bIdleClockAnalog').checked;
  if (logoInput._pendingDataUrl) branding.logoDataUrl = logoInput._pendingDataUrl;
  if (roomId) {
    let res;
    try {
      res = await partyFetch('/api/branding', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ...branding }) });
    } catch (e) {
      toast('Could not save settings — network error'); return;
    }
    if (!res.ok) {
      let detail = res.status;
      try { detail = (await res.json()).error || res.status; } catch {}
      toast('Could not save settings: ' + detail); return;
    }
  }
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
let _pairingQrTimer = null;
const PAIRING_QR_REFRESH_MS = 8 * 60 * 1000; // before pairing-create's 10-min code TTL

function generateDisplayQr() {
  const container = document.getElementById('displayQrCode');
  const label     = document.getElementById('displayQrLabel');
  if (!container) return;

  // Owner session active on this screen: show a rotating pairing QR so a
  // coach's phone can join with no Supabase account of its own.
  if (roomId && !_isDemoRoom() && _gymRole === 'owner') {
    _refreshPairingQr(container, label);
    if (!_pairingQrTimer) {
      _pairingQrTimer = setInterval(() => _refreshPairingQr(container, label), PAIRING_QR_REFRESH_MS);
    }
    return;
  }

  if (_qrGenerated) return;
  // No owner session to mint a pairing code — fall back to a plain room link
  const url = roomId
    ? `${location.origin}${location.pathname}?room=${roomId}`
    : location.origin;
  renderQr(container, label, url, url.replace(/^https?:\/\//, ''), '');
}

// Mints a fresh one-time pairing code and renders it as "scan to add a
// coach phone" — see api/pairing-create.js.
async function _refreshPairingQr(container, label) {
  try {
    const { data: { session } } = await _supabase.auth.getSession();
    if (!session) return;
    const res = await fetch('/api/pairing-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ roomId }),
    });
    if (!res.ok) return;
    const { url } = await res.json();
    renderQr(container, label, url, 'Scan to add a coach phone', '');
  } catch(e) {}
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
  const timeEl = document.getElementById('displayTime2');
  if (timeEl) {
    if (_isIdleClockMode()) {
      // The big clock already shows the time — show today's date here instead.
      timeEl.textContent = `${now.getMonth() + 1}/${now.getDate()}/${String(now.getFullYear()).slice(-2)}`;
    } else {
      let h = now.getHours();
      const min = String(now.getMinutes()).padStart(2,'0');
      const ampm = h >= 12 ? 'pm' : 'am';
      h = h % 12 || 12;
      timeEl.textContent = `${h}:${min} ${ampm}`;
    }
  }
  _updateBigClock();
  _updateAnalogClock();
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

  // Seamless updates: when a freshly-deployed service worker installs, tell it
  // to take over immediately; when it does, reload once so the page runs the
  // new code instead of stale cached JS. (Prevents the "old client" problem.)
  let _swReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swReloaded) return;
    _swReloaded = true;
    location.reload();
  });

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
