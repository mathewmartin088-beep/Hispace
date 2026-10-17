/* Shared client state, preferences and small helpers. */
'use strict';

const desktop = window.hispace || null;
const needsConnect = location.protocol === 'file:';
if (desktop) document.documentElement.classList.add('electron');

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  del(k) { try { localStorage.removeItem(k); } catch (_) {} }
};

const prefs = Object.assign(
  { sfx: true, sfxVol: 0.7, voiceVol: 1, notifs: true, micId: '', noiseSuppression: true, members: true },
  store.get('hs.prefs', {})
);
const savePrefs = () => store.set('hs.prefs', prefs);
SFX.configure({ enabled: prefs.sfx, volume: prefs.sfxVol });

const S = {
  base: '',
  token: null,
  me: null,
  socket: null,
  servers: [],
  users: new Map(),
  online: new Set(),
  dms: [],          // [{user, last}]
  friends: [], incoming: [], outgoing: [],
  friendTab: 'online',
  call: null,       // {channelId, userId, state: 'ringing'|'connected', caller}
  incomingCall: null,
  callTimer: null,
  voice: {},        // channelId -> [{id, muted, deafened}]
  ice: [],
  view: { kind: 'home', serverId: null, channelId: null, dmUser: null },
  last: {},         // serverId -> last visited channel
  msgs: {},         // channelId -> messages (ascending)
  hasMore: {},
  loading: {},
  unread: {},       // channelId -> count
  mention: {},      // channelId -> count (mentions and DMs)
  typing: {},       // channelId -> {userId: expiry}
  drafts: {},
  replyTo: null,
  editingId: null,
  speaking: new Set(),
  voiceCtx: null,   // {channelId, serverId}
  ready: false
};

const dmId = (a, b) => 'dm:' + [a, b].sort().join(':');
const user = (id) => S.users.get(id) || { id, username: 'unknown', hue: 260 };
const userByName = (name) => { for (const u of S.users.values()) if (u.username.toLowerCase() === name) return u; return null; };
const curServer = () => S.servers.find((s) => s.id === S.view.serverId) || null;
const findServerOfChannel = (cid) => S.servers.find((s) => s.channels.some((c) => c.id === cid)) || null;

function rebuildUsers() {
  const map = new Map();
  if (S.me) map.set(S.me.id, S.me);
  S.servers.forEach((s) => s.members.forEach((m) => map.set(m.id, m)));
  S.dms.forEach((d) => map.set(d.user.id, d.user));
  [...S.friends, ...S.incoming, ...S.outgoing].forEach((u) => map.set(u.id, u));
  S.users = map;
}

function curChannel() {
  const v = S.view;
  if (v.kind === 'server') {
    const s = curServer();
    const ch = s && s.channels.find((c) => c.id === v.channelId);
    return ch ? { id: ch.id, name: ch.name, type: ch.type } : null;
  }
  if (v.kind === 'home' && v.dmUser) return { id: dmId(S.me.id, v.dmUser), name: user(v.dmUser).username, type: 'dm' };
  return null;
}

const CONFIG = window.HISPACE_CONFIG || {};
const isFocused = () => document.hasFocus() && !document.hidden;
