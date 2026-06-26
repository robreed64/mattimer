// public/js/spotify.js — Spotify auto-pause/resume for the coach controller.
//
// Connects the coach's Spotify account via Authorization Code with PKCE (no
// client secret, runs entirely in the browser) and pauses/resumes their
// already-playing music at round boundaries. Controls the user's ACTIVE Spotify
// device (their phone's Spotify app) via the Web API. Requires Spotify Premium —
// free accounts return 403 and the feature silently no-ops. Every network call
// is wrapped so it can never throw into or block the timer.
(function () {
  'use strict';

  const AUTH_URL  = 'https://accounts.spotify.com/authorize';
  const TOKEN_URL = 'https://accounts.spotify.com/api/token';
  const API_BASE  = 'https://api.spotify.com/v1';
  const SCOPES    = 'user-modify-playback-state user-read-playback-state';

  const TOKENS_KEY  = 'mattimer_spotify_tokens';   // {access_token, refresh_token, expires_at}
  const ENABLED_KEY = 'mattimer_spotify_enabled';  // '1' | '0'
  const OPTS_KEY    = 'mattimer_spotify_opts';      // {pauseRest, pauseEnd, pauseManual}

  const SS_VERIFIER = 'mattimer_spotify_verifier';
  const SS_STATE    = 'mattimer_spotify_state';
  const SS_RETURN   = 'mattimer_spotify_return';

  const DEFAULT_OPTS = { pauseRest: true, pauseEnd: true, pauseManual: true };

  let premiumOk = true;   // flips false on a 403 (non-Premium); stops hammering
  let statusText = '';    // human-readable status for the settings UI

  const clientId    = () => window.SPOTIFY_CLIENT_ID || '';
  const redirectUri = () => location.origin + '/';

  // ─── crypto helpers (PKCE) ──────────────────────────────────────────
  function base64url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomVerifier() {
    return base64url(crypto.getRandomValues(new Uint8Array(32))); // 43 chars
  }
  async function challengeFor(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64url(new Uint8Array(digest));
  }

  // ─── token storage ──────────────────────────────────────────────────
  function getTokens() {
    try { return JSON.parse(localStorage.getItem(TOKENS_KEY)) || null; }
    catch { return null; }
  }
  function setTokens(t) { localStorage.setItem(TOKENS_KEY, JSON.stringify(t)); }
  function clearTokens() {
    localStorage.removeItem(TOKENS_KEY);
    localStorage.removeItem(ENABLED_KEY);
  }
  function connected() { return !!(getTokens() && getTokens().refresh_token); }

  function getOpts() {
    try { return Object.assign({}, DEFAULT_OPTS, JSON.parse(localStorage.getItem(OPTS_KEY)) || {}); }
    catch { return Object.assign({}, DEFAULT_OPTS); }
  }
  function enabled() { return connected() && localStorage.getItem(ENABLED_KEY) === '1'; }

  // ─── OAuth: connect ─────────────────────────────────────────────────
  async function connect() {
    if (!clientId()) {
      try { window.toast && window.toast('Spotify is not configured (missing Client ID)'); } catch {}
      return;
    }
    const verifier  = randomVerifier();
    const challenge = await challengeFor(verifier);
    const state     = base64url(crypto.getRandomValues(new Uint8Array(12)));
    sessionStorage.setItem(SS_VERIFIER, verifier);
    sessionStorage.setItem(SS_STATE, state);
    sessionStorage.setItem(SS_RETURN, location.href); // restore room/session after redirect
    const p = new URLSearchParams({
      client_id: clientId(),
      response_type: 'code',
      redirect_uri: redirectUri(),
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
    });
    location.assign(AUTH_URL + '?' + p.toString());
  }

  // ─── OAuth: handle redirect back from Spotify ───────────────────────
  // Runs at load. The synchronous part (URL restore) completes before app.js
  // parses ?room=, so the coach lands back in their session. Token exchange is
  // async and happens after.
  function handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code  = params.get('code');
    const err   = params.get('error');
    const got   = params.get('state');
    const want  = sessionStorage.getItem(SS_STATE);
    if (!want || (!code && !err)) return;           // not our redirect

    const verifier  = sessionStorage.getItem(SS_VERIFIER);
    const returnUrl = sessionStorage.getItem(SS_RETURN) || (location.origin + '/');
    sessionStorage.removeItem(SS_VERIFIER);
    sessionStorage.removeItem(SS_STATE);
    sessionStorage.removeItem(SS_RETURN);
    // Restore the pre-auth URL (drops ?code/?state, keeps ?room=) BEFORE app.js runs.
    try { history.replaceState({}, '', returnUrl); } catch {}

    if (err) { console.warn('[spotify] auth error:', err); return; }
    if (got !== want) { console.warn('[spotify] state mismatch'); return; }
    if (!code || !verifier) return;
    exchangeCode(code, verifier);                   // fire-and-forget
  }

  async function exchangeCode(code, verifier) {
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        client_id: clientId(),
        code_verifier: verifier,
      });
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) { console.warn('[spotify] token exchange failed', res.status); return; }
      storeTokenResponse(await res.json());
      localStorage.setItem(ENABLED_KEY, '1');       // enabled by default on connect
      premiumOk = true;
      try { window.toast && window.toast('Spotify connected'); } catch {}
      refreshUi();
    } catch (e) { console.warn('[spotify] token exchange error', e); }
  }

  function storeTokenResponse(data, prev) {
    setTokens({
      access_token:  data.access_token,
      // Spotify rotates refresh tokens — keep the new one when present.
      refresh_token: data.refresh_token || (prev && prev.refresh_token),
      expires_at:    Date.now() + (data.expires_in || 3600) * 1000 - 60000,
    });
  }

  // ─── token refresh ──────────────────────────────────────────────────
  async function getValidAccessToken() {
    const t = getTokens();
    if (!t || !t.refresh_token) return null;
    if (Date.now() < t.expires_at && t.access_token) return t.access_token;
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: t.refresh_token,
          client_id: clientId(),
        }),
      });
      if (!res.ok) { clearTokens(); refreshUi(); return null; }
      storeTokenResponse(await res.json(), t);
      return getTokens().access_token;
    } catch (e) { console.warn('[spotify] refresh error', e); return null; }
  }

  // ─── Web API call (never throws) ────────────────────────────────────
  async function apiCall(method, path) {
    const token = await getValidAccessToken();
    if (!token) return null;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(API_BASE + path, {
        method,
        headers: { Authorization: 'Bearer ' + token },
        signal: ctrl.signal,
      });
      if (res.status === 403) { premiumOk = false; statusText = 'Spotify Premium required'; refreshUi(); }
      else if (res.status === 404 || res.status === 204) {
        // 204 from GET /me/player, or 404 NO_ACTIVE_DEVICE — nothing to control.
        if (method === 'GET') statusText = 'No active device — start playback in Spotify';
      }
      return res;
    } catch (e) { console.warn('[spotify] api', method, path, 'failed', e.name); return null; }
    finally { clearTimeout(to); }
  }

  async function pause()  { if (enabled() && premiumOk) await apiCall('PUT', '/me/player/pause'); }
  async function resume() { if (enabled() && premiumOk) await apiCall('PUT', '/me/player/play');  }

  // ─── settings UI ────────────────────────────────────────────────────
  function setEnabled(on) { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); refreshUi(); }
  function saveOpts() {
    const o = {
      pauseRest:   document.getElementById('spotifyPauseRestToggle')?.checked ?? true,
      pauseEnd:    document.getElementById('spotifyPauseEndToggle')?.checked ?? true,
      pauseManual: document.getElementById('spotifyPauseManualToggle')?.checked ?? true,
    };
    localStorage.setItem(OPTS_KEY, JSON.stringify(o));
  }
  function disconnect() { clearTokens(); premiumOk = true; statusText = ''; refreshUi(); }

  function refreshUi() {
    const wrap = document.getElementById('spotifyField');
    if (!wrap) return;
    const isConn = connected();
    const setShown = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none'; };
    setShown('spotifyConnectBtn', !isConn);
    setShown('spotifyConnected', isConn);
    if (isConn) {
      const enToggle = document.getElementById('spotifyEnableToggle');
      if (enToggle) enToggle.checked = enabled();
      const o = getOpts();
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
      set('spotifyPauseRestToggle', o.pauseRest);
      set('spotifyPauseEndToggle', o.pauseEnd);
      set('spotifyPauseManualToggle', o.pauseManual);
      const st = document.getElementById('spotifyStatus');
      if (st) st.textContent = statusText || 'Connected';
    }
  }

  // Probe the active device so the settings status line is informative.
  async function probeDevice() {
    if (!connected()) return;
    const res = await apiCall('GET', '/me/player');
    if (res && res.status === 200) {
      try {
        const j = await res.json();
        statusText = j && j.device ? ('Active: ' + j.device.name) : 'No active device — start playback in Spotify';
      } catch { statusText = 'Connected'; }
    } else if (res && res.status === 204) {
      statusText = 'No active device — start playback in Spotify';
    }
    refreshUi();
  }

  // ─── public surface ─────────────────────────────────────────────────
  window.spotifyConnect    = connect;
  window.spotifyDisconnect = disconnect;
  window.spotifyEnabled    = enabled;
  window.spotifyConnected  = connected;
  window.spotifyOpts       = getOpts;
  window.spotifyPause      = pause;
  window.spotifyResume     = resume;
  window.spotifySetEnabled = setEnabled;
  window.spotifySaveOpts   = saveOpts;
  window.spotifyRefreshUi  = function () { refreshUi(); probeDevice(); };

  handleRedirect();
})();
