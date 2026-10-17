/* Hispace client: boot, networking, navigation and actions. */
'use strict';

const emitP = (event, payload) => new Promise((resolve) => {
  if (!S.socket || !S.socket.connected) return resolve({ ok: false, error: 'You are offline. Reconnecting…' });
  S.socket.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: 'The server did not respond.' } : (res || { ok: false })));
});

/* =============== Gate: connect to a server, then sign in =============== */
function showGate(which) {
  $('#app').classList.add('hidden');
  $('#gate').classList.remove('hidden');
  $('#connect-card').classList.toggle('hidden', which !== 'connect');
  $('#auth-card').classList.toggle('hidden', which !== 'auth');
  if (which === 'auth') {
    $('#auth-server').textContent = S.base ? S.base.replace(/^https?:\/\//, '') : location.host;
    $('#auth-change').classList.toggle('hidden', !(desktop || needsConnect) || !!CONFIG.serverUrl);
    setTimeout(() => $('#auth-user').focus(), 50);
  }
  if (which === 'connect') setTimeout(() => $('#join-addr').focus(), 50);
}

function normalizeAddress(input) {
  let v = input.trim().replace(/\/+$/, '');
  if (!v) return '';
  const hasScheme = /^https?:\/\//i.test(v);
  const hostPart = v.replace(/^https?:\/\//i, '').split(/[/:]/)[0];
  const local = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostPart) || hostPart === 'localhost';
  if (!hasScheme) v = (local ? 'http://' : 'https://') + v;
  let url;
  try { url = new URL(v); } catch (_) { return ''; }
  if (!hasScheme && !url.port && local) url.port = '3000';
  return url.origin;
}

async function ping(base) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(base + '/api/ping', { signal: ctl.signal });
    const j = await r.json();
    return j && j.app === 'hispace';
  } catch (_) { return false; } finally { clearTimeout(t); }
}

async function api(path, body) {
  try {
    const r = await fetch(S.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, ...j } : { ok: false, error: j.error || 'Request failed.' };
  } catch (_) {
    return { ok: false, error: 'Could not reach the server.' };
  }
}

function wireGate() {
  $('#wave').replaceChildren(...waveBars(30));

  // Connect card (first run only, when no server address is built in)
  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#join-error');
    const base = normalizeAddress($('#join-addr').value);
    if (!base) { err.textContent = 'Enter the server address, for example chat.example.com.'; SFX.play('error'); return; }
    err.textContent = '';
    const btn = e.submitter || $('#join-form button[type=submit]');
    btn.disabled = true; btn.textContent = 'Connecting…';
    const ok = await ping(base);
    btn.disabled = false; btn.textContent = 'Connect';
    if (!ok) { err.textContent = 'No Hispace server answered at ' + base.replace(/^https?:\/\//, '') + '. Check the address and your internet connection.'; SFX.play('error'); return; }
    S.base = base; store.set('hs.server', base);
    afterServerChosen();
  });

  // Auth card
  let mode = 'login';
  const setMode = (m) => {
    mode = m;
    $$('#auth-card .seg button').forEach((b) => b.classList.toggle('on', b.dataset.tab === m));
    $('#confirm-row').classList.toggle('hidden', m !== 'register');
    $('#auth-btn').textContent = m === 'login' ? 'Sign in' : 'Create account';
    $('#auth-title').textContent = m === 'login' ? 'Welcome back' : 'Make your account';
    $('#auth-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('#auth-error').textContent = '';
  };
  $$('#auth-card .seg button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.tab); SFX.play('click'); }));

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#auth-error');
    const username = $('#auth-user').value.trim(), password = $('#auth-pass').value;
    if (!username || !password) { err.textContent = 'Enter a username and password.'; SFX.play('error'); return; }
    if (mode === 'register' && password !== $('#auth-pass2').value) { err.textContent = 'The passwords do not match.'; SFX.play('error'); return; }
    err.textContent = '';
    const btn = $('#auth-btn'); btn.disabled = true;
    const res = await api(mode === 'login' ? '/api/login' : '/api/register', { username, password });
    btn.disabled = false;
    if (!res.ok) { err.textContent = res.error; SFX.play('error'); return; }
    S.token = res.token; store.set('hs.token@' + S.base, res.token);
    $('#auth-pass').value = ''; $('#auth-pass2').value = '';
    showGate('none');
    connectSocket();
  });

  $('#auth-change').addEventListener('click', () => { SFX.play('click'); showGate('connect'); });
}

function afterServerChosen() {
  S.token = store.get('hs.token@' + S.base, null);
  if (S.token) { showGate('none'); connectSocket(); } else showGate('auth');
}

