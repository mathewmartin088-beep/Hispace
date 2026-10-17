// Hispace server: accounts, persistent servers/channels/DMs, realtime chat, voice signaling.
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');
const DB = require('./db');

const VERSION = '3.0.0';
const MAX_TEXT = 2000;
const HISTORY_PAGE = 50;
const MAX_MESSAGES_PER_CHANNEL = 5000;
const SESSION_DAYS = 60;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function startServer({ port = 3000, dataDir, publicDir, host = '0.0.0.0' } = {}) {
  dataDir = dataDir || path.join(process.cwd(), 'data');
  publicDir = publicDir || path.join(__dirname, '..', 'public');

  const db = new DB(dataDir);
  const D = db.data;

  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' }, maxHttpBufferSize: 1e5 });

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1); // behind Render/Fly/nginx: real client IPs
  app.use(express.json({ limit: '10kb' }));

  // The desktop client loads its UI from disk and talks to this API cross-origin.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ---------- Auth ----------
  const attempts = new Map(); // ip -> {count, reset}
  function limited(ip) {
    const now = Date.now();
    const a = attempts.get(ip);
    if (!a || a.reset < now) return false;
    return a.count >= 10;
  }
  function recordFail(ip) {
    const now = Date.now();
    const a = attempts.get(ip);
    if (!a || a.reset < now) attempts.set(ip, { count: 1, reset: now + 10 * 60 * 1000 });
    else a.count++;
  }

  const regs = new Map(); // ip -> {count, reset}
  function regLimited(ip) { const a = regs.get(ip); return !!a && a.reset > Date.now() && a.count >= 8; }
  function recordReg(ip) {
    const now = Date.now(), a = regs.get(ip);
    if (!a || a.reset < now) regs.set(ip, { count: 1, reset: now + 3600 * 1000 }); else a.count++;
  }

  const publicUser = (u) => ({ id: u.id, username: u.username, hue: u.hue });

  function issueSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    D.sessions[sha(token)] = { userId, created: Date.now() };
    db.save();
    return token;
  }

  function userFromToken(token) {
    if (typeof token !== 'string') return null;
    const s = D.sessions[sha(token)];
    if (!s) return null;
    if (Date.now() - s.created > SESSION_DAYS * 864e5) { delete D.sessions[sha(token)]; return null; }
    return D.users[s.userId] || null;
  }

  const validUsername = (u) => typeof u === 'string' && /^[A-Za-z0-9_.-]{2,20}$/.test(u);

  app.get('/api/ping', (req, res) => res.json({ app: 'hispace', version: VERSION }));

  app.post('/api/register', (req, res) => {
    const ip = req.ip;
    if (limited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const { username, password } = req.body || {};
    if (regLimited(ip)) return res.status(429).json({ error: 'Too many accounts created from this network. Try again later.' });
    if (!validUsername(username)) return res.status(400).json({ error: 'Username must be 2-20 characters: letters, numbers, dot, dash or underscore.' });
    if (typeof password !== 'string' || password.length < 6 || password.length > 100) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const key = username.toLowerCase();
    if (Object.values(D.users).some((u) => u.key === key)) { recordFail(ip); return res.status(409).json({ error: 'That username is taken.' }); }
    const { salt, hash } = hashPassword(password);
    const user = { id: rid(6), key, username, hue: colorFor(key), salt, hash, created: Date.now(), friends: [], incoming: [], outgoing: [] };
    recordReg(ip);
    D.users[user.id] = user;
    const token = issueSession(user.id);
    res.json({ token, user: publicUser(user) });
  });

  app.post('/api/login', (req, res) => {
    const ip = req.ip;
    if (limited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const { username, password } = req.body || {};
    const user = typeof username === 'string' ? Object.values(D.users).find((u) => u.key === username.toLowerCase()) : null;
    if (!user || typeof password !== 'string' || !verifyPassword(password, user)) {
      recordFail(ip);
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    const token = issueSession(user.id);
    res.json({ token, user: publicUser(user) });
  });

  app.use(express.static(publicDir));

  // ---------- Helpers ----------
  const dmId = (a, b) => 'dm:' + [a, b].sort().join(':');
  const fr = (u) => { u.friends = u.friends || []; u.incoming = u.incoming || []; u.outgoing = u.outgoing || []; return u; };
  const pubList = (ids) => ids.map((id) => D.users[id]).filter(Boolean).map(publicUser);
  const friendsView = (u) => { fr(u); return { friends: pubList(u.friends), incoming: pubList(u.incoming), outgoing: pubList(u.outgoing) }; };
  const pushFriends = (id) => { if (D.users[id]) io.to('u:' + id).emit('friends:update', friendsView(D.users[id])); };
  const areFriends = (a, b) => !!D.users[a] && fr(D.users[a]).friends.includes(b);
  const sharesServer = (a, b) => Object.values(D.servers).some((s) => s.members.includes(a) && s.members.includes(b));
  const canDm = (a, b) => a === b || areFriends(a, b) || sharesServer(a, b);
  const serversOf = (userId) => Object.values(D.servers).filter((s) => s.members.includes(userId));
  const findChannel = (server, cid) => server.channels.find((c) => c.id === cid);

  function serverView(s) {
    return {
      id: s.id, name: s.name, ownerId: s.ownerId, invite: s.invite,
      channels: s.channels,
      members: s.members.map((id) => D.users[id]).filter(Boolean).map(publicUser)
    };
  }

  // Resolve a channel id to {kind, server?, members[]} if the user may use it.
  function access(userId, channelId) {
    if (typeof channelId !== 'string') return null;
    if (channelId.startsWith('dm:')) {
      const ids = channelId.slice(3).split(':');
      if (ids.length !== 2 || !ids.includes(userId)) return null;
      const other = ids.find((i) => i !== userId) || userId;
      if (!D.users[other] || !canDm(userId, other)) return null;
      return { kind: 'dm', other, audience: [ids[0], ids[1]] };
    }
    for (const s of serversOf(userId)) {
      const ch = findChannel(s, channelId);
      if (ch) return { kind: 'server', server: s, channel: ch };
    }
    return null;
  }

  function emitToChannel(acc, event, payload) {
    if (acc.kind === 'server') io.to('s:' + acc.server.id).emit(event, payload);
    else io.to('u:' + acc.audience[0]).to('u:' + acc.audience[1]).emit(event, payload);
  }

  function msgView(m, channelId) {
    let reply = null;
    if (m.replyTo) {
      const src = (D.messages[channelId] || []).find((x) => x.id === m.replyTo);
      reply = src ? { id: src.id, authorId: src.authorId, text: src.text.slice(0, 120) } : { id: m.replyTo, deleted: true };
    }
    return { id: m.id, channelId, type: m.type || 'msg', authorId: m.authorId, text: m.text, ts: m.ts, edited: m.edited || 0, reactions: m.reactions || {}, reply };
  }

  function pushMessage(channelId, m) {
    const list = (D.messages[channelId] = D.messages[channelId] || []);
    list.push(m);
    if (list.length > MAX_MESSAGES_PER_CHANNEL) list.splice(0, list.length - MAX_MESSAGES_PER_CHANNEL);
    db.save();
  }

  function cleanText(t) {
    if (typeof t !== 'string') return '';
    return t.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, MAX_TEXT);
  }

  function cleanName(n, max = 32) {
    return typeof n === 'string' ? n.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  }

  const channelSlug = (n) => cleanName(n, 24).toLowerCase().replace(/[^a-z0-9À-ɏ]+/g, '-').replace(/^-+|-+$/g, '');

  function newInvite() {
    for (;;) {
      let code = '';
      const bytes = crypto.randomBytes(8);
      for (const b of bytes) code += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
      if (!Object.values(D.servers).some((s) => s.invite === code)) return code;
    }
  }

  // ---------- Presence and voice state ----------
  const online = new Map(); // userId -> socket count
  const voice = new Map(); // channelId -> Map(userId -> {socketId, muted, deafened})
  const voiceOf = new Map(); // userId -> channelId

  function voiceSnapshot(serverId) {
    const s = D.servers[serverId];
    const out = {};
    if (!s) return out;
    for (const ch of s.channels) {
      if (ch.type !== 'voice') continue;
      const m = voice.get(ch.id);
      out[ch.id] = m ? [...m.entries()].map(([id, v]) => ({ id, muted: v.muted, deafened: v.deafened })) : [];
    }
    return out;
  }

  function broadcastVoice(channelId) {
    if (channelId.startsWith('dm:')) {
      const [a, b] = channelId.slice(3).split(':');
      const m = voice.get(channelId);
      io.to('u:' + a).to('u:' + b).emit('voice:state', {
        channelId,
        participants: m ? [...m.entries()].map(([id, v]) => ({ id, muted: v.muted, deafened: v.deafened })) : []
      });
      return;
    }
    for (const s of Object.values(D.servers)) {
      if (!findChannel(s, channelId)) continue;
      const m = voice.get(channelId);
      io.to('s:' + s.id).emit('voice:state', {
        channelId,
        participants: m ? [...m.entries()].map(([id, v]) => ({ id, muted: v.muted, deafened: v.deafened })) : []
      });
    }
  }

  function leaveVoice(userId) {
    const cid = voiceOf.get(userId);
    if (!cid) return;
    voiceOf.delete(userId);
    const m = voice.get(cid);
    if (m) {
      m.delete(userId);
      if (!m.size) voice.delete(cid);
    }
    io.to('v:' + cid).emit('voice:peer-left', { channelId: cid, userId });
    broadcastVoice(cid);
  }

  // Short-lived TURN credentials for the Open Relay Project (metered.ca), their standard
  // REST-API scheme: username is "<expiry-unix-time>", credential is base64(HMAC-SHA1(secret, username)).
  // Published openly by them for free, low-volume use - https://www.metered.ca/tools/openrelay/
  function openRelayTurn() {
    const secret = 'openrelayprojectsecret';
    const username = String(Math.floor(Date.now() / 1000) + 24 * 3600); // 24h-valid
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    const host = 'staticauth.openrelay.metered.ca';
    return [
      { urls: `turn:${host}:80`, username, credential },
      { urls: `turn:${host}:80?transport=tcp`, username, credential },
      { urls: `turns:${host}:443?transport=tcp`, username, credential }
    ];
  }

  function iceServers() {
    // A dedicated TURN server (ICE_SERVERS env var, JSON array) always wins if the host sets one.
    if (process.env.ICE_SERVERS) {
      try { return JSON.parse(process.env.ICE_SERVERS); } catch (err) { console.error('[hispace] ICE_SERVERS is not valid JSON, ignoring it:', err.message); }
    }
    // Otherwise: Google's public STUN (cheap NAT discovery) plus a free TURN relay as a fallback
    // for the networks where a direct peer-to-peer path can't be found at all.
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      ...openRelayTurn()
    ];
  }

  // ---------- Sockets ----------
  io.use((socket, next) => {
    const user = userFromToken(socket.handshake.auth && socket.handshake.auth.token);
    if (!user) return next(new Error('unauthorized'));
    socket.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const me = socket.user;
    const buckets = { msg: { n: 0, reset: 0 } };

    socket.join('u:' + me.id);
    for (const s of serversOf(me.id)) socket.join('s:' + s.id);

    const announce = (isOnline) => {
      const p = { userId: me.id, online: isOnline };
      for (const s of serversOf(me.id)) io.to('s:' + s.id).emit('presence', p);
      for (const fid of fr(me).friends) io.to('u:' + fid).emit('presence', p);
    };
    const wasOnline = online.get(me.id) || 0;
    online.set(me.id, wasOnline + 1);
    if (!wasOnline) announce(true);

    // Register a handler with error handling and a safe ack.
    const on = (event, fn) => {
      socket.on(event, (payload, cb) => {
        const ack = typeof cb === 'function' ? cb : () => {};
        try {
          const result = fn(payload || {}, ack);
          if (result !== undefined) ack(result);
        } catch (err) {
          console.error('[hispace] handler error', event, err);
          ack({ ok: false, error: 'Something went wrong on the server.' });
        }
      });
    };

    on('bootstrap', () => {
      const servers = serversOf(me.id);
      const visible = new Set([me.id]);
      servers.forEach((s) => s.members.forEach((m) => visible.add(m)));
      fr(me).friends.forEach((f) => visible.add(f));
      fr(me).incoming.forEach((f) => visible.add(f));
      const dms = [];
      for (const cid of Object.keys(D.messages)) {
        if (!cid.startsWith('dm:')) continue;
        const ids = cid.slice(3).split(':');
        if (!ids.includes(me.id)) continue;
        const other = ids.find((i) => i !== me.id) || me.id;
        const list = D.messages[cid];
        if (D.users[other] && list.length && canDm(me.id, other)) { dms.push({ user: publicUser(D.users[other]), last: list[list.length - 1].ts }); visible.add(other); }
      }
      const voiceStates = {};
      servers.forEach((s) => Object.assign(voiceStates, voiceSnapshot(s.id)));
      for (const [cid, m] of voice) {
        if (cid.startsWith('dm:') && cid.slice(3).split(':').includes(me.id)) voiceStates[cid] = [...m.entries()].map(([id, v]) => ({ id, muted: v.muted, deafened: v.deafened }));
      }
      return {
        ok: true,
        me: publicUser(me),
        ...friendsView(me),
        servers: servers.map(serverView),
        dms,
        online: [...visible].filter((id) => online.has(id)),
        voice: voiceStates,
        iceServers: iceServers(),
        version: VERSION
      };
    });

    on('history', ({ channelId, before }) => {
      if (!access(me.id, channelId)) return { ok: false, error: 'No access to that channel.' };
      const list = D.messages[channelId] || [];
      let end = list.length;
      if (before) { const idx = list.findIndex((m) => m.id === before); if (idx >= 0) end = idx; }
      const start = Math.max(0, end - HISTORY_PAGE);
      return { ok: true, messages: list.slice(start, end).map((m) => msgView(m, channelId)), hasMore: start > 0 };
    });

    on('dm:open', ({ userId }) => {
      const other = D.users[userId];
      if (!other) return { ok: false, error: 'User not found.' };
      if (!canDm(me.id, userId)) return { ok: false, error: 'Add ' + other.username + ' as a friend first.' };
      return { ok: true, channelId: dmId(me.id, userId), user: publicUser(other) };
    });

    on('msg:send', ({ channelId, text, replyTo }) => {
      const acc = access(me.id, channelId);
      if (!acc) return { ok: false, error: 'No access to that channel.' };
      if (acc.kind === 'server' && acc.channel.type !== 'text') return { ok: false, error: 'You cannot post in a voice channel.' };
      const body = cleanText(text);
      if (!body) return { ok: false, error: 'Message is empty.' };
      const now = Date.now();
      const b = buckets.msg;
      if (b.reset < now) { b.n = 0; b.reset = now + 8000; }
      if (++b.n > 10) return { ok: false, error: 'Slow down a little.' };
      const m = { id: Date.now().toString(36) + rid(3), authorId: me.id, text: body, ts: now, reactions: {} };
      if (typeof replyTo === 'string' && (D.messages[channelId] || []).some((x) => x.id === replyTo)) m.replyTo = replyTo;
      pushMessage(channelId, m);
      emitToChannel(acc, 'msg:new', msgView(m, channelId));
      return { ok: true };
    });

    on('msg:edit', ({ channelId, id, text }) => {
      const acc = access(me.id, channelId);
      if (!acc) return { ok: false, error: 'No access to that channel.' };
      const m = (D.messages[channelId] || []).find((x) => x.id === id);
      if (!m || m.authorId !== me.id || m.type === 'sys') return { ok: false, error: 'You can only edit your own messages.' };
      const body = cleanText(text);
      if (!body) return { ok: false, error: 'Message is empty.' };
      m.text = body; m.edited = Date.now();
      db.save();
      emitToChannel(acc, 'msg:update', msgView(m, channelId));
      return { ok: true };
    });

    on('msg:delete', ({ channelId, id }) => {
      const acc = access(me.id, channelId);
      if (!acc) return { ok: false, error: 'No access to that channel.' };
      const list = D.messages[channelId] || [];
      const idx = list.findIndex((x) => x.id === id);
      if (idx < 0) return { ok: false, error: 'Message not found.' };
      const m = list[idx];
      const isOwner = acc.kind === 'server' && acc.server.ownerId === me.id;
      if (m.authorId !== me.id && !isOwner) return { ok: false, error: 'You can only delete your own messages.' };
      list.splice(idx, 1);
      db.save();
      emitToChannel(acc, 'msg:delete', { channelId, id });
      return { ok: true };
    });

    on('msg:react', ({ channelId, id, emoji }) => {
      const acc = access(me.id, channelId);
      if (!acc) return { ok: false, error: 'No access to that channel.' };
      if (typeof emoji !== 'string' || !emoji || emoji.length > 8 || /[<>&]/.test(emoji)) return { ok: false, error: 'Invalid reaction.' };
      const m = (D.messages[channelId] || []).find((x) => x.id === id);
      if (!m) return { ok: false, error: 'Message not found.' };
      m.reactions = m.reactions || {};
      const arr = (m.reactions[emoji] = m.reactions[emoji] || []);
      const i = arr.indexOf(me.id);
      if (i >= 0) arr.splice(i, 1);
      else if (Object.keys(m.reactions).length <= 20) arr.push(me.id);
      if (!arr.length) delete m.reactions[emoji];
      db.save();
      emitToChannel(acc, 'msg:update', msgView(m, channelId));
      return { ok: true };
    });

    on('typing', ({ channelId }) => {
      const acc = access(me.id, channelId);
      if (!acc) return;
      const payload = { channelId, userId: me.id };
      if (acc.kind === 'server') socket.to('s:' + acc.server.id).emit('typing', payload);
      else io.to('u:' + acc.other).emit('typing', payload);
    });

    // ----- Friends -----
    const bucket = { n: 0, reset: 0 };
    const removeFrom = (u, field, id) => { fr(u)[field] = u[field].filter((x) => x !== id); };

    on('friend:add', ({ username }) => {
      const now = Date.now();
      if (bucket.reset < now) { bucket.n = 0; bucket.reset = now + 60000; }
      if (++bucket.n > 20) return { ok: false, error: 'Slow down a little.' };
      const name = typeof username === 'string' ? username.trim().replace(/^@/, '') : '';
      if (!name) return { ok: false, error: 'Type a username.' };
      const target = Object.values(D.users).find((u) => u.key === name.toLowerCase());
      if (!target) return { ok: false, error: 'No one is called "' + name.slice(0, 20) + '". Check the spelling.' };
      if (target.id === me.id) return { ok: false, error: 'That is you.' };
      fr(me); fr(target);
      if (me.friends.includes(target.id)) return { ok: false, error: 'You are already friends with ' + target.username + '.' };
      if (me.outgoing.includes(target.id)) return { ok: false, error: 'You already sent ' + target.username + ' a request.' };
      let accepted = false;
      if (me.incoming.includes(target.id)) {
        removeFrom(me, 'incoming', target.id); removeFrom(target, 'outgoing', me.id);
        me.friends.push(target.id); target.friends.push(me.id);
        accepted = true;
      } else {
        me.outgoing.push(target.id); target.incoming.push(me.id);
      }
      db.save(); pushFriends(me.id); pushFriends(target.id);
      if (accepted) {
        io.to('u:' + target.id).emit('friend:accepted', { user: publicUser(me) });
        if (online.has(target.id)) io.to('u:' + me.id).emit('presence', { userId: target.id, online: true });
        if (online.has(me.id)) io.to('u:' + target.id).emit('presence', { userId: me.id, online: true });
      } else io.to('u:' + target.id).emit('friend:request', { user: publicUser(me) });
      return { ok: true, accepted, user: publicUser(target) };
    });

    on('friend:accept', ({ userId }) => {
      const other = D.users[userId];
      if (!other || !fr(me).incoming.includes(userId)) return { ok: false, error: 'That request is no longer there.' };
      fr(other);
      removeFrom(me, 'incoming', userId); removeFrom(other, 'outgoing', me.id);
      me.friends.push(userId); other.friends.push(me.id);
      db.save(); pushFriends(me.id); pushFriends(userId);
      io.to('u:' + userId).emit('friend:accepted', { user: publicUser(me) });
      if (online.has(userId)) io.to('u:' + me.id).emit('presence', { userId, online: true });
      io.to('u:' + userId).emit('presence', { userId: me.id, online: true });
      return { ok: true };
    });

    const dropRelation = (userId, mine, theirs) => {
      const other = D.users[userId];
      if (!other) return { ok: false, error: 'User not found.' };
      removeFrom(me, mine, userId); removeFrom(other, theirs, me.id);
      db.save(); pushFriends(me.id); pushFriends(userId);
      return { ok: true };
    };
    on('friend:decline', ({ userId }) => dropRelation(userId, 'incoming', 'outgoing'));
    on('friend:cancel', ({ userId }) => dropRelation(userId, 'outgoing', 'incoming'));
    on('friend:remove', ({ userId }) => {
      const other = D.users[userId];
      if (!other) return { ok: false, error: 'User not found.' };
      removeFrom(me, 'friends', userId); removeFrom(other, 'friends', me.id);
      db.save(); pushFriends(me.id); pushFriends(userId);
      io.to('u:' + userId).emit('presence', { userId: me.id, online: sharesServer(me.id, userId) && online.has(me.id) });
      return { ok: true };
    });

    // ----- Calls (1:1 voice in a DM). The caller joins voice first, then rings. -----
    on('call:ring', ({ userId }) => {
      const cid = dmId(me.id, userId);
      if (!D.users[userId] || !canDm(me.id, userId)) return { ok: false, error: 'You cannot call that person.' };
      if (voiceOf.get(me.id) !== cid) return { ok: false, error: 'Join the call first.' };
      if (!online.has(userId)) return { ok: false, error: D.users[userId].username + ' is offline.' };
      if (voiceOf.has(userId)) return { ok: false, error: D.users[userId].username + ' is already in a call.' };
      io.to('u:' + userId).emit('call:incoming', { from: publicUser(me), channelId: cid });
      return { ok: true };
    });
    on('call:decline', ({ userId }) => { io.to('u:' + userId).emit('call:declined', { userId: me.id }); return { ok: true }; });
    on('call:cancel', ({ userId }) => { io.to('u:' + userId).emit('call:cancelled', { userId: me.id }); return { ok: true }; });

    // ----- Servers -----
    function pushServer(s) { io.to('s:' + s.id).emit('server:update', serverView(s)); }

    on('server:create', ({ name }) => {
      const n = cleanName(name);
      if (n.length < 2) return { ok: false, error: 'Server name needs at least 2 characters.' };
      if (serversOf(me.id).length >= 25) return { ok: false, error: 'You are in too many servers.' };
      const s = {
        id: rid(6), name: n, ownerId: me.id, invite: newInvite(), members: [me.id],
        channels: [
          { id: rid(5), name: 'general', type: 'text' },
          { id: rid(5), name: 'random', type: 'text' },
          { id: rid(5), name: 'Lounge', type: 'voice' }
        ]
      };
      D.servers[s.id] = s;
      db.save();
      socket.join('s:' + s.id);
      return { ok: true, server: serverView(s) };
    });

    on('server:join', ({ invite }) => {
      const code = typeof invite === 'string' ? invite.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
      const s = Object.values(D.servers).find((x) => x.invite === code);
      if (!s) return { ok: false, error: 'That invite code does not match any server.' };
      if (s.members.includes(me.id)) return { ok: true, server: serverView(s), already: true };
      s.members.push(me.id);
      db.save();
      socket.join('s:' + s.id);
      // Members list and presence first, so the join message below can show the new name.
      pushServer(s);
      io.to('s:' + s.id).emit('presence', { userId: me.id, online: true });
      const gen = s.channels.find((c) => c.type === 'text');
      if (gen) {
        const m = { id: Date.now().toString(36) + rid(3), type: 'sys', authorId: me.id, text: 'joined the server', ts: Date.now(), reactions: {} };
        pushMessage(gen.id, m);
        io.to('s:' + s.id).emit('msg:new', msgView(m, gen.id));
      }
      return { ok: true, server: serverView(s), voice: voiceSnapshot(s.id), online: s.members.filter((id) => online.has(id)) };
    });

    on('server:leave', ({ serverId }) => {
      const s = D.servers[serverId];
      if (!s || !s.members.includes(me.id)) return { ok: false, error: 'Server not found.' };
      if (s.ownerId === me.id) return { ok: false, error: 'Owners cannot leave. Delete the server instead.' };
      const vc = voiceOf.get(me.id);
      if (vc && findChannel(s, vc)) leaveVoice(me.id);
      s.members = s.members.filter((i) => i !== me.id);
      db.save();
      socket.leave('s:' + s.id);
      io.to('u:' + me.id).emit('server:removed', { id: s.id });
      pushServer(s);
      return { ok: true };
    });

    on('server:delete', ({ serverId }) => {
      const s = D.servers[serverId];
      if (!s || s.ownerId !== me.id) return { ok: false, error: 'Only the owner can delete a server.' };
      for (const ch of s.channels) {
        const m = voice.get(ch.id);
        if (m) for (const uid of [...m.keys()]) leaveVoice(uid);
        delete D.messages[ch.id];
      }
      delete D.servers[s.id];
      db.save();
      io.to('s:' + s.id).emit('server:removed', { id: s.id });
      io.in('s:' + s.id).socketsLeave('s:' + s.id);
      return { ok: true };
    });

    on('server:rename', ({ serverId, name }) => {
      const s = D.servers[serverId];
      if (!s || s.ownerId !== me.id) return { ok: false, error: 'Only the owner can rename a server.' };
      const n = cleanName(name);
      if (n.length < 2) return { ok: false, error: 'Server name needs at least 2 characters.' };
      s.name = n; db.save(); pushServer(s);
      return { ok: true };
    });

    on('server:new-invite', ({ serverId }) => {
      const s = D.servers[serverId];
      if (!s || s.ownerId !== me.id) return { ok: false, error: 'Only the owner can change the invite.' };
      s.invite = newInvite(); db.save(); pushServer(s);
      return { ok: true, invite: s.invite };
    });

    on('channel:create', ({ serverId, name, type }) => {
      const s = D.servers[serverId];
      if (!s || s.ownerId !== me.id) return { ok: false, error: 'Only the owner can add channels.' };
      const t = type === 'voice' ? 'voice' : 'text';
      const n = t === 'text' ? channelSlug(name) : cleanName(name, 24);
      if (!n) return { ok: false, error: 'Give the channel a name.' };
      if (s.channels.length >= 30) return { ok: false, error: 'This server has too many channels.' };
      const ch = { id: rid(5), name: n, type: t };
      s.channels.push(ch); db.save(); pushServer(s);
      return { ok: true, channel: ch };
    });

    on('channel:delete', ({ serverId, channelId }) => {
      const s = D.servers[serverId];
      if (!s || s.ownerId !== me.id) return { ok: false, error: 'Only the owner can delete channels.' };
      const ch = findChannel(s, channelId);
      if (!ch) return { ok: false, error: 'Channel not found.' };
      if (ch.type === 'text' && s.channels.filter((c) => c.type === 'text').length <= 1) return { ok: false, error: 'A server needs at least one text channel.' };
      const m = voice.get(ch.id);
      if (m) for (const uid of [...m.keys()]) leaveVoice(uid);
      s.channels = s.channels.filter((c) => c.id !== ch.id);
      delete D.messages[ch.id];
      db.save(); pushServer(s);
      return { ok: true };
    });

    // ----- Voice -----
    on('voice:join', ({ channelId }) => {
      const acc = access(me.id, channelId);
      const isCall = !!acc && acc.kind === 'dm';
      if (!acc || (acc.kind === 'server' && acc.channel.type !== 'voice')) return { ok: false, error: 'That is not a voice channel.' };
      if (voiceOf.has(me.id)) leaveVoice(me.id);
      const m = voice.get(channelId) || new Map();
      const peers = [...m.keys()];
      if (peers.length >= (isCall ? 2 : 12)) return { ok: false, error: isCall ? 'This call is full.' : 'This voice channel is full (12 people).' };
      m.set(me.id, { socketId: socket.id, muted: false, deafened: false });
      voice.set(channelId, m);
      voiceOf.set(me.id, channelId);
      socket.join('v:' + channelId);
      broadcastVoice(channelId);
      return { ok: true, peers };
    });

    on('voice:leave', () => { leaveVoice(me.id); socket.rooms.forEach((r) => r.startsWith('v:') && socket.leave(r)); return { ok: true }; });

    on('voice:signal', ({ to, data }) => {
      const cid = voiceOf.get(me.id);
      const target = cid && voice.get(cid) && voice.get(cid).get(to);
      if (!target) return;
      io.to(target.socketId).emit('voice:signal', { from: me.id, data });
    });

    on('voice:status', ({ muted, deafened }) => {
      const cid = voiceOf.get(me.id);
      const entry = cid && voice.get(cid) && voice.get(cid).get(me.id);
      if (!entry) return;
      entry.muted = !!muted; entry.deafened = !!deafened;
      broadcastVoice(cid);
    });

    socket.on('disconnect', () => {
      const cid = voiceOf.get(me.id);
      const entry = cid && voice.get(cid) && voice.get(cid).get(me.id);
      if (entry && entry.socketId === socket.id) leaveVoice(me.id);
      const left = (online.get(me.id) || 1) - 1;
      if (left <= 0) {
        online.delete(me.id);
        announce(false);
      } else online.set(me.id, left);
    });
  });

  // ---------- Lifecycle ----------
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const actual = httpServer.address().port;
      resolve({
        port: actual,
        urls: ['http://localhost:' + actual, ...lanAddresses().map((ip) => `http://${ip}:${actual}`)],
        stop: () => new Promise((r) => {
          db.flush();
          io.close(() => r());
          httpServer.closeAllConnections && httpServer.closeAllConnections();
        })
      });
    });
  });
}

module.exports = { startServer, VERSION };
