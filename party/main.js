// PartyKit server for BJJ Mat Timer
// Replaces src/server.js — runs on Cloudflare Durable Objects via partykit.io
// Each room = one gym, completely isolated from all other rooms.

const CTRL_COLORS = { 1: 'blue', 2: 'green', 3: 'amber', 4: 'pink' };
const PROFILE_COLORS = ['#3B82F6','#10B981','#F59E0B','#EC4899','#8B5CF6','#EF4444','#06B6D4','#F97316'];
const DEFAULT_SETTINGS = {
  roundDuration: 300, restDuration: 60, totalRounds: 10,
  warningEnabled: true, warningThreshold: 30, showRound: false,
};

import { makeCode } from '../lib/room-code';
import { verifyRoomToken } from '../lib/room-token';
import { hashPin, verifyPin } from '../lib/pin';

const PIN_MAX_FAILS   = 5;
const PIN_LOCKOUT_MS  = 5 * 60 * 1000;

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

export default class BjjTimerServer {
  constructor(room) {
    this.room = room;
    // In-memory session state — resets on hibernation, rebuilt on reconnect
    this.controllers  = {};
    this.ctrlSlots    = { 1: null, 2: null, 3: null, 4: null };
    this.ctrlNames    = { 1: '',   2: '',   3: '',   4: ''   };
    this.tvOwner      = { 1: null, 2: null, 3: null, 4: null };
    this.tvDisplays   = { 1: 0,   2: 0,   3: 0,   4: 0    };
    this.floatingCount = 0;
    this.config = null;
    this.timerStates   = { 1: null, 2: null, 3: null, 4: null }; // server-owned timer per ctrl slot
    this.ctrlIdentities = { 1: null, 2: null, 3: null, 4: null }; // persists across disconnects for reconnect detection
    this._alarmPending = false; // track alarm so we don't double-schedule
  }

  async onStart() {
    this.config = await this.room.storage.get('config');
    if (!this.config) {
      this.config = {
        tvCodes:  [makeCode(), makeCode(), makeCode(), makeCode()],
        profiles: [],
        branding: { appName: 'BJJ Mat Timer', tagline: 'Competition · Training · Sparring', logoDataUrl: '' },
      };
      await this.room.storage.put('config', this.config);
    } else {
      let changed = false;
      while (this.config.tvCodes.length < 4) { this.config.tvCodes.push(makeCode()); changed = true; }
      if (!this.config.profiles) { this.config.profiles = []; changed = true; }
      // One-time migration: hash any profile PINs stored in plaintext
      for (const p of this.config.profiles) {
        if (!('pin' in p)) continue;
        if (p.pin) Object.assign(p, await hashPin(p.pin));
        delete p.pin;
        changed = true;
      }
      if (!this.config.branding) { this.config.branding = { appName: 'BJJ Mat Timer', tagline: 'Competition · Training · Sparring', logoDataUrl: '' }; changed = true; }
      if (changed) await this.room.storage.put('config', this.config);
    }
    // Load persisted timer states and controller identities (survive DO hibernation)
    for (let i = 1; i <= 4; i++) {
      const ts = await this.room.storage.get('timerState:' + i);
      if (ts) this.timerStates[i] = ts;
      const id = await this.room.storage.get('ctrlIdentity:' + i);
      if (id) this.ctrlIdentities[i] = id;
    }
    // Ensure alarm is running for any timers recovered from storage
    if (this._hasAnyRunning()) await this._scheduleAlarm();
  }

  getConnectionTags(connection, ctx) {
    const role = new URL(ctx.request.url).searchParams.get('role') || 'display';
    return [role];
  }

  // The demo room is intentionally open — everything else requires a token
  // minted by /api/room-token once REQUIRE_AUTH is enabled.
  get _isDemo() { return this.room.id.toLowerCase() === 'demo'; }
  get _authRequired() { return String(this.room.env.REQUIRE_AUTH) === '1'; }