/* =============== Socket =============== */
function connectSocket() {
  if (S.socket) S.socket.disconnect();
  S.ready = false;
  const socket = io(S.base, { auth: { token: S.token }, reconnectionDelayMax: 5000 });
  S.socket = socket;

  socket.on('connect', onConnect);
  socket.on('disconnect', () => {
    if (S.socket !== socket) return;
    if (Voice.channelId) { Voice.leave(true); S.voiceCtx = null; toast('Voice disconnected. Rejoin when you are back online.', 'error'); }
    showBanner('Connection lost. Reconnecting…');
  });
  socket.on('connect_error', (err) => {
    if (S.socket !== socket) return;
    if (err.message === 'unauthorized') { signOut(true); return; }
    if (!S.ready) {
      socket.disconnect();
      showGate(desktop || needsConnect ? 'connect' : 'auth');
      $('#join-error').textContent = 'Could not reach ' + (S.base || location.host).replace(/^https?:\/\//, '') + '. Is the server running?';
    }
  });

  socket.on('msg:new', onNewMessage);
  socket.on('msg:update', (m) => {
    const list = S.msgs[m.channelId];
    const idx = list ? list.findIndex((x) => x.id === m.id) : -1;
    if (idx < 0) return;
    list[idx] = m;
    if (curChannel() && curChannel().id === m.channelId) replaceMessageNode(m);
  });
  socket.on('msg:delete', ({ channelId, id }) => {
    const list = S.msgs[channelId];
    if (!list) return;
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return;
    list.splice(idx, 1);
    if (S.replyTo && S.replyTo.id === id) S.replyTo = null;
    if (curChannel() && curChannel().id === channelId) {
      const box = msgsEl(), stick = nearBottom(), top = box.scrollTop;
      renderMessages(); renderComposer();
      if (!stick) box.scrollTop = top;
    }
  });
  socket.on('typing', ({ channelId, userId }) => {
    (S.typing[channelId] = S.typing[channelId] || {})[userId] = Date.now() + 4000;
    if (curChannel() && curChannel().id === channelId) renderTyping();
  });
  socket.on('presence', ({ userId, online }) => {
    if (online) S.online.add(userId); else S.online.delete(userId);
    renderSidebar(); renderMembers(); renderHead();
  });
  socket.on('server:update', (s) => {
    const i = S.servers.findIndex((x) => x.id === s.id);
    if (i >= 0) S.servers[i] = s; else S.servers.push(s);
    rebuildUsers();
    if (S.view.kind === 'server' && S.view.serverId === s.id && !s.channels.some((c) => c.id === S.view.channelId)) { goServer(s.id); return; }
    renderRail(); renderSidebar(); renderHead(); renderMembers();
  });
  socket.on('server:removed', ({ id }) => {
    S.servers = S.servers.filter((s) => s.id !== id);
    if (S.voiceCtx && S.voiceCtx.serverId === id) { Voice.leave(true); S.voiceCtx = null; }
    rebuildUsers();
    if (S.view.serverId === id) { toast('That server is no longer available.'); goHome(); } else renderRail();
  });
  socket.on('friends:update', (f) => {
    S.friends = f.friends; S.incoming = f.incoming; S.outgoing = f.outgoing;
    rebuildUsers();
    renderRail(); renderSidebar(); renderHead(); updateBadge();
    if (S.view.kind === 'home' && !S.view.dmUser && S.friendTab !== 'add') renderMessages(); // the Add tab keeps its confirmation message
  });
  socket.on('friend:request', ({ user: u }) => {
    SFX.play('dm');
    toast(u.username + ' sent you a friend request.');
    notify({ title: 'Friend request', body: u.username + ' wants to be your friend.' });
  });
  socket.on('friend:accepted', ({ user: u }) => { SFX.play('success'); toast('You and ' + u.username + ' are now friends.', 'ok'); });
  socket.on('call:incoming', ({ from, channelId }) => showIncomingCall(from, channelId));
  socket.on('call:cancelled', ({ userId }) => {
    if (S.incomingCall && S.incomingCall.user.id === userId) { const u = S.incomingCall.user; hideIncomingCall(); SFX.play('peerLeave'); toast('Missed call from ' + u.username + '.'); }
  });
  socket.on('call:declined', ({ userId }) => {
    if (S.call && S.call.userId === userId && S.call.state === 'ringing') endCall(false, user(userId).username + ' declined the call.');
  });
  socket.on('voice:state', ({ channelId, participants }) => {
    if (Voice.channelId === channelId) {
      const before = new Set((S.voice[channelId] || []).map((p) => p.id));
      const after = new Set(participants.map((p) => p.id));
      for (const id of after) if (!before.has(id) && id !== S.me.id) SFX.play('peerJoin');
      for (const id of before) if (!after.has(id) && id !== S.me.id) SFX.play('peerLeave');
    }
    S.voice[channelId] = participants;
    if (S.call && S.call.channelId === channelId) {
      if (participants.length >= 2 && S.call.state === 'ringing') { S.call.state = 'connected'; SFX.stopRing(); clearTimeout(S.callTimer); }
      else if (participants.length < 2 && S.call.state === 'connected') { endCall(false, 'The call ended.'); return; }
    }
    renderSidebar(); renderVoiceBar(); renderUserbar(); renderCallStrip();
  });
}

function showBanner(text) {
  const b = $('#conn-banner');
  b.textContent = text;
  b.classList.remove('hidden');
}

function ingest(res) {
  S.me = res.me; S.servers = res.servers; S.dms = res.dms;
  S.friends = res.friends || []; S.incoming = res.incoming || []; S.outgoing = res.outgoing || [];
  S.online = new Set(res.online); S.voice = res.voice || {}; S.ice = res.iceServers || [];
  rebuildUsers();
}

function onConnect() {
  S.socket.emit('bootstrap', {}, (res) => {
    if (!res || !res.ok) { toast('Could not load your account.', 'error'); return; }
    const first = !S.ready;
    ingest(res);
    $('#conn-banner').classList.add('hidden');
    if (first) {
      S.ready = true;
      $('#gate').classList.add('hidden');
      $('#app').classList.remove('hidden');
      restoreView();
      SFX.play('welcome');
      if (!desktop && prefs.notifs && window.Notification && Notification.permission === 'default') {
        document.addEventListener('click', () => Notification.requestPermission(), { once: true });
      }
    } else {
      // Back online after a drop: refresh what is on screen.
      const ch = curChannel();
      if (ch) loadHistory(ch.id, true);
      if (S.view.kind === 'server' && !curServer()) goHome(); else renderAll();
    }
  });
}

function restoreView() {
  const saved = store.get('hs.view@' + S.base, null);
  if (saved && saved.serverId && S.servers.some((s) => s.id === saved.serverId)) goServer(saved.serverId, saved.channelId);
  else if (S.servers[0]) goServer(S.servers[0].id);
  else goHome();
}

/* =============== Navigation and history =============== */
function clearUnread(cid) { delete S.unread[cid]; delete S.mention[cid]; }

function afterNav() {
  const ch = curChannel();
  $('#app').classList.remove('drawer');
  S.editingId = null;
  if (ch) { clearUnread(ch.id); if (!S.msgs[ch.id]) loadHistory(ch.id); }
  renderAll();
  store.set('hs.view@' + S.base, { serverId: S.view.serverId, channelId: S.view.channelId });
}

function goServer(serverId, channelId) {
  const s = S.servers.find((x) => x.id === serverId);
  if (!s) { goHome(); return; }
  const texts = s.channels.filter((c) => c.type === 'text');
  const ch = texts.find((c) => c.id === channelId) || texts.find((c) => c.id === S.last[serverId]) || texts[0];
  S.view = { kind: 'server', serverId, channelId: ch ? ch.id : null, dmUser: null };
  if (ch) S.last[serverId] = ch.id;
  afterNav();
}

async function goHome(userId) {
  if (userId) {
    const res = await emitP('dm:open', { userId });
    if (!res.ok) { toast(res.error, 'error'); SFX.play('error'); return; }
    S.view = { kind: 'home', serverId: null, channelId: null, dmUser: userId };
  } else {
    S.view = { kind: 'home', serverId: null, channelId: null, dmUser: null };
  }
  afterNav();
}

function mergeMsgs(a, b) {
  const map = new Map();
  for (const m of [...a, ...b]) map.set(m.id, m);
  return [...map.values()].sort((x, y) => x.ts - y.ts);
}

async function loadHistory(cid, replace) {
  if (S.loading[cid]) return;
  S.loading[cid] = true;
  const res = await emitP('history', { channelId: cid });
  S.loading[cid] = false;
  if (!res.ok) { toast(res.error, 'error'); return; }
  S.msgs[cid] = replace ? res.messages : mergeMsgs(res.messages, S.msgs[cid] || []);
  S.hasMore[cid] = res.hasMore;
  if (curChannel() && curChannel().id === cid) renderMessages();
}

async function loadMore() {
  const ch = curChannel();
  if (!ch || S.loading[ch.id] || !S.hasMore[ch.id] || !S.msgs[ch.id] || !S.msgs[ch.id].length) return;
  S.loading[ch.id] = true;
  const res = await emitP('history', { channelId: ch.id, before: S.msgs[ch.id][0].id });
  S.loading[ch.id] = false;
  if (!res.ok) return;
  S.msgs[ch.id] = mergeMsgs(res.messages, S.msgs[ch.id]);
  S.hasMore[ch.id] = res.hasMore;
  if (curChannel() && curChannel().id === ch.id) renderMessages(true);
}

/* =============== Incoming messages =============== */
function onNewMessage(m) {
  const cid = m.channelId;
  const mine = m.authorId === S.me.id;
  const isDm = cid.startsWith('dm:');

  if (isDm) {
    const otherId = cid.slice(3).split(':').find((i) => i !== S.me.id) || S.me.id;
    const u = S.users.get(otherId);
    if (u) {
      const d = S.dms.find((x) => x.user.id === otherId);
      if (d) d.last = m.ts; else S.dms.push({ user: u, last: m.ts });
    }
  }

  const list = S.msgs[cid];
  const here = curChannel() && curChannel().id === cid;
  if (list && !list.some((x) => x.id === m.id)) {
    list.push(m);
    if (here) appendMessage(m, mine);
  }
  if (S.typing[cid]) delete S.typing[cid][m.authorId];
  if (here) renderTyping();

  if (!mine && m.type !== 'sys') {
    const viewing = here && isFocused();
    const mention = isDm || mentionsUser(m.text, S.me.username);
    if (!viewing) {
      S.unread[cid] = (S.unread[cid] || 0) + 1;
      if (mention) S.mention[cid] = (S.mention[cid] || 0) + 1;
    }
    SFX.play(mention ? (isDm ? 'dm' : 'mention') : 'receive');
    if (!viewing && mention) {
      const s = findServerOfChannel(cid);
      const ch = s && s.channels.find((c) => c.id === cid);
      notify({
        title: isDm ? user(m.authorId).username : user(m.authorId).username + (ch ? ' in #' + ch.name : ''),
        body: m.text.slice(0, 140), channelId: cid
      });
    }
  }
  renderRail(); renderSidebar(); updateBadge();
}

function notify(payload) {
  if (!prefs.notifs) return;
  if (desktop) { desktop.notify(payload); return; }
  if (window.Notification && Notification.permission === 'granted') {
    const n = new Notification(payload.title, { body: payload.body, icon: 'icon.png', silent: true });
    n.onclick = () => { window.focus(); openChannelById(payload.channelId); n.close(); };
  }
}

function openChannelById(cid) {
  if (!cid) return;
  if (cid.startsWith('dm:')) { const other = cid.slice(3).split(':').find((i) => i !== S.me.id); if (other) goHome(other); return; }
  const s = findServerOfChannel(cid);
  if (s) goServer(s.id, cid);
}

/* =============== Message actions =============== */
async function submitComposer(ta) {
  const ch = curChannel();
  const text = ta.value.trim();
  if (!ch || !text) return;
  const hadReply = !!S.replyTo;
  const replyTo = S.replyTo && S.replyTo.channelId === ch.id ? S.replyTo.id : undefined;
  ta.value = ''; S.drafts[ch.id] = ''; S.replyTo = null;
  if (hadReply) renderComposer(); else ta.dispatchEvent(new Event('input'));
  const res = await emitP('msg:send', { channelId: ch.id, text, replyTo });
  if (res.ok) SFX.play('send');
  else {
    SFX.play('error'); toast(res.error, 'error');
    const cur = $('#composer textarea');
    if (cur && !cur.value) { cur.value = text; S.drafts[ch.id] = text; cur.dispatchEvent(new Event('input')); }
  }
}

async function reactTo(m, emoji) {
  const res = await emitP('msg:react', { channelId: m.channelId, id: m.id, emoji });
  if (!res.ok) { toast(res.error, 'error'); SFX.play('error'); } else SFX.play('click');
}

function startReply(m) { S.replyTo = m; SFX.play('click'); renderComposer(); }

function startEdit(m) {
  if (S.editingId) { const prev = (S.msgs[m.channelId] || []).find((x) => x.id === S.editingId); S.editingId = null; if (prev) replaceMessageNode(prev); }
  const node = msgsEl().querySelector(`[data-id="${CSS.escape(m.id)}"]`);
  const textEl = node && node.querySelector('.text');
  if (!textEl) return;
  S.editingId = m.id;
  const ta = h('textarea', { rows: 1, maxlength: 2000, 'aria-label': 'Edit message' });
  ta.value = m.text;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; };
  const cancel = () => { S.editingId = null; replaceMessageNode(m); $('#composer textarea')?.focus(); };
  const save = async () => {
    const text = ta.value.trim();
    if (!text) return;
    if (text === m.text) { cancel(); return; }
    const res = await emitP('msg:edit', { channelId: m.channelId, id: m.id, text });
    if (!res.ok) { toast(res.error, 'error'); SFX.play('error'); return; }
    S.editingId = null; SFX.play('send');
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
  });
  textEl.replaceWith(h('div', { class: 'edit-box' }, ta, h('p', { class: 'hint' }, 'Enter to save, Esc to cancel')));
  grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}

