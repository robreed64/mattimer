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
      if (!this.config.branding) { this.config.branding = { appName: 'BJJ Mat Timer', tagline: 'Competition · Training · Sparring', logoDataUrl: '' }; changed = true; }
      if (changed) await this.room.storage.put('config', this.config);
    }
  }

  getConnectionTags(connection, ctx) {
    const role = new URL(ctx.request.url).searchParams.get('role') || 'display';
    return [role];
  }

  async onConnect(connection, ctx) {
    if (!this.config) await this.onStart();
    const url  = new URL(ctx.request.url);
    const role = url.searchParams.get('role') || 'display';

    if (role === 'controller') {
      const name      = decodeURIComponent(url.searchParams.get('name') || 'Unnamed Class');
      const color     = url.searchParams.get('color') || null;
      const profileId = url.searchParams.get('profileId') || null;
      const slot      = this._nextFreeCtrlSlot();

      if (!slot) {
        connection.send(JSON.stringify({ type: 'error', msg: 'All 4 controller slots are full' }));
        connection.close();
        return;
      }
      this.ctrlSlots[slot] = connection.id;
      this.ctrlNames[slot] = name;
      const ctrlColor = color || CTRL_COLORS[slot];
      this.controllers[connection.id] = { slot, color: ctrlColor, name, profileId, connectedAt: Date.now() };
      connection.setState({ role: 'controller', slot });

      connection.send(JSON.stringify({
        type:     'config',
        tvCodes:  this.config.tvCodes,
        profiles: this.config.profiles.map(({ pin, ...p }) => ({ ...p, hasPin: !!pin })),
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
        if (duration > 30) {
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

    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Filename',
    };

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!this.config) await this.onStart();

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
        profiles:   this.config.profiles.map(({ pin, ...p }) => ({ ...p, hasPin: !!pin })),
        audioSlots: {},
      }, { headers: cors });
    }

    // GET /api/profiles
    if (req.method === 'GET' && apiPath === '/api/profiles') {
      return Response.json(
        this.config.profiles.map(({ pin, ...p }) => ({ ...p, hasPin: !!pin })),
        { headers: cors }
      );
    }

    // POST /api/profiles
    if (req.method === 'POST' && apiPath === '/api/profiles') {
      const { name, pin, settings } = await req.json();
      if (!name?.trim()) return Response.json({ error: 'Name required' }, { status: 400, headers: cors });
      const usedColors = this.config.profiles.map(p => p.color);
      const color = PROFILE_COLORS.find(c => !usedColors.includes(c)) || PROFILE_COLORS[this.config.profiles.length % PROFILE_COLORS.length];
      const profile = { id: makeId(), name: name.trim(), pin: pin || '', color, settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } };
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
        if (body.pin  !== undefined) profile.pin  = body.pin;
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
      if (profile.pin && profile.pin !== pin) return Response.json({ error: 'Incorrect PIN' }, { status: 401, headers: cors });
      const { pin: _, ...safe } = profile;
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

  _broadcastProfilesUpdated() {
    const updated = this.config.profiles.map(({ pin, ...p }) => ({ ...p, hasPin: !!pin }));
    this.room.broadcast(JSON.stringify({ type: 'profiles:updated', profiles: updated }));
  }
}