  // Returns the token payload ({ room, role, sub, exp }) or null.
  async _checkAuth(token) {
    const secret = this.room.env.PARTY_AUTH_SECRET;
    if (!secret || !token) return null;
    return verifyRoomToken(token, String(secret), this.room.id.toUpperCase());
  }

  async onConnect(connection, ctx) {
    if (!this.config) await this.onStart();
    const url  = new URL(ctx.request.url);
    const role = url.searchParams.get('role') || 'display';

    if (role === 'controller') {
      // Displays and TVs are receive-only (TVs additionally prove a tvCode);
      // controllers can drive timers on every claimed TV, so they must be authed.
      let auth = null;
      if (!this._isDemo) {
        auth = await this._checkAuth(url.searchParams.get('token'));
        if (!auth) {
          if (this._authRequired) {
            connection.send(JSON.stringify({ type: 'error', code: 'auth', msg: 'Not authorized for this room — please sign in again' }));
            connection.close();
            return;
          }
          console.log(`[auth warn-only] room ${this.room.id}: controller connect without valid token`);
        }
      }
      const name      = decodeURIComponent(url.searchParams.get('name') || 'Unnamed Class');
      const color     = url.searchParams.get('color') || null;
      const profileId = url.searchParams.get('profileId') || null;
      const clientId  = url.searchParams.get('clientId')  || null;

      const authSub = auth?.sub || null;

      // Identity takeover: check ctrlIdentities first (persists across disconnects and
      // hibernation) so a reconnecting coach reclaims their slot even if the old
      // WebSocket already closed before this connect arrived.
      let isTakeover = false;
      let takeoverSlot = null;
      for (let i = 1; i <= 4; i++) {
        const id = this.ctrlIdentities[i];
        if (!id) continue;
        if ((authSub && id.authSub === authSub) ||
            (profileId && id.profileId === profileId) ||
            (clientId && id.clientId === clientId)) {
          if (this.ctrlSlots[i]) {
            const old = [...this.room.getConnections('controller')].find(c => c.id === this.ctrlSlots[i]);
            if (old) old.close();
            this._freeCtrlSlot(i);
          }
          isTakeover = true;
          takeoverSlot = i;
          break;
        }
      }

      // Sweep dead connections (crash / hibernation wakeup) — after takeover check.
      const liveIds = new Set([...this.room.getConnections('controller')].map(c => c.id));
      for (let i = 1; i <= 4; i++) {
        if (this.ctrlSlots[i] && !liveIds.has(this.ctrlSlots[i])) this._freeCtrlSlot(i);
      }

      // Takeover: reclaim the exact same slot so the timer state is preserved.
      const slot = (takeoverSlot && !this.ctrlSlots[takeoverSlot])
        ? takeoverSlot
        : this._nextFreeCtrlSlot();

      if (!slot) {
        connection.send(JSON.stringify({ type: 'error', msg: 'All 4 controller slots are full' }));
        connection.close();
        return;
      }
      // Fresh controller gets a clean timer state; reconnecting controller keeps theirs
      if (!isTakeover || !this.timerStates[slot]) {
        this.timerStates[slot] = this._newTimerState();
      }
      // Persist identity so reconnect detection survives DO hibernation
      this.ctrlIdentities[slot] = { authSub, profileId, clientId };
      await this.room.storage.put('ctrlIdentity:' + slot, { authSub, profileId, clientId });
      const ctrlColor = color || CTRL_COLORS[slot];
      this.controllers[connection.id] = { slot, color: ctrlColor, name, profileId, authSub, clientId, connectedAt: Date.now(), userRole: auth?.role || null };
      this.ctrlSlots[slot] = connection.id;
      this.ctrlNames[slot] = name;
      connection.setState({ role: 'controller', slot });

      connection.send(JSON.stringify({
        type:       'config',
        tvCodes:    this.config.tvCodes,
        profiles:   this._safeProfiles(),
        branding:   this.config.branding,
        ctrlSlot:   slot, ctrlColor, ctrlName: name,
        timerState: this._computeCurrentState(slot),
      }));
      connection.send(JSON.stringify({ type: 'monitor:status', ...this._buildMonitorStatus() }));
      this._broadcastMonitorStatus();

    } else if (role === 'tv') {
      const code   = (url.searchParams.get('code') || '').toUpperCase();
      const idx    = this.config.tvCodes.indexOf(code);
      if (idx === -1) {
        connection.send(JSON.stringify({ type: 'error', msg: 'Invalid TV code: ' + code }));
        connection.close();
        return;
      }
      const tvSlot = idx + 1;
      // Close any existing connection on this slot (stale after hibernation, or same
      // device reconnecting). onClose will decrement tvDisplays for the old connection.
      for (const c of this.room.getConnections('tv')) {
        if (c.state?.tvSlot === tvSlot) c.close();
      }
      connection.setState({ role: 'tv', tvSlot });
      this.tvDisplays[tvSlot]++;
      connection.send(JSON.stringify({ type: 'branding', ...this.config.branding }));
      const ownerSlot = this.tvOwner[tvSlot];
      connection.send(JSON.stringify({
        type:  'ctrl:color',
        color: ownerSlot ? CTRL_COLORS[ownerSlot] : null,
        name:  ownerSlot ? (this.ctrlNames[ownerSlot] || null) : null,
      }));
      // Send current state (computed live from server timer) so TV is immediately accurate
      if (ownerSlot) {
        const current = this._computeCurrentState(ownerSlot);
        if (current) connection.send(JSON.stringify({ type: 'state', ...current }));
      }
      this._broadcastMonitorStatus();

    } else {
      connection.setState({ role: 'display' });
      this.floatingCount++;
      connection.send(JSON.stringify({ type: 'branding', ...this.config.branding }));
      this._broadcastMonitorStatus();
    }
  }