async function deleteMsg(m) {
  const ok = await confirmDialog({ title: 'Delete this message?', lead: 'This removes it for everyone and cannot be undone.', confirm: 'Delete', danger: true });
  if (!ok) return;
  const res = await emitP('msg:delete', { channelId: m.channelId, id: m.id });
  if (!res.ok) { toast(res.error, 'error'); SFX.play('error'); }
}

/* =============== Voice =============== */
// Opens the microphone and joins a voice room. Returns true on success; shows its own errors.
async function connectVoice(channelId) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('This device cannot use a microphone here.', 'error'); SFX.play('error'); return false; }
  try {
    await Voice.join(S.socket, channelId, { meId: S.me.id, iceServers: S.ice, deviceId: prefs.micId, noiseSuppression: prefs.noiseSuppression, volume: prefs.voiceVol });
    return true;
  } catch (err) {
    SFX.play('error');
    toast(err && err.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in your system or browser settings.' : (err && err.name === 'NotFoundError' ? 'No microphone found.' : (err.message || 'Could not join voice.')), 'error');
    return false;
  }
}

async function joinVoice(s, c) {
  SFX.play('click');
  if (Voice.channelId === c.id) return;
  if (S.call) { toast('Finish your call first.'); return; }
  if (await connectVoice(c.id)) { S.voiceCtx = { channelId: c.id, serverId: s.id }; SFX.play('voiceJoin'); }
  renderSidebar(); renderVoiceBar(); renderUserbar();
}

