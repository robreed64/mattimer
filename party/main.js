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
    this.lastState    = { 1: null, 2: null, 3: null, 4: null }; // last state per ctrl slot
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

      // Free any slots whose connection is no longer live (handles crashes,
      // hibernation wakeup, and the setState race on abrupt disconnect).
      const liveIds = new Set([...this.room.getConnections('controller')].map(c => c.id));
      for (let i = 1; i <= 4; i++) {
        const occupantId = this.ctrlSlots[i];
        if (occupantId && !liveIds.has(occupantId)) {
          delete this.controllers[occupantId];
          this.ctrlSlots[i] = null;
          this.ctrlNames[i] = '';
        }
      }

      const slot      = this._nextFreeCtrlSlot();

      if (!slot) {
        connection.send(JSON.stringify({ type: 'error', msg: 'All 4 controller slots are full' }));
        connection.close();
        return;
      }
      connection.setState({ role: 'controller', slot });
      this.ctrlSlots[slot] = connection.id;
      this.ctrlNames[slot] = name;
      const ctrlColor = color || CTRL_COLORS[slot];
      this.controllers[connection.id] = { slot, color: ctrlColor, name, profileId, connectedAt: Date.now(), userRole: auth?.role || null };

      connection.send(JSON.stringify({
        type:     'config',
        tvCodes:  this.config.tvCodes,
        profiles: this._safeProfiles(),
        branding: this.config.branding,
        ctrlSlot: slot, ctrlColor, ctrlName: name,
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
      if (this.tvDisplays[tvSlot] > 0) {
        connection.send(JSON.stringify({ type: 'error', msg: `TV ${tvSlot} is already in use` }));
        connection.send(JSON.stringify({ type: 'tv:taken', slot: tvSlot }));
        connection.close();
        return;
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
      // Send last known state so TV immediately reflects current settings
      if (ownerSlot && this.lastState[ownerSlot]) {
        connection.send(JSON.stringify({ type: 'state', ...this.lastState[ownerSlot] }));
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
        this.ctrlSlots[slot] = null;
        this.ctrlNames[slot] = '';
        delete this.controllers[connection.id];
        for (let tv = 1; tv <= 4; tv++) {
          if (this.tvOwner[tv] === slot) {
            this.tvOwner[tv] = null;
            this._sendToTv(tv, JSON.stringify({ type: 'ctrl:color', color: null, name: null }));
          }
        }
        const duration = Math.round((Date.now() - (ctrl.connectedAt || Date.now())) / 1000);
        // Platform-admin visits aren't real classes — keep them out of Recent activity
        if (duration > 30 && ctrl.userRole !== 'admin') {
          (async () => {
            const sessions = (await this.room.storage.get('sessions')) || [];
            sessions.push({ date: new Date(ctrl.connectedAt).toISOString(), name: ctrl.name, slot: ctrl.slot, duration });
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

  onMessage(message, sender) {
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
        // Send current state so TV immediately reflects controller settings
        if (this.lastState[ctrl.slot]) {
          this._sendToTv(msg.tvSlot, JSON.stringify({ type: 'state', ...this.lastState[ctrl.slot] }));
        }
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

      case 'state':
      case 'overlay':
      case 'tab':
      case 'sw:state':
      case 'sound': {
        if (!ctrl) return;
        // Cache latest timer state so new TV connections get it immediately
        if (msg.type === 'state') {
          const { type: _, ...stateData } = msg;
          this.lastState[ctrl.slot] = stateData;
        }
        const fwd = JSON.stringify(msg);
        for (let tv = 1; tv <= 4; tv++) {
          if (this.tvOwner[tv] === ctrl.slot) this._sendToTv(tv, fwd);
        }
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
    return {
      tvOwner:    { ...this.tvOwner },
      tvDisplays: { ...this.tvDisplays },
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
}
