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
    // Mat-centric model: a Mat (1-4) has one timer, one controlling coach, and
    // any TVs pinned to that mat's code. In-memory bindings reset on
    // hibernation and rebuild on reconnect; timerStates persist in storage.
    this.controllers  = {};                                    // connId -> { slot, color, name, clientId, ... }
    this.ctrlSlots    = { 1: null, 2: null, 3: null, 4: null }; // mat -> controlling connId
    this.ctrlNames    = { 1: '',   2: '',   3: '',   4: ''   }; // mat -> controlling coach name
    this.matClientId  = { 1: null, 2: null, 3: null, 4: null }; // mat -> clientId that last held it (for reclaim detection)
    this.config = null;
    this.timerStates  = { 1: null, 2: null, 3: null, 4: null }; // mat -> server-owned timer
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
    // Load persisted timer states (survive DO hibernation)
    for (let i = 1; i <= 4; i++) {
      const ts = await this.room.storage.get('timerState:' + i);
      if (ts) this.timerStates[i] = ts;
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
      // Controllers drive a mat's timer, so they must be authed; TVs/displays
      // are receive-only (a TV additionally proves its mat code).
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
      const authSub   = auth?.sub || null;

      // The coach explicitly chose which mat (1-4) to run.
      const mat = parseInt(url.searchParams.get('mat'), 10);
      if (!(mat >= 1 && mat <= 4)) {
        connection.send(JSON.stringify({ type: 'error', msg: 'No mat selected' }));
        connection.close();
        return;
      }

      // Sweep dead controller bindings left by crashes/hibernation.
      const liveIds = new Set([...this.room.getConnections('controller')].map(c => c.id));
      for (let i = 1; i <= 4; i++) {
        if (this.ctrlSlots[i] && !liveIds.has(this.ctrlSlots[i])) this._freeCtrlSlot(i);
      }

      // Is this the same device reclaiming the mat it last held (e.g. a phone
      // that slept and reconnected, even after its old socket fully closed)?
      const reclaim = !!(clientId && this.matClientId[mat] === clientId);

      // Take over the mat if another connection holds it. A reclaim is silent; a
      // genuinely different device gets a 'replaced' notice so it stops and
      // doesn't fight back.
      const prevId = this.ctrlSlots[mat];
      if (prevId && prevId !== connection.id) {
        const old = [...this.room.getConnections('controller')].find(c => c.id === prevId);
        if (old) {
          if (!reclaim) { try { old.send(JSON.stringify({ type: 'replaced' })); } catch {} }
          try { old.close(); } catch {}
        }
        this._freeCtrlSlot(mat);
      }

      // Timer state: a coach reclaiming their own mat keeps it exactly where it
      // was (sleep/resume, paused or running); a live round survives a takeover so
      // it isn't cut off mid-class; but a fresh coach on an idle mat starts clean
      // rather than inheriting a stale leftover time from an earlier class.
      const existing = this.timerStates[mat];
      if (!existing || (!reclaim && !existing.running)) {
        this.timerStates[mat] = this._newTimerState();
      }
      this.matClientId[mat] = clientId;

      const ctrlColor = color || CTRL_COLORS[mat];
      this.controllers[connection.id] = { slot: mat, color: ctrlColor, name, profileId, authSub, clientId, connectedAt: Date.now(), userRole: auth?.role || null };
      this.ctrlSlots[mat] = connection.id;
      this.ctrlNames[mat] = name;
      connection.setState({ role: 'controller', slot: mat });

      connection.send(JSON.stringify({
        type:       'config',
        tvCodes:    this.config.tvCodes,
        profiles:   this._safeProfiles(),
        branding:   this.config.branding,
        ctrlSlot:   mat, ctrlColor, ctrlName: name,
        timerState: this._computeCurrentState(mat),
      }));
      // Push the controlling coach's color/name and live timer to this mat's TV(s).
      this._sendToTv(mat, JSON.stringify({ type: 'ctrl:color', color: ctrlColor, name }));
      const cur = this._computeCurrentState(mat);
      if (cur) this._sendToTv(mat, JSON.stringify({ type: 'state', ...cur }));
      this._broadcastMatStatus();

    } else if (role === 'tv') {
      const code   = (url.searchParams.get('code') || '').toUpperCase();
      const idx    = this.config.tvCodes.indexOf(code);
      if (idx === -1) {
        connection.send(JSON.stringify({ type: 'error', msg: 'Invalid TV code: ' + code }));
        connection.close();
        return;
      }
      const mat = idx + 1; // a TV is permanently pinned to one mat by its code
      // Replace any stale TV connection still bound to this mat.
      for (const c of this.room.getConnections('tv')) {
        if (c.id !== connection.id && c.state?.tvSlot === mat) { try { c.close(); } catch {} }
      }
      connection.setState({ role: 'tv', tvSlot: mat });
      connection.send(JSON.stringify({ type: 'branding', ...this.config.branding }));
      // Always reflect the mat's current controlling coach + live timer on connect.
      const ctrl = this.ctrlSlots[mat] ? this.controllers[this.ctrlSlots[mat]] : null;
      connection.send(JSON.stringify({
        type:  'ctrl:color',
        color: ctrl ? (ctrl.color || CTRL_COLORS[mat]) : null,
        name:  ctrl ? (this.ctrlNames[mat] || null) : null,
      }));
      const current = this._computeCurrentState(mat);
      if (current) connection.send(JSON.stringify({ type: 'state', ...current }));
      this._broadcastMatStatus();

    } else {
      // Plain viewer (no mat code) — receive-only, just gets branding.
      connection.setState({ role: 'display' });
      connection.send(JSON.stringify({ type: 'branding', ...this.config.branding }));
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
        // Only free the mat if this connection still holds it — a takeover may
        // have already rebound the slot to a newer connection.
        if (this.ctrlSlots[slot] === connection.id) this._freeCtrlSlot(slot);
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
    }
    this._broadcastMatStatus();
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
        // Update this mat's TV(s) with the new class name.
        this._sendToTv(ctrl.slot, JSON.stringify({ type: 'ctrl:color', color: ctrl.color, name: this.ctrlNames[ctrl.slot] }));
        this._broadcastMatStatus();
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

    // GET /api/mats — per-mat occupancy for the mat picker
    if (req.method === 'GET' && apiPath === '/api/mats') {
      return Response.json({ mats: this._buildMatStatus() }, { headers: cors });
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

  // Release a mat's controller binding. Timer state is intentionally left
  // intact so a reconnecting/next coach picks up where it left off; the mat's
  // TV is told the mat is now uncontrolled.
  _freeCtrlSlot(slot) {
    const occupantId = this.ctrlSlots[slot];
    if (!occupantId) return;
    delete this.controllers[occupantId];
    this.ctrlSlots[slot] = null;
    this.ctrlNames[slot] = '';
    this._sendToTv(slot, JSON.stringify({ type: 'ctrl:color', color: null, name: null }));
  }

  // Send a message to every TV pinned to the given mat.
  _sendToTv(mat, msg) {
    for (const conn of this.room.getConnections('tv')) {
      if (conn.state?.tvSlot === mat) conn.send(msg);
    }
  }

  // Per-mat occupancy, broadcast to everyone (controllers + the mat picker)
  // so coaches can see which mats are open vs. in use.
  _broadcastMatStatus() {
    this.room.broadcast(JSON.stringify({ type: 'mat:status', mats: this._buildMatStatus() }));
  }

  _buildMatStatus() {
    const mats = {};
    for (let i = 1; i <= 4; i++) {
      const ctrl = this.ctrlSlots[i] ? this.controllers[this.ctrlSlots[i]] : null;
      mats[i] = ctrl
        ? { occupied: true, name: this.ctrlNames[i] || 'Coach', color: ctrl.color || CTRL_COLORS[i] }
        : { occupied: false };
    }
    return mats;
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

  // A mat's TV(s) are pinned by code, so broadcasting to a mat is just
  // targeting the TV(s) on that mat.
  _sendToTvs(mat, msg) {
    this._sendToTv(mat, msg);
  }

  _sendSoundToTvs(slot, soundType) {
    this._sendToTvs(slot, JSON.stringify({ type: 'sound', soundType }));
  }
}