async function leaveVoice() {
  if (S.call) { await endCall(true); return; }
  await Voice.leave();
  S.voiceCtx = null;
  SFX.play('voiceLeave');
  renderSidebar(); renderVoiceBar(); renderUserbar(); renderCallStrip();
}

/* =============== Friends and calls =============== */
async function addFriend(name, statusEl) {
  const res = await emitP('friend:add', { username: name });
  if (!res.ok) { statusEl.className = 'form-error'; statusEl.textContent = res.error; SFX.play('error'); return false; }
  statusEl.className = 'form-ok';
  statusEl.textContent = res.accepted ? 'You and ' + res.user.username + ' are now friends.' : 'Request sent to ' + res.user.username + '. They need to accept it.';
  SFX.play('success');
  return true;
}

async function friendAction(event, u) {
  const res = await emitP(event, { userId: u.id });
  if (!res.ok) { toast(res.error, 'error'); SFX.play('error'); return; }
  SFX.play(event === 'friend:accept' ? 'success' : 'click');
}

async function removeFriend(u) {
  const ok = await confirmDialog({ title: 'Remove ' + u.username + '?', lead: 'You will no longer be friends. You can add each other again later.', confirm: 'Remove friend', danger: true });
  if (ok) friendAction('friend:remove', u);
}

