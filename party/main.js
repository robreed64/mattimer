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
    // primary mat -> timestamp (ms) after which, with no controller and no
    // running timer, the TV returns to the idle clock. Lets an in-progress mat
    // keep its TV alive across an iOS-sleep disconnect without stranding it.
    this.idleSweepAt  = { 1: 0, 2: 0, 3: 0, 4: 0 };
  }

  // How long a paused-but-abandoned class keeps its TV before falling back to
  // the idle clock, and the short grace after a running timer ends so the TV
  // can show "TIME!" before going idle.
  static get IDLE_GRACE_MS()    { return 5 * 60 * 1000; }
  static get END_IDLE_DELAY_MS(){ return 5 * 1000; }

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
    // Load persisted timer states (survive DO hibernation). Sanitize orphans:
    // a "running" timer recovered with no time left is leftover from a restart
    // or an abandoned class — reset it so TVs don't get stuck on a flashing 0:00.
    for (let i = 1; i <= 4; i++) {
      const ts = await this.room.storage.get('timerState:' + i);
      if (!ts) continue;
      if (ts.running && ts.startedAt && (ts.timeRemainingAtStart - Math.floor((Date.now() - ts.startedAt) / 1000)) <= 0) {
        await this.room.storage.delete('timerState:' + i);
      } else {
        this.timerStates[i] = ts;
      }
    }
    // Recover any pending idle-clock sweeps (survive DO hibernation).
    const savedSweeps = await this.room.storage.get('idleSweepAt');
    if (savedSweeps) for (let i = 1; i <= 4; i++) this.idleSweepAt[i] = savedSweeps[i] || 0;
    // Ensure alarm is running for any timers recovered from storage, or to
    // process a pending idle sweep after a hibernation.
    if (this._hasAnyRunning() || this._hasPendingSweep()) await this._scheduleAlarm();
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

      // The coach chose one or more mats (1-4) to run together as one timer.
      // Accept `mats` (comma list) with a fallback to legacy single `mat`.
      const requested = [...new Set(
        (url.searchParams.get('mats') || url.searchParams.get('mat') || '')
          .split(',').map(s => parseInt(s, 10)).filter(n => n >= 1 && n <= 4)
      )].sort((a, b) => a - b);
      if (requested.length === 0) {
        connection.send(JSON.stringify({ type: 'error', msg: 'No mat selected' }));
        connection.close();
        return;
      }

      // Sweep dead controller bindings left by crashes/hibernation. Suppress
      // the TV-idle signal for any mat whose class is still in progress (e.g. a
      // coach's phone slept) so the TV keeps showing the live timer.
      const liveIds = new Set([...this.room.getConnections('controller')].map(c => c.id));
      for (let i = 1; i <= 4; i++) {
        if (this.ctrlSlots[i] && !liveIds.has(this.ctrlSlots[i])) {
          this._freeCtrlSlot(i, !this._isClassInProgress(this._primaryForMat(i)));
        }
      }

      // Keep only mats that are free or already ours (same device reclaiming,
      // e.g. a phone that slept). Mats run by a different coach can't be grabbed —
      // and a mat whose class is mid-run (coach away) is locked to its own device.
      const bound = [];
      const reclaimOldIds = new Set();
      for (const m of requested) {
        const holder = this.ctrlSlots[m];
        if (!holder) {
          const p = this._primaryForMat(m);
          if (this._isClassInProgress(p) && this.matClientId[p] && this.matClientId[p] !== clientId) {
            continue; // class in progress for another device — locked until it ends or that coach returns
          }
          bound.push(m); continue;
        }
        const holderCtrl = this.controllers[holder];
        if (holderCtrl && clientId && holderCtrl.clientId === clientId) {
          bound.push(m);
          if (holder !== connection.id) reclaimOldIds.add(holder);
        }
        // otherwise in use by someone else — silently skip it
      }
      if (bound.length === 0) {
        connection.send(JSON.stringify({ type: 'error', msg: 'Those mats are already in use' }));
        connection.close();
        return;
      }

      // Close our own prior connection(s) being reclaimed and free their mats.
      // Don't notify the TV (a fresh ctrl:color + state is sent below) so the
      // reclaim doesn't flash the idle clock between the two messages.
      for (const oldId of reclaimOldIds) {
        const old = [...this.room.getConnections('controller')].find(c => c.id === oldId);
        if (old) { try { old.close(); } catch {} }
        for (let i = 1; i <= 4; i++) if (this.ctrlSlots[i] === oldId) this._freeCtrlSlot(i, false);
      }

      const primary = bound[0]; // lowest mat holds the single shared timer
      const reclaim = !!(clientId && this.matClientId[primary] === clientId);

      // One timer on the primary mat; the rest of the group mirrors it. A coach
      // reclaiming their own session keeps the live timer; anyone else starts clean.
      if (!this.timerStates[primary] || !reclaim) {
        this.timerStates[primary] = this._newTimerState();
      }
      this.timerStates[primary].mats = bound.slice();
      // Mirror mats carry no independent timer.
      for (const m of bound) {
        if (m === primary) continue;
        this.timerStates[m] = null;
        this.room.storage.delete('timerState:' + m).catch(() => {});
      }

      // A coach is back on the mat — stand down any pending return-to-clock sweep.
      this._clearIdleSweep(primary);

      const ctrlColor = color || CTRL_COLORS[primary];
      this.controllers[connection.id] = { slot: primary, mats: bound.slice(), color: ctrlColor, name, profileId, authSub, clientId, connectedAt: Date.now(), userRole: auth?.role || null };
      for (const m of bound) {
        this.ctrlSlots[m] = connection.id;
        this.ctrlNames[m] = name;
        this.matClientId[m] = clientId;
      }
      connection.setState({ role: 'controller', slot: primary, mats: bound.slice() });

      this._safeSend(connection, JSON.stringify({
        type:       'config',
        tvCodes:    this.config.tvCodes,
        profiles:   this._safeProfiles(),
        branding:   this.config.branding,
        ctrlSlot:   primary, mats: bound.slice(), ctrlColor, ctrlName: name,
        timerState: this._computeCurrentState(primary),
      }));
      // Push the coach's color/name + live timer to every TV in the group.
      const cur = this._computeCurrentState(primary);
      for (const m of bound) {
        this._sendToTv(m, JSON.stringify({ type: 'ctrl:color', color: ctrlColor, name }));
        if (cur) this._sendToTv(m, JSON.stringify({ type: 'state', ...cur }));
      }
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
      this._safeSend(connection, JSON.stringify({ type: 'branding', ...this.config.branding }));
      // Always reflect the mat's current controlling coach + live timer on connect.
      const ctrl = this.ctrlSlots[mat] ? this.controllers[this.ctrlSlots[mat]] : null;
      this._safeSend(connection, JSON.stringify({
        type:  'ctrl:color',
        color: ctrl ? (ctrl.color || CTRL_COLORS[mat]) : null,
        name:  ctrl ? (this.ctrlNames[mat] || null) : null,
      }));
      const current = this._tvStateForMat(mat);
      if (current) this._safeSend(connection, JSON.stringify({ type: 'state', ...current }));
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
        // If the class is still in progress (e.g. an iOS phone just slept), keep
        // the mat's TV showing the live timer instead of flipping it to the idle
        // clock — the timer keeps ticking server-side and the coach can reclaim
        // on wake. Arm a safety sweep so an abandoned class eventually goes idle.
        const inProgress = this._isClassInProgress(slot);
        // Free every mat in this controller's group that it still holds (a
        // takeover may have already rebound some). The primary's timerState is
        // intentionally preserved so a sleep/resume reconnect picks it back up.
        for (const m of (ctrl.mats || [slot])) {
          if (this.ctrlSlots[m] === connection.id) this._freeCtrlSlot(m, !inProgress);
        }
        // Arm the return-to-clock sweep only if this disconnect actually left the
        // primary unheld (a same-device reclaim may have already rebound it).
        if (inProgress && !this.ctrlSlots[slot]) this._scheduleIdleSweep(slot, BjjTimerServer.IDLE_GRACE_MS);
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
        const nm = msg.name || 'Unnamed Class';
        for (const m of (ctrl.mats || [ctrl.slot])) this.ctrlNames[m] = nm;
        this.controllers[sender.id].name = nm;
        // Update every TV in the group with the new class name.
        this._sendToTvs(ctrl.slot, JSON.stringify({ type: 'ctrl:color', color: ctrl.color, name: nm }));
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
      (req.method === 'PUT'    && /^\/api\/profiles\/[^/]+$/.test(apiPath)) ||
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
  // intact so a reconnecting/next coach picks up where it left off. When
  // notifyTv is true the mat's TV is told it's now uncontrolled (→ idle clock);
  // when false (the class is still in progress) the TV keeps showing the live
  // timer and the coach name is preserved so the mat picker can show "coach away".
  _freeCtrlSlot(slot, notifyTv = true) {
    const occupantId = this.ctrlSlots[slot];
    if (!occupantId) return;
    delete this.controllers[occupantId];
    this.ctrlSlots[slot] = null;
    if (notifyTv) {
      this.ctrlNames[slot] = '';
      this._sendToTv(slot, JSON.stringify({ type: 'ctrl:color', color: null, name: null }));
    }
  }

  // A class is "in progress" (not a fresh/idle round) when its timer is running
  // or it's been advanced/paused mid-class. A freshly configured but unstarted
  // round is NOT in progress. `mat` may be a mirror mat — resolves to its primary.
  _isClassInProgress(mat) {
    const primary = this._primaryForMat(mat);
    const ts = this.timerStates[primary];
    if (!ts) return false;
    const cur = this._computeCurrentState(primary) || ts;
    return !!(cur.running || cur.timeRemaining < cur.roundDuration || cur.currentRound > 1 || cur.phase === 'rest');
  }

  _hasPendingSweep() {
    for (let i = 1; i <= 4; i++) { if (this.idleSweepAt[i]) return true; }
    return false;
  }

  // Arm the return-to-clock timer for a primary mat and make sure the alarm runs.
  _scheduleIdleSweep(primary, delayMs) {
    this.idleSweepAt[primary] = Date.now() + delayMs;
    this.room.storage.put('idleSweepAt', { ...this.idleSweepAt }).catch(() => {});
    this._scheduleAlarm();
  }

  _clearIdleSweep(primary) {
    if (!this.idleSweepAt[primary]) return;
    this.idleSweepAt[primary] = 0;
    this.room.storage.put('idleSweepAt', { ...this.idleSweepAt }).catch(() => {});
  }

  // Sending to a connection that just closed (stale/flapping TV, a phone that
  // walked out of range) throws and would otherwise abort the whole handler
  // mid-connect, leaving TVs stuck reconnecting. Always send defensively.
  _safeSend(conn, msg) {
    try { conn.send(msg); } catch {}
  }

  // Send a message to every TV pinned to the given mat.
  _sendToTv(mat, msg) {
    for (const conn of this.room.getConnections('tv')) {
      if (conn.state?.tvSlot === mat) this._safeSend(conn, msg);
    }
  }

  // Per-mat occupancy, sent to everyone (controllers + the mat picker) so
  // coaches can see which mats are open vs. in use.
  _broadcastMatStatus() {
    const msg = JSON.stringify({ type: 'mat:status', mats: this._buildMatStatus() });
    for (const conn of this.room.getConnections()) this._safeSend(conn, msg);
  }

  _buildMatStatus() {
    const mats = {};
    for (let i = 1; i <= 4; i++) {
      const ctrl = this.ctrlSlots[i] ? this.controllers[this.ctrlSlots[i]] : null;
      if (ctrl) {
        mats[i] = { occupied: true, name: this.ctrlNames[i] || 'Coach', color: ctrl.color || CTRL_COLORS[i] };
      } else if (this._isClassInProgress(i) && this.matClientId[this._primaryForMat(i)]) {
        // No live controller, but the class is mid-run with its coach away (e.g.
        // phone asleep). Keep the mat locked so another coach can't seize it.
        mats[i] = { occupied: true, inProgress: true, name: this.ctrlNames[i] || 'Coach', color: CTRL_COLORS[i] };
      } else {
        mats[i] = { occupied: false };
      }
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

  // PartyKit dispatches Durable Object alarms to onAlarm() (NOT alarm()) — a
  // method named alarm() is never invoked, which silently stops the timer tick.
  async onAlarm() {
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
    this._runIdleSweeps(now);
    // Keep ticking while any mat is running, or while an idle sweep is pending
    // (so an abandoned/ended class still returns its TV to the clock). setAlarm
    // replaces any existing alarm, so this is safe to call unconditionally.
    if (this._hasAnyRunning() || this._hasPendingSweep()) {
      await this.room.storage.setAlarm(Date.now() + 1000);
    }
  }

  // Return TVs to the idle clock for mats whose class has been abandoned (coach
  // gone) or has ended, once the grace period elapses. A live controller or a
  // still-running timer cancels/defers the sweep.
  _runIdleSweeps(now) {
    let changed = false;
    for (let p = 1; p <= 4; p++) {
      const due = this.idleSweepAt[p];
      if (!due) continue;
      if (this.ctrlSlots[p]) { this.idleSweepAt[p] = 0; changed = true; continue; } // reclaimed
      if (this.timerStates[p]?.running) continue;                                    // still ticking — wait
      if (now < due) continue;
      // Finalize: tell the group's TVs the mat is idle and fully release it.
      const ts = this.timerStates[p];
      const mats = (ts && ts.mats) ? ts.mats : [p];
      for (const m of mats) {
        this.ctrlNames[m] = '';
        this.matClientId[m] = null;
        this._sendToTv(m, JSON.stringify({ type: 'ctrl:color', color: null, name: null }));
      }
      this.timerStates[p] = null;
      this.room.storage.delete('timerState:' + p).catch(() => {});
      this.idleSweepAt[p] = 0;
      changed = true;
      this._broadcastMatStatus();
    }
    if (changed) this.room.storage.put('idleSweepAt', { ...this.idleSweepAt }).catch(() => {});
  }

  _hasAnyRunning() {
    for (let i = 1; i <= 4; i++) { if (this.timerStates[i]?.running) return true; }
    return false;
  }

  // Schedule the 1 Hz tick. No in-memory "pending" flag — that could get stuck
  // true and silently stop the timer forever. setAlarm is idempotent (replaces
  // any existing alarm), so always calling it is safe and self-healing.
  async _scheduleAlarm() {
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

  // The mat that holds the shared timer for `mat` — itself if it's a primary,
  // otherwise the primary of the group it mirrors.
  _primaryForMat(mat) {
    if (this.timerStates[mat]?.mats) return mat;
    for (let p = 1; p <= 4; p++) {
      if (this.timerStates[p]?.mats?.includes(mat)) return p;
    }
    return mat;
  }

  // What a TV should display for a mat: the live (group) timer when a coach is on
  // the mat or a round is genuinely still counting; otherwise a clean idle round
  // so an unattended TV shows a ready screen instead of a stale/flashing leftover.
  _tvStateForMat(mat) {
    const primary = this._primaryForMat(mat);
    const ts = this.timerStates[primary];
    const live = this.ctrlSlots[mat]
      || (ts && ts.running && this._computeCurrentState(primary).timeRemaining > 0);
    if (live && ts) return this._computeCurrentState(primary);
    const base = ts || this._newTimerState();
    return {
      running: false, phase: 'fight', currentRound: 1,
      roundDuration: base.roundDuration, restDuration: base.restDuration,
      totalRounds: base.totalRounds, timeRemaining: base.roundDuration,
      warningEnabled: base.warningEnabled, warningThreshold: base.warningThreshold,
      showRound: base.showRound,
    };
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
        // If the coach already left (e.g. phone asleep), let the TV show "TIME!"
        // briefly, then return it to the idle clock via the sweep.
        if (!this.ctrlSlots[slot]) this._scheduleIdleSweep(slot, BjjTimerServer.END_IDLE_DELAY_MS);
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
      if (conn.id === connId) { this._safeSend(conn, msg); return; }
    }
  }

  // Broadcast to every TV in a primary mat's group (so all mats grouped under
  // one timer show the same thing). Falls back to just the mat for a group of 1.
  _sendToTvs(primary, msg) {
    const ts = this.timerStates[primary];
    const mats = (ts && ts.mats) ? ts.mats : [primary];
    for (const m of mats) this._sendToTv(m, msg);
  }

  _sendSoundToTvs(slot, soundType) {
    this._sendToTvs(slot, JSON.stringify({ type: 'sound', soundType }));
  }
}