  onClose(connection) {
    const st = connection.state;
    if (!st) return;

    if (st.role === 'controller') {
      const ctrl = this.controllers[connection.id];
      if (ctrl) {
        const { slot } = ctrl;
        const duration = Math.round((Date.now() - (ctrl.connectedAt || Date.now())) / 1000);
        this._freeCtrlSlot(slot);
        // Platform-admin visits aren't real classes — keep them out of Recent activity
        if (duration > 30 && ctrl.userRole !== 'admin') {
          (async () => {
            const sessions = (await this.room.storage.get('sessions')) || [];
            sessions.push({ date: new Date(ctrl.connectedAt).toISOString(), name: ctrl.name, slot, duration });
            if (sessions.length > 100) sessions.splice(0, sessions.length - 100);
            await this.room.storage.put('sessions', sessions);
          })();
        }
      }
    } else if (st.role === 'tv') {
      if (st.tvSlot) this.tvDisplays[st.tvSlot] = Math.max(0, this.tvDisplays[st.tvSlot] - 1);
    } else if (st.role === 'display') {
      this.floatingCount = Math.max(0, this.floatingCount - 1);
    }
    this._broadcastMonitorStatus();
  }

  async onMessage(message, sender) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const ctrl = this.controllers[sender.id];

    switch (msg.type) {

      case 'ctrl:rename': {
        if (!ctrl) return;
        this.ctrlNames[ctrl.slot] = msg.name || 'Unnamed Class';
        this.controllers[sender.id].name = this.ctrlNames[ctrl.slot];
        for (let tv = 1; tv <= 4; tv++) {
          if (this.tvOwner[tv] === ctrl.slot)
            this._sendToTv(tv, JSON.stringify({ type: 'ctrl:color', color: ctrl.color, name: this.ctrlNames[ctrl.slot] }));
        }
        this._broadcastMonitorStatus();
        break;
      }

      case 'profile:save': {
        if (!ctrl) return;
        const profile = this.config.profiles.find(p => p.id === msg.profileId);
        if (profile) {
          profile.settings = { ...profile.settings, ...msg.settings };
          this.room.storage.put('config', this.config);
        }
        break;
      }

      case 'tv:claim': {
        if (!ctrl || msg.tvSlot < 1 || msg.tvSlot > 4) return;
        this.tvOwner[msg.tvSlot] = ctrl.slot;
        this._sendToTv(msg.tvSlot, JSON.stringify({ type: 'ctrl:color', color: ctrl.color, name: this.ctrlNames[ctrl.slot] }));
        // Send live timer state so TV is immediately accurate
        const tvState = this._computeCurrentState(ctrl.slot);
        if (tvState) this._sendToTv(msg.tvSlot, JSON.stringify({ type: 'state', ...tvState }));
        this._broadcastMonitorStatus();
        break;
      }

      case 'tv:release': {
        if (!ctrl || this.tvOwner[msg.tvSlot] !== ctrl.slot) return;
        this.tvOwner[msg.tvSlot] = null;
        this._sendToTv(msg.tvSlot, JSON.stringify({ type: 'ctrl:color', color: null, name: null }));
        this._broadcastMonitorStatus();
        break;
      }

      // Overlay, tab, and stopwatch messages are still forwarded from the controller
      case 'overlay':
      case 'tab':
      case 'sw:state': {
        if (!ctrl) return;
        this._sendToTvs(ctrl.slot, JSON.stringify(msg));
        break;
      }

      case 'timer:start': {
        if (!ctrl) return;
        const ts = this.timerStates[ctrl.slot] || (this.timerStates[ctrl.slot] = this._newTimerState());
        if (ts.running) return;
        ts.running = true; ts.startedAt = Date.now(); ts.timeRemainingAtStart = ts.timeRemaining;
        this._broadcastTimerState(ctrl.slot);
        this._sendSoundToTvs(ctrl.slot, 'start');
        await this.room.storage.put('timerState:' + ctrl.slot, ts);
        await this._scheduleAlarm();
        break;
      }

      case 'timer:pause': {
        if (!ctrl) return;
        const ts = this.timerStates[ctrl.slot];
        if (!ts?.running) return;
        const elapsed = Math.floor((Date.now() - ts.startedAt) / 1000);
        ts.timeRemaining = Math.max(0, ts.timeRemainingAtStart - elapsed);
        ts.running = false; ts.startedAt = null; ts.timeRemainingAtStart = 0;
        this._broadcastTimerState(ctrl.slot);
        await this.room.storage.put('timerState:' + ctrl.slot, ts);
        break;
      }

      case 'timer:reset': {
        if (!ctrl) return;
        const ts = this.timerStates[ctrl.slot];
        if (!ts) return;
        ts.running = false; ts.currentRound = 1; ts.phase = 'fight';
        ts.timeRemaining = ts.roundDuration; ts.startedAt = null; ts.timeRemainingAtStart = 0;
        this._broadcastTimerState(ctrl.slot);
        this._sendToTvs(ctrl.slot, JSON.stringify({ type: 'overlay', msg: '' }));
        await this.room.storage.put('timerState:' + ctrl.slot, ts);
        break;
      }

      case 'timer:nextRound': {
        if (!ctrl) return;
        const ts = this.timerStates[ctrl.slot];
        if (!ts) return;
        ts.running = false; ts.startedAt = null; ts.timeRemainingAtStart = 0;
        if (ts.currentRound < ts.totalRounds) ts.currentRound++;
        ts.phase = 'fight'; ts.timeRemaining = ts.roundDuration;
        this._broadcastTimerState(ctrl.slot);
        await this.room.storage.put('timerState:' + ctrl.slot, ts);
        break;
      }

      case 'timer:config': {
        if (!ctrl) return;
        const ts = this.timerStates[ctrl.slot] || (this.timerStates[ctrl.slot] = this._newTimerState());
        const allowed = ['roundDuration','restDuration','totalRounds','warningEnabled','warningThreshold','showRound'];
        for (const k of allowed) { if (msg[k] !== undefined) ts[k] = msg[k]; }
        if (!ts.running) {
          // Clamp paused position if roundDuration shrank below it; never unconditionally reset
          if (ts.timeRemaining > ts.roundDuration) ts.timeRemaining = ts.roundDuration;
          ts.startedAt = null; ts.timeRemainingAtStart = 0;
        }
        this._broadcastTimerState(ctrl.slot);
        await this.room.storage.put('timerState:' + ctrl.slot, ts);
        break;
      }

      case 'audio:clear': {
        this.room.broadcast(JSON.stringify(msg), [sender.id]);
        break;
      }
    }
  }

  async onRequest(req) {
    const url      = new URL(req.url);
    const segments = url.pathname.split('/').filter(Boolean);
    // URL format: /parties/main/ROOMID/api/...
    // segments:   ['parties', 'main', 'ROOMID', 'api', ...]
    const apiPath  = '/' + segments.slice(3).join('/');

    // Origin allowlist via ALLOWED_ORIGINS var (comma-separated); '*' if unset.
    const allowedOrigins = String(this.room.env.ALLOWED_ORIGINS || '*');
    const origin = req.headers.get('origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowedOrigins === '*'
        ? '*'
        : (allowedOrigins.split(',').map(s => s.trim()).includes(origin) ? origin : 'null'),
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Filename,Authorization',
      'Vary': 'Origin',
    };

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!this.config) await this.onStart();

    // Room REST is controller/owner surface — require a room token outside demo.
    let auth = null;
    if (!this._isDemo) {
      const bearer = (req.headers.get('authorization') || '').replace('Bearer ', '');
      auth = await this._checkAuth(bearer);
      if (!auth) {
        if (this._authRequired) {
          return Response.json({ error: 'Not authorized' }, { status: 401, headers: cors });
        }
        console.log(`[auth warn-only] room ${this.room.id}: ${req.method} ${apiPath} without valid token`);
      }
    }
    // Destructive routes are owner/admin only (once a token is present to say so)
    const destructive =
      (req.method === 'DELETE' && /^\/api\/profiles\/[^/]+$/.test(apiPath)) ||
      (req.method === 'POST' && apiPath === '/api/branding') ||
      (req.method === 'POST' && /^\/api\/tvCodes\/\d+\/regenerate$/.test(apiPath));
    if (destructive && auth && auth.role === 'coach') {
      return Response.json({ error: 'Owner access required' }, { status: 403, headers: cors });
    }

    // GET /api/sessions
    if (req.method === 'GET' && apiPath === '/api/sessions') {
      const sessions = (await this.room.storage.get('sessions')) || [];
      return Response.json({ sessions: sessions.slice(-20).reverse() }, { headers: cors });
    }

    // GET /api/config
    if (req.method === 'GET' && apiPath === '/api/config') {
      return Response.json({
        tvCodes:    this.config.tvCodes,
        branding:   this.config.branding,
        profiles:   this._safeProfiles(),
        audioSlots: {},
      }, { headers: cors });
    }

    // GET /api/profiles
    if (req.method === 'GET' && apiPath === '/api/profiles') {
      return Response.json(this._safeProfiles(), { headers: cors });
    }

    // POST /api/profiles
    if (req.method === 'POST' && apiPath === '/api/profiles') {
      const { name, pin, settings } = await req.json();
      if (!name?.trim()) return Response.json({ error: 'Name required' }, { status: 400, headers: cors });
      const usedColors = this.config.profiles.map(p => p.color);
      const color = PROFILE_COLORS.find(c => !usedColors.includes(c)) || PROFILE_COLORS[this.config.profiles.length % PROFILE_COLORS.length];
      const profile = { id: makeId(), name: name.trim(), color, settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } };
      if (pin) Object.assign(profile, await hashPin(pin));
      this.config.profiles.push(profile);
      await this.room.storage.put('config', this.config);
      this._broadcastProfilesUpdated();
      return Response.json({ ok: true, id: profile.id, color }, { headers: cors });
    }

    // Profile by ID
    const idMatch = apiPath.match(/^\/api\/profiles\/([^/]+)$/);
    if (idMatch) {
      if (req.method === 'PUT') {
        const body = await req.json();
        const profile = this.config.profiles.find(p => p.id === idMatch[1]);
        if (!profile) return Response.json({ error: 'Not found' }, { status: 404, headers: cors });
        if (body.name !== undefined) profile.name = body.name.trim() || profile.name;
        if (body.pin !== undefined) {
          delete profile.pinHash;
          delete profile.pinSalt;
          if (body.pin) Object.assign(profile, await hashPin(body.pin));
        }
        if (body.settings) profile.settings = { ...profile.settings, ...body.settings };
        await this.room.storage.put('config', this.config);
        this._broadcastProfilesUpdated();
        return Response.json({ ok: true }, { headers: cors });
      }
      if (req.method === 'DELETE') {
        const idx = this.config.profiles.findIndex(p => p.id === idMatch[1]);
        if (idx === -1) return Response.json({ error: 'Not found' }, { status: 404, headers: cors });
        this.config.profiles.splice(idx, 1);
        await this.room.storage.put('config', this.config);
        this._broadcastProfilesUpdated();
        return Response.json({ ok: true }, { headers: cors });
      }
    }

    // POST /api/profiles/:id/login
    const loginMatch = apiPath.match(/^\/api\/profiles\/([^/]+)\/login$/);
    if (req.method === 'POST' && loginMatch) {
      const { pin } = await req.json();
      const profile = this.config.profiles.find(p => p.id === loginMatch[1]);
      if (!profile) return Response.json({ error: 'Not found' }, { status: 404, headers: cors });

      if (profile.pinHash) {
        // Lockout after repeated failures — the real defense for 4-digit PINs
        const failKey = 'pinFails:' + profile.id;
        const fails = (await this.room.storage.get(failKey)) || { count: 0, lockedUntil: 0 };
        if (fails.lockedUntil > Date.now()) {
          const wait = Math.ceil((fails.lockedUntil - Date.now()) / 60000);
          return Response.json({ error: `Too many attempts — try again in ${wait} min` }, { status: 429, headers: cors });
        }
        if (!(await verifyPin(pin, profile.pinHash, profile.pinSalt))) {
          fails.count++;
          if (fails.count >= PIN_MAX_FAILS) {
            fails.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
            fails.count = 0;
          }
          await this.room.storage.put(failKey, fails);
          return Response.json({ error: 'Incorrect PIN' }, { status: 401, headers: cors });
        }
        await this.room.storage.delete(failKey);
      }

      const { pin: _pin, pinHash: _h, pinSalt: _s, ...safe } = profile;
      return Response.json({ ok: true, profile: safe }, { headers: cors });
    }

    // POST /api/branding
    if (req.method === 'POST' && apiPath === '/api/branding') {
      const { mdnsName, ...brandingFields } = await req.json();
      this.config.branding = { ...this.config.branding, ...brandingFields };
      await this.room.storage.put('config', this.config);
      this.room.broadcast(JSON.stringify({ type: 'branding', ...this.config.branding }));
      return Response.json({ ok: true }, { headers: cors });
    }

    // POST /api/tvCodes/:slot/regenerate
    const tvRegenMatch = apiPath.match(/^\/api\/tvCodes\/(\d+)\/regenerate$/);
    if (req.method === 'POST' && tvRegenMatch) {
      const idx = parseInt(tvRegenMatch[1]) - 1;
      if (idx < 0 || idx > 3) return Response.json({ error: 'Invalid slot' }, { status: 400, headers: cors });
      this.config.tvCodes[idx] = makeCode();
      await this.room.storage.put('config', this.config);
      this.room.broadcast(JSON.stringify({ type: 'tvCodes', tvCodes: this.config.tvCodes }));
      return Response.json({ ok: true, tvCodes: this.config.tvCodes }, { headers: cors });
    }

    // Audio — not supported in cloud mode; DELETE is a no-op so clear works
    if (apiPath.startsWith('/api/audio')) {
      if (req.method === 'DELETE') return Response.json({ ok: true }, { headers: cors });
      return Response.json({ ok: false, error: 'Audio upload not supported in cloud mode' }, { status: 501, headers: cors });
    }

    return new Response('Not found', { status: 404, headers: cors });
  }

  // ─── Private helpers ──────────────────────────────────────────────

  _nextFreeCtrlSlot() {
    for (let i = 1; i <= 4; i++) if (!this.ctrlSlots[i]) return i;
    return null;
  }

  _freeCtrlSlot(slot) {
    const occupantId = this.ctrlSlots[slot];
    if (!occupantId) return;
    delete this.controllers[occupantId];
    this.ctrlSlots[slot] = null;
    this.ctrlNames[slot] = '';
    for (let tv = 1; tv <= 4; tv++) {
      if (this.tvOwner[tv] === slot) {
        this.tvOwner[tv] = null;
        this._sendToTv(tv, JSON.stringify({ type: 'ctrl:color', color: null, name: null }));
      }
    }
  }

  _sendToTv(tvSlot, msg) {
    for (const conn of this.room.getConnections('tv')) {
      if (conn.state?.tvSlot === tvSlot) conn.send(msg);
    }
  }

  _broadcastMonitorStatus() {
    const status = JSON.stringify({ type: 'monitor:status', ...this._buildMonitorStatus() });
    for (const conn of this.room.getConnections('controller')) conn.send(status);
  }

  _buildMonitorStatus() {
    const tvDisplays = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const conn of this.room.getConnections('tv')) {
      const s = conn.state;
      if (s?.tvSlot >= 1 && s?.tvSlot <= 4) tvDisplays[s.tvSlot]++;
    }
    return {
      tvOwner:    { ...this.tvOwner },
      tvDisplays,
      floating:   this.floatingCount,
      ctrlNames:  { ...this.ctrlNames },
      ctrlSlots:  Object.fromEntries(
        [1,2,3,4].map(i => [i, this.ctrlSlots[i]
          ? { connected: true, color: this.controllers[this.ctrlSlots[i]]?.color || CTRL_COLORS[i], name: this.ctrlNames[i] }
          : null
        ])
      ),
    };
  }

  // Public view of profiles: never expose pin hash/salt (or legacy plaintext)
  _safeProfiles() {
    return this.config.profiles.map(({ pin, pinHash, pinSalt, ...p }) => ({ ...p, hasPin: !!(pinHash || pin) }));
  }

  _broadcastProfilesUpdated() {
    this.room.broadcast(JSON.stringify({ type: 'profiles:updated', profiles: this._safeProfiles() }));
  }

  // ─── Server-side timer ───────────────────────────────────────────

  async alarm() {
    this._alarmPending = false;
    const now = Date.now();
    for (let slot = 1; slot <= 4; slot++) {
      // Recover in-memory state after DO hibernation
      if (!this.timerStates[slot]) {
        const saved = await this.room.storage.get('timerState:' + slot);
        if (saved) this.timerStates[slot] = saved;
      }
      const ts = this.timerStates[slot];
      if (!ts?.running || !ts.startedAt) continue;
      const elapsed = Math.floor((now - ts.startedAt) / 1000);
      ts.timeRemaining = ts.timeRemainingAtStart - elapsed;
      if (ts.timeRemaining <= 0) {
        await this._handlePhaseEnd(slot);
      } else {
        if (ts.phase === 'fight' && ts.timeRemaining <= 10) {
          this._sendSoundToTvs(slot, ts.timeRemaining <= 3 ? 'accent' : 'beep');
        }
        this._broadcastTimerState(slot);
      }
    }
    if (this._hasAnyRunning()) {
      this._alarmPending = true;
      await this.room.storage.setAlarm(Date.now() + 1000);
    }
  }

  _hasAnyRunning() {
    for (let i = 1; i <= 4; i++) { if (this.timerStates[i]?.running) return true; }
    return false;
  }

  async _scheduleAlarm() {
    if (this._alarmPending) return;
    this._alarmPending = true;
    await this.room.storage.setAlarm(Date.now() + 1000);
  }

  _newTimerState() {
    return {
      running: false, phase: 'fight', currentRound: 1,
      roundDuration: 300, restDuration: 60, totalRounds: 10,
      timeRemaining: 300, warningEnabled: true, warningThreshold: 30,
      showRound: false, startedAt: null, timeRemainingAtStart: 0,
    };
  }

  _computeCurrentState(slot) {
    const ts = this.timerStates[slot];
    if (!ts) return null;
    const { startedAt, timeRemainingAtStart, ...s } = ts;
    if (ts.running && startedAt) {
      s.timeRemaining = Math.max(0, timeRemainingAtStart - Math.floor((Date.now() - startedAt) / 1000));
    }
    return s;
  }

  async _handlePhaseEnd(slot) {
    const ts = this.timerStates[slot];
    if (!ts) return;
    if (ts.phase === 'fight') {
      this._sendSoundToTvs(slot, 'buzzer');
      if (ts.currentRound >= ts.totalRounds) {
        ts.running = false; ts.timeRemaining = 0; ts.startedAt = null; ts.timeRemainingAtStart = 0;
        this._sendToTvs(slot, JSON.stringify({ type: 'overlay', msg: 'TIME!' }));
        this._broadcastTimerState(slot);
        await this.room.storage.delete('timerState:' + slot);
      } else if (ts.restDuration > 0) {
        ts.phase = 'rest'; ts.timeRemaining = ts.restDuration;
        ts.startedAt = Date.now(); ts.timeRemainingAtStart = ts.restDuration;
        this._sendSoundToTvs(slot, 'rest');
        this._sendToTvs(slot, JSON.stringify({ type: 'overlay', msg: 'REST' }));
        this._broadcastTimerState(slot);
        await this.room.storage.put('timerState:' + slot, ts);
      } else {
        ts.currentRound++; ts.phase = 'fight'; ts.timeRemaining = ts.roundDuration;
        ts.startedAt = Date.now(); ts.timeRemainingAtStart = ts.roundDuration;
        this._sendSoundToTvs(slot, 'start');
        this._sendToTvs(slot, JSON.stringify({ type: 'overlay', msg: 'FIGHT!' }));
        this._broadcastTimerState(slot);
        await this.room.storage.put('timerState:' + slot, ts);
      }
    } else {
      // Rest phase ended — start next fight round
      ts.currentRound++; ts.phase = 'fight'; ts.timeRemaining = ts.roundDuration;
      ts.startedAt = Date.now(); ts.timeRemainingAtStart = ts.roundDuration;
      this._sendSoundToTvs(slot, 'start');
      this._sendToTvs(slot, JSON.stringify({ type: 'overlay', msg: 'FIGHT!' }));
      this._broadcastTimerState(slot);
      await this.room.storage.put('timerState:' + slot, ts);
    }
  }

  _broadcastTimerState(slot) {
    const current = this._computeCurrentState(slot);
    if (!current) return;
    const msg = JSON.stringify({ type: 'state', ...current });
    this._sendToTvs(slot, msg);
    this._sendToCtrl(slot, msg);
  }

  _sendToCtrl(slot, msg) {
    const connId = this.ctrlSlots[slot];
    if (!connId) return;
    for (const conn of this.room.getConnections('controller')) {
      if (conn.id === connId) { conn.send(msg); return; }
    }
  }

  _sendToTvs(slot, msg) {
    for (let tv = 1; tv <= 4; tv++) {
      if (this.tvOwner[tv] === slot) this._sendToTv(tv, msg);
    }
  }

  _sendSoundToTvs(slot, soundType) {
    this._sendToTvs(slot, JSON.stringify({ type: 'sound', soundType }));
  }
}