async function startCall(u) {
  SFX.play('click');
  if (Voice.channelId || S.call) { toast('You are already in a call or voice channel. Leave it first.'); return; }
  const cid = dmId(S.me.id, u.id);
  if (!(await connectVoice(cid))) return;
  S.voiceCtx = { channelId: cid, serverId: null, dmUser: u.id };
  S.call = { channelId: cid, userId: u.id, state: 'ringing', caller: true };
  if (S.view.dmUser !== u.id) await goHome(u.id); else renderAll();
  const res = await emitP('call:ring', { userId: u.id });
  if (!res.ok) { toast(res.error, 'error'); SFX.play('error'); await endCall(false); return; }
  SFX.startRing('outgoing');
  S.callTimer = setTimeout(() => { if (S.call && S.call.state === 'ringing') endCall(true, u.username + ' did not answer.'); }, 45000);
}

async function endCall(notifyPeer, message) {
  const call = S.call;
  clearTimeout(S.callTimer);
  SFX.stopRing();
  S.call = null;
  if (call && notifyPeer && call.state === 'ringing' && call.caller) S.socket && S.socket.emit('call:cancel', { userId: call.userId });
  await Voice.leave();
  S.voiceCtx = null;
  SFX.play('voiceLeave');
  if (message) toast(message);
  renderSidebar(); renderVoiceBar(); renderUserbar(); renderCallStrip();
}

function showIncomingCall(from, channelId) {
  if (Voice.channelId || S.call || S.incomingCall) { S.socket.emit('call:decline', { userId: from.id }); return; }
  S.incomingCall = { user: from, channelId };
  const card = h('div', { id: 'incoming-call', class: 'incoming floating-card', role: 'alertdialog', 'aria-label': 'Incoming call from ' + from.username },
    avatar(from, 56), h('div', { class: 'who' }, h('b', null, from.username), h('span', null, 'is calling you')),
    h('div', { class: 'btns' },
      h('button', { class: 'btn danger', onclick: declineCall }, icon('hangup', 'sm'), 'Decline'),
      h('button', { class: 'btn accept', onclick: answerCall }, icon('phone', 'sm'), 'Answer')));
  $('#layers').appendChild(card);
  SFX.startRing('incoming');
  notify({ title: 'Incoming call', body: from.username + ' is calling you.', channelId: dmId(S.me.id, from.id) });
  S.callTimer = setTimeout(() => { if (S.incomingCall && S.incomingCall.user.id === from.id) { hideIncomingCall(); toast('Missed call from ' + from.username + '.'); } }, 45000);
}

function hideIncomingCall() {
  clearTimeout(S.callTimer);
  SFX.stopRing();
  S.incomingCall = null;
  const c = $('#incoming-call'); if (c) c.remove();
}

async function answerCall() {
  const inc = S.incomingCall;
  if (!inc) return;
  hideIncomingCall();
  if (!(await connectVoice(inc.channelId))) { S.socket.emit('call:decline', { userId: inc.user.id }); return; }
  S.voiceCtx = { channelId: inc.channelId, serverId: null, dmUser: inc.user.id };
  S.call = { channelId: inc.channelId, userId: inc.user.id, state: 'connected', caller: false };
  SFX.play('voiceJoin');
  if (S.view.dmUser !== inc.user.id) await goHome(inc.user.id); else renderAll();
}

function declineCall() {
  const inc = S.incomingCall;
  if (!inc) return;
  S.socket.emit('call:decline', { userId: inc.user.id });
  hideIncomingCall();
  SFX.play('click');
}

function toggleMute() {
  if (!Voice.channelId) { toast('Join a voice channel first.'); return; }
  const r = Voice.toggleMute();
  SFX.play(r.muted ? 'mute' : 'unmute');
  renderUserbar(); renderSidebar();
}

function toggleDeafen() {
  if (!Voice.channelId) { toast('Join a voice channel first.'); return; }
  const r = Voice.toggleDeafen();
  SFX.play(r.deafened ? 'deafen' : 'undeafen');
  renderUserbar(); renderSidebar();
}

/* =============== Servers and channels =============== */
function formModal({ title, lead, fields, submit, onSubmit, danger }) {
  const err = h('p', { class: 'form-error', role: 'alert' });
  const inputs = {};
  const rows = fields.map((f) => {
    const input = f.type === 'select'
      ? h('select', { id: 'f-' + f.name }, ...f.options.map((o) => h('option', { value: o.value }, o.label)))
      : h('input', { id: 'f-' + f.name, type: 'text', maxlength: f.max || 40, placeholder: f.placeholder || '', autocomplete: 'off', spellcheck: 'false' });
    if (f.value !== undefined) input.value = f.value;
    inputs[f.name] = input;
    return [h('label', { for: 'f-' + f.name }, f.label), input];
  });
  const btn = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'submit' }, submit);
  let m;
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const vals = {};
      fields.forEach((f) => { vals[f.name] = inputs[f.name].value; });
      btn.disabled = true;
      const msg = await onSubmit(vals, m);
      btn.disabled = false;
      if (msg) { err.textContent = msg; SFX.play('error'); }
    }
  }, rows, err, h('div', { class: 'foot' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), btn));
  m = modal({ title, lead, body: form });
  return m;
}

function addServerModal() {
  SFX.play('click');
  const m = modal({
    title: 'Add a server', lead: 'Start your own, or join friends with an invite code.',
    body: h('div', { class: 'choice' },
      h('button', { type: 'button', onclick: () => { m.close(); createServerModal(); } }, h('b', null, 'Create a server'), h('span', null, 'A new space for your friends.')),
      h('button', { type: 'button', onclick: () => { m.close(); joinServerModal(); } }, h('b', null, 'Join with a code'), h('span', null, 'Paste an invite you were sent.')))
  });
}

function createServerModal() {
  formModal({
    title: 'Create a server', lead: 'You will get a text channel and a voice channel to start with.',
    fields: [{ name: 'name', label: 'Server name', value: S.me.username + "'s server", max: 32 }], submit: 'Create server',
    onSubmit: async ({ name }, m) => {
      const res = await emitP('server:create', { name });
      if (!res.ok) return res.error;
      S.servers.push(res.server); rebuildUsers(); m.close(); SFX.play('success'); goServer(res.server.id);
      return null;
    }
  });
}

function joinServerModal() {
  formModal({
    title: 'Join a server', lead: 'Invite codes are 8 letters and numbers.',
    fields: [{ name: 'code', label: 'Invite code', placeholder: 'ABCD2345', max: 12 }], submit: 'Join server',
    onSubmit: async ({ code }, m) => {
      const res = await emitP('server:join', { invite: code });
      if (!res.ok) return res.error;
      if (!S.servers.some((s) => s.id === res.server.id)) S.servers.push(res.server); else S.servers = S.servers.map((s) => (s.id === res.server.id ? res.server : s));
      if (res.voice) Object.assign(S.voice, res.voice);
      (res.online || []).forEach((id) => S.online.add(id));
      rebuildUsers(); m.close(); SFX.play('success'); goServer(res.server.id);
      return null;
    }
  });
}

function inviteModal(s) {
  SFX.play('click');
  const code = h('code', null, s.invite);
  const copy = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(s.invite); toast('Invite code copied.', 'ok'); SFX.play('success'); } catch (_) { toast('Could not copy. Select the code and copy it by hand.', 'error'); }
  } }, icon('copy', 'sm'), 'Copy');
  const body = h('div', null, h('div', { class: 'invite-code' }, code, copy),
    h('p', { class: 'hint' }, 'Friends choose "Add a server", then "Join with a code". They also need your server address' + (desktop ? ' (shown in Settings).' : '.')));
  const actions = [{ label: 'Done', kind: 'primary', run: (c) => c() }];
  if (s.ownerId === S.me.id) {
    actions.unshift({ label: 'New code', run: async () => {
      const res = await emitP('server:new-invite', { serverId: s.id });
      if (!res.ok) { toast(res.error, 'error'); return; }
      code.textContent = res.invite; s.invite = res.invite; SFX.play('success'); toast('The old code no longer works.');
    } });
  }
  modal({ title: 'Invite people to ' + s.name, body, actions });
}

function createChannelModal(s, type) {
  SFX.play('click');
  formModal({
    title: 'Create a channel',
    fields: [
      { name: 'type', label: 'Type', type: 'select', value: type, options: [{ value: 'text', label: 'Text: messages and links' }, { value: 'voice', label: 'Voice: talk live' }] },
      { name: 'name', label: 'Name', placeholder: type === 'voice' ? 'Game night' : 'memes', max: 24 }
    ],
    submit: 'Create channel',
    onSubmit: async (v, m) => {
      const res = await emitP('channel:create', { serverId: s.id, name: v.name, type: v.type });
      if (!res.ok) return res.error;
      m.close(); SFX.play('success');
      if (res.channel.type === 'text') setTimeout(() => goServer(s.id, res.channel.id), 60);
      return null;
    }
  });
}

function renameServerModal(s) {
  formModal({
    title: 'Rename server', fields: [{ name: 'name', label: 'Server name', value: s.name, max: 32 }], submit: 'Save',
    onSubmit: async ({ name }, m) => { const res = await emitP('server:rename', { serverId: s.id, name }); if (!res.ok) return res.error; m.close(); SFX.play('success'); return null; }
  });
}

async function deleteChannel(s, c) {
  const ok = await confirmDialog({ title: `Delete ${c.type === 'text' ? '#' : ''}${c.name}?`, lead: c.type === 'text' ? 'All messages in this channel are deleted.' : 'People in the channel are disconnected.', confirm: 'Delete channel', danger: true });
  if (!ok) return;
  const res = await emitP('channel:delete', { serverId: s.id, channelId: c.id });
  if (!res.ok) { toast(res.error, 'error'); SFX.play('error'); }
}

async function leaveServer(s) {
  const ok = await confirmDialog({ title: 'Leave ' + s.name + '?', lead: 'You can join again later with an invite code.', confirm: 'Leave server', danger: true });
  if (!ok) return;
  const res = await emitP('server:leave', { serverId: s.id });
  if (!res.ok) { toast(res.error, 'error'); SFX.play('error'); }
}

async function deleteServer(s) {
  const ok = await confirmDialog({ title: 'Delete ' + s.name + '?', lead: 'All channels and messages are deleted for everyone. This cannot be undone.', confirm: 'Delete server', danger: true });
  if (!ok) return;
  const res = await emitP('server:delete', { serverId: s.id });
  if (!res.ok) { toast(res.error, 'error'); SFX.play('error'); }
}

/* =============== Settings =============== */
const SOUND_LABELS = {
  send: 'Send', ringIn: 'Incoming call', ringOut: 'Calling', receive: 'New message', dm: 'Direct message', mention: 'Mention', voiceJoin: 'You join voice', voiceLeave: 'You leave voice',
  peerJoin: 'Someone joins', peerLeave: 'Someone leaves', mute: 'Mute', unmute: 'Unmute', deafen: 'Deafen', undeafen: 'Undeafen', click: 'Button click', success: 'Success', error: 'Error', welcome: 'Welcome'
};

function openSettings() {
  SFX.play('click');
  const body = h('div');

  body.append(h('h3', null, 'Sound'));
  body.append(switchRow('Sound effects', 'Chimes for messages, voice and buttons.', prefs.sfx, (v) => { prefs.sfx = v; savePrefs(); SFX.configure({ enabled: v }); if (v) SFX.play('success'); }));
  body.append(sliderRow('Effects volume', null, prefs.sfxVol, (v) => { prefs.sfxVol = v; SFX.configure({ volume: v }); }, () => { savePrefs(); SFX.play('receive'); }));
  const grid = h('div', { class: 'sound-grid' });
  SFX.names.forEach((n) => grid.append(h('button', { type: 'button', onclick: () => SFX.play(n) }, SOUND_LABELS[n] || n)));
  body.append(h('div', { class: 'row', style: { display: 'block' } }, h('div', { class: 'what' }, h('b', null, 'Preview sounds')), grid));

  body.append(h('h3', null, 'Voice'));
  const sel = h('select', { 'aria-label': 'Microphone' });
  const fill = async () => {
    let devs = [];
    try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch (_) {}
    sel.replaceChildren(h('option', { value: '' }, 'System default'), ...devs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => h('option', { value: d.deviceId }, d.label || 'Microphone')));
    sel.value = prefs.micId;
    if (sel.value !== prefs.micId) sel.value = '';
  };
  fill();
  sel.addEventListener('change', () => {
    prefs.micId = sel.value; savePrefs();
    if (Voice.channelId) Voice.setInputDevice(prefs.micId, prefs.noiseSuppression).catch(() => toast('Could not switch microphone.', 'error'));
  });
  body.append(h('div', { class: 'row', style: { display: 'block' } }, h('div', { class: 'what', style: { marginBottom: '8px' } }, h('b', null, 'Microphone'), h('span', null, 'Names appear after you have joined a voice channel once.')), sel));
  body.append(switchRow('Noise suppression', 'Reduces keyboard and fan noise. Applies next time you join.', prefs.noiseSuppression, (v) => { prefs.noiseSuppression = v; savePrefs(); }));
  body.append(sliderRow('Voice volume', 'How loud other people sound.', prefs.voiceVol, (v) => { prefs.voiceVol = v; Voice.setVolume(v); }, savePrefs));

  body.append(h('h3', null, 'Notifications'));
  body.append(switchRow('Desktop notifications', 'For direct messages and @mentions when you are not looking.', prefs.notifs, (v) => {
    prefs.notifs = v; savePrefs();
    if (v && !desktop && window.Notification && Notification.permission === 'default') Notification.requestPermission();
  }));

  const deskBox = h('div');
  body.append(deskBox);
  if (desktop) {
    desktop.getSettings().then((st) => {
      deskBox.append(h('h3', null, 'This computer'));
      deskBox.append(switchRow('Keep running in the tray', 'Closing the window hides Hispace instead of quitting, so you still get messages and calls.', st.closeToTray, (v) => desktop.setSettings({ closeToTray: v })));
      deskBox.append(switchRow('Start with Windows', null, st.launchAtLogin, (v) => desktop.setSettings({ launchAtLogin: v })));
        });
  }

  body.append(h('h3', null, 'Account'));
  body.append(h('div', { class: 'row' }, h('div', { class: 'what' }, h('b', null, S.me.username), h('span', null, 'Server: ' + (S.base || location.host).replace(/^https?:\/\//, ''))),
    h('button', { class: 'btn danger', type: 'button', onclick: () => { document.querySelector('.backdrop')?.remove(); signOut(false); } }, icon('logout', 'sm'), 'Sign out')));
  if (desktop || needsConnect) {
    body.append(h('div', { class: 'row' }, h('div', { class: 'what' }, h('b', null, 'Change server'), h('span', null, 'Connect to a different Hispace server.')),
      h('button', { class: 'btn', type: 'button', onclick: () => { document.querySelector('.backdrop')?.remove(); switchServer(); } }, 'Change')));
  }

  modal({ title: 'Settings', body, wide: true, actions: [{ label: 'Done', kind: 'primary', run: (c) => c() }] });
}

/* =============== Sign out / switch =============== */
function resetSession() {
  Voice.leave(true); SFX.stopRing(); hideIncomingCall(); clearTimeout(S.callTimer);
  if (S.socket) { S.socket.disconnect(); S.socket = null; }
  Object.assign(S, { me: null, servers: [], users: new Map(), online: new Set(), dms: [], voice: {}, msgs: {}, hasMore: {}, loading: {}, unread: {}, mention: {}, typing: {}, drafts: {}, replyTo: null, editingId: null, speaking: new Set(), voiceCtx: null, friends: [], incoming: [], outgoing: [], call: null, incomingCall: null, friendTab: 'online', ready: false, view: { kind: 'home', serverId: null, channelId: null, dmUser: null } });
  updateBadge();
}

function signOut(expired) {
  store.del('hs.token@' + S.base);
  S.token = null;
  resetSession();
  showGate('auth');
  if (expired) $('#auth-error').textContent = 'Your session ended. Sign in again.';
}

function switchServer() {
  resetSession();
  store.del('hs.server');
  showGate('connect');
}

/* =============== Boot =============== */
async function boot() {
  wireGate();

  $('#rail-add').addEventListener('click', addServerModal);
  $('#scrim').addEventListener('click', () => $('#app').classList.remove('drawer'));
  $('#jump').addEventListener('click', () => { toBottom(); $('#jump').classList.add('hidden'); });
  $('#messages').addEventListener('scroll', () => {
    const box = msgsEl();
    if (nearBottom()) $('#jump').classList.add('hidden');
    if (box.scrollTop < 80) loadMore();
  });
  $('#composer').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' || e.target.tagName !== 'TEXTAREA' || e.target.value) return;
    const ch = curChannel();
    const mineMsgs = ch && (S.msgs[ch.id] || []).filter((m) => m.authorId === S.me.id && m.type !== 'sys');
    if (mineMsgs && mineMsgs.length) { e.preventDefault(); startEdit(mineMsgs[mineMsgs.length - 1]); }
  });
  window.addEventListener('focus', () => {
    const ch = curChannel();
    if (ch && S.ready) { clearUnread(ch.id); renderRail(); renderSidebar(); updateBadge(); }
  });
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const cid of Object.keys(S.typing)) for (const [id, exp] of Object.entries(S.typing[cid])) if (exp < now) { delete S.typing[cid][id]; changed = true; }
    if (changed) renderTyping();
  }, 1000);

  Voice.on('speaking', applySpeaking);
  if (desktop) desktop.onNotificationClick((payload) => openChannelById(payload.channelId));

  if (needsConnect) {
    S.base = store.get('hs.server', '') || (CONFIG.serverUrl || '').replace(/\/+$/, '');
    if (!S.base) { showGate('connect'); return; }
    showGate('none');
    if (!(await ping(S.base))) {
      showGate('connect');
      $('#join-addr').value = S.base.replace(/^https?:\/\//, '');
      $('#join-error').textContent = 'Could not reach ' + S.base.replace(/^https?:\/\//, '') + '. Check your internet connection and the address.';
      return;
    }
  } else {
    S.base = location.origin;
  }
  afterServerChosen();
}

boot();
