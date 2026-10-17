/* Rendering. Each function rebuilds one region of the UI from state S. */
'use strict';

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

function renderAll() {
  renderRail();
  renderSidebar();
  renderHead();
  renderMessages();
  renderComposer();
  renderMembers();
  renderUserbar();
  renderVoiceBar();
  renderCallStrip();
  renderTyping();
  const showMembers = prefs.members && S.view.kind === 'server';
  $('#app').classList.toggle('no-members', !showMembers);
  updateBadge();
}

/* ---------- rail ---------- */
function serverUnread(s) {
  let dot = false, mentions = 0;
  for (const c of s.channels) {
    if (S.unread[c.id]) dot = true;
    mentions += S.mention[c.id] || 0;
  }
  return { dot, mentions };
}

function dmUnreadTotal() {
  let n = 0;
  for (const k of Object.keys(S.mention)) if (k.startsWith('dm:')) n += S.mention[k];
  return n;
}

function renderRail() {
  const home = $('#rail-home');
  home.classList.toggle('active', S.view.kind === 'home');
  home.querySelector('.badge')?.remove();
  const dmN = dmUnreadTotal() + S.incoming.length;
  if (dmN) home.append(h('span', { class: 'badge' }, String(dmN > 99 ? '99+' : dmN)));
  home.onclick = () => { SFX.play('click'); goHome(S.view.dmUser); };

  const list = $('#server-list');
  list.replaceChildren();
  for (const s of S.servers) {
    const u = serverUnread(s);
    const b = h('button', {
      class: 'rail-btn' + (S.view.serverId === s.id && S.view.kind === 'server' ? ' active' : '') + (u.dot ? ' unread' : ''),
      title: s.name, 'aria-label': s.name,
      onclick: () => { SFX.play('click'); goServer(s.id); }
    }, initials(s.name));
    if (u.mentions) b.append(h('span', { class: 'badge' }, String(u.mentions > 99 ? '99+' : u.mentions)));
    list.append(b);
  }
}

/* ---------- sidebar ---------- */
function renderSidebar() {
  const head = $('#sb-head');
  const box = $('#sb-scroll');
  head.replaceChildren();
  box.replaceChildren();
  head.classList.toggle('server-head', S.view.kind === 'server');

  if (S.view.kind === 'home') {
    head.append(h('h2', null, 'Home'));
    renderDmList(box);
    return;
  }
  const s = curServer();
  if (!s) return;

  const title = h('button', { class: 'head-btn', 'aria-label': 'Server menu', onclick: (e) => serverMenu(e.currentTarget, s) },
    h('h2', null, s.name), icon('chevron'));
  head.append(title);

  const isOwner = s.ownerId === S.me.id;
  const textCh = s.channels.filter((c) => c.type === 'text');
  const voiceCh = s.channels.filter((c) => c.type === 'voice');

  box.append(groupLabel('Text channels', isOwner ? () => createChannelModal(s, 'text') : null));
  for (const c of textCh) {
    const unread = S.unread[c.id], men = S.mention[c.id];
    const it = h('button', { class: 'item' + (S.view.channelId === c.id ? ' active' : '') + (unread ? ' unread' : ''), onclick: () => { SFX.play('click'); goServer(s.id, c.id); } },
      icon('hash'), h('span', { class: 'name' }, c.name),
      men ? h('span', { class: 'pill' }, String(men)) : (unread ? h('span', { class: 'dot-unread' }) : null),
      isOwner ? h('span', { class: 'icon-btn del', role: 'button', title: 'Delete channel', onclick: (e) => { e.stopPropagation(); deleteChannel(s, c); } }, icon('trash', 'sm')) : null);
    box.append(it);
  }

  box.append(groupLabel('Voice channels', isOwner ? () => createChannelModal(s, 'voice') : null));
  for (const c of voiceCh) {
    const inHere = Voice.channelId === c.id;
    const parts = S.voice[c.id] || [];
    box.append(h('button', { class: 'item' + (inHere ? ' active' : ''), onclick: () => joinVoice(s, c) },
      icon('volume'), h('span', { class: 'name' }, c.name),
      parts.length ? h('span', { style: { fontSize: '12px', color: 'var(--faint)' } }, String(parts.length)) : null,
      isOwner ? h('span', { class: 'icon-btn del', role: 'button', title: 'Delete channel', onclick: (e) => { e.stopPropagation(); deleteChannel(s, c); } }, icon('trash', 'sm')) : null));
    if (parts.length) {
      const wrap = h('div', { class: 'vparts' });
      for (const p of parts) {
        const u = user(p.id);
        const a = avatar(u, 22);
        if (S.speaking.has(p.id)) a.classList.add('speaking');
        wrap.append(h('div', { class: 'vpart' }, a, h('span', { class: 'name' }, u.username + (p.id === S.me.id ? ' (you)' : '')), p.deafened ? icon('headphones-off') : (p.muted ? icon('mic-off') : null)));
      }
      box.append(wrap);
    }
  }
}

function groupLabel(text, onAdd) {
  return h('div', { class: 'group-label' }, h('span', null, text), onAdd ? h('button', { class: 'icon-btn', title: 'Add channel', 'aria-label': 'Add ' + text, onclick: onAdd }, icon('plus', 'sm')) : null);
}

function renderDmList(box) {
  const pending = S.incoming.length;
  box.append(h('button', { class: 'item' + (!S.view.dmUser ? ' active' : ''), onclick: () => { SFX.play('click'); S.friendTab = pending ? 'pending' : S.friendTab; S.view.dmUser = null; goHome(); } },
    icon('users'), h('span', { class: 'name' }, 'Friends'), pending ? h('span', { class: 'pill' }, String(pending)) : null));

  const recent = [...S.dms].sort((a, b) => b.last - a.last);
  box.append(groupLabel('Direct messages'));
  for (const d of recent) box.append(personItem(d.user));
  if (!recent.length) {
    box.append(h('p', { class: 'hint', style: { padding: '8px 10px' } }, S.friends.length ? 'Open the Friends tab and press Message to start a chat.' : 'Add a friend by username to start chatting.'));
  }
}

function personItem(u) {
  const cid = dmId(S.me.id, u.id);
  const unread = S.unread[cid], men = S.mention[cid];
  return h('button', { class: 'item' + (S.view.dmUser === u.id ? ' active' : '') + (unread ? ' unread' : ''), onclick: () => { SFX.play('click'); goHome(u.id); } },
    avatar(u, 28, { status: true, online: S.online.has(u.id) }), h('span', { class: 'name' }, u.username),
    men ? h('span', { class: 'pill' }, String(men)) : null);
}

function serverMenu(anchor, s) {
  const owner = s.ownerId === S.me.id;
  const items = [{ label: 'Invite people', icon: 'users', run: () => inviteModal(s) }];
  if (owner) {
    items.push({ label: 'Create channel', icon: 'plus', run: () => createChannelModal(s, 'text') });
    items.push({ label: 'Rename server', icon: 'edit', run: () => renameServerModal(s) });
    items.push('-');
    items.push({ label: 'Delete server', icon: 'trash', danger: true, run: () => deleteServer(s) });
  } else {
    items.push('-');
    items.push({ label: 'Leave server', icon: 'logout', danger: true, run: () => leaveServer(s) });
  }
  menu(anchor, items);
}

/* ---------- header ---------- */
function renderHead() {
  const head = $('#chat-head');
  head.replaceChildren();
  head.append(h('button', { id: 'menu-btn', class: 'icon-btn', 'aria-label': 'Open menu', onclick: () => $('#app').classList.add('drawer') }, icon('menu')));
  const ch = curChannel();
  if (!ch && S.view.kind === 'home') {
    head.append(h('span', { class: 'ch-icon' }, icon('users')), h('h1', null, 'Friends'));
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const mk = (key, label, extra) => h('button', { class: 'tab' + (S.friendTab === key ? ' on' : '') + (key === 'add' ? ' add' : ''), role: 'tab', onclick: () => { S.friendTab = key; SFX.play('click'); renderHead(); renderMessages(); } }, label, extra || null);
    tabs.append(mk('online', 'Online'), mk('all', 'All'), mk('pending', 'Pending', S.incoming.length ? h('span', { class: 'pill' }, String(S.incoming.length)) : null), mk('add', 'Add friend'));
    head.append(tabs);
    return;
  }
  if (!ch) { head.append(h('h1', null, 'Hispace')); return; }
  if (ch.type === 'dm') {
    const u = user(S.view.dmUser);
    head.append(avatar(u, 26, { status: true, online: S.online.has(u.id) }), h('h1', null, u.username), h('span', { class: 'sub' }, S.online.has(u.id) ? 'Online' : 'Offline'),
      h('div', { class: 'grow' }),
      h('button', { class: 'icon-btn', title: 'Start voice call', 'aria-label': 'Start voice call with ' + u.username, onclick: () => startCall(u) }, icon('phone')));
    return;
  } else {
    head.append(h('span', { class: 'ch-icon' }, icon('hash')), h('h1', null, ch.name));
    const s = curServer();
    if (s) head.append(h('span', { class: 'sub' }, s.name));
  }
  head.append(h('div', { class: 'grow' }));
  if (S.view.kind === 'server') {
    head.append(h('button', { class: 'icon-btn' + (prefs.members ? ' on' : ''), title: 'Toggle member list', 'aria-label': 'Toggle member list', onclick: () => { prefs.members = !prefs.members; savePrefs(); SFX.play('click'); renderAll(); } }, icon('users')));
  }
}

/* ---------- messages ---------- */
const msgsEl = () => $('#messages');
const nearBottom = () => { const e = msgsEl(); return e.scrollHeight - e.scrollTop - e.clientHeight < 90; };
const toBottom = () => { const e = msgsEl(); e.scrollTop = e.scrollHeight; };

function daySep(ts) { return h('div', { class: 'day-sep', role: 'separator' }, fmtDay(ts)); }

function renderMessages(keepScroll) {
  const box = msgsEl();
  const ch = curChannel();
  const prevHeight = box.scrollHeight, prevTop = box.scrollTop;
  box.replaceChildren();
  $('#jump').classList.add('hidden');

  if (!ch && S.view.kind === 'home') { renderFriendsPanel(); return; }
  if (!ch) {
    box.append(h('div', { class: 'empty' },
      h('div', { class: 'wave', 'aria-hidden': 'true' }, ...waveBars(9)),
      h('h3', null, S.view.kind === 'home' ? 'Pick someone to talk to' : 'Nothing selected'),
      h('p', null, S.view.kind === 'home' ? 'Choose a person on the left to start a private conversation.' : 'Choose a channel on the left.')));
    return;
  }
  const list = S.msgs[ch.id];
  if (!list) { box.append(h('div', { class: 'empty' }, h('p', null, 'Loading messages…'))); return; }

  if (!S.hasMore[ch.id]) {
    box.append(h('div', { class: 'start-card' },
      h('h3', null, ch.type === 'dm' ? 'Your chat with ' + ch.name : 'Welcome to #' + ch.name),
      h('p', null, ch.type === 'dm' ? 'This is where your conversation starts. Say hi.' : 'This is the start of the channel.')));
  }
  list.forEach((m, i) => {
    const prev = list[i - 1];
    if (!prev || !sameDay(prev.ts, m.ts)) box.append(daySep(m.ts));
    box.append(msgNode(m, prev));
  });
  if (keepScroll) box.scrollTop = box.scrollHeight - prevHeight + prevTop; else toBottom();
}

function waveBars(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = 0.25 + 0.75 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6));
    out.push(h('i', { style: { '--a': a.toFixed(2), '--d': (i * 0.11).toFixed(2) + 's' } }));
  }
  return out;
}

function msgNode(m, prev) {
  if (m.type === 'sys') {
    return h('div', { class: 'msg sys', 'data-id': m.id },
      h('div', { class: 'gutter' }, icon('users')),
      h('div', null, h('b', null, user(m.authorId).username), ' ' + m.text + ' ', h('span', { class: 'time' }, fmtTime(m.ts))));
  }
  const u = user(m.authorId);
  const cont = !!prev && prev.type !== 'sys' && prev.authorId === m.authorId && m.ts - prev.ts < 5 * 60 * 1000 && sameDay(prev.ts, m.ts) && !m.reply;
  const mine = m.authorId === S.me.id;
  const mentioned = !mine && mentionsUser(m.text, S.me.username);
  const s = findServerOfChannel(m.channelId);
  const canDelete = mine || (s && s.ownerId === S.me.id);
  const ctx = { userByName };

  const body = h('div', { class: 'body' });
  if (!cont) {
    body.append(h('div', { class: 'meta' },
      h('span', { class: 'author', style: { color: `hsl(${u.hue} 85% 78%)` }, onclick: () => u.id !== S.me.id && goHome(u.id) }, u.username),
      h('span', { class: 'time' }, fmtTime(m.ts))));
  }
  if (m.reply) {
    const r = m.reply;
    body.append(h('div', { class: 'reply-ref', onclick: () => jumpToMessage(r.id) }, icon('reply', 'sm'),
      r.deleted ? h('span', { class: 't' }, 'Original message was deleted')
        : [h('b', null, user(r.authorId).username), h('span', { class: 't' }, r.text)]));
  }
  body.append(h('div', { class: 'text' }, richText(m.text, ctx), m.edited ? h('span', { class: 'edited', title: 'Edited ' + fmtTime(m.edited) }, ' (edited)') : null));

  const ids = Object.keys(m.reactions || {});
  if (ids.length) {
    const row = h('div', { class: 'reactions' });
    for (const em of ids) {
      const who = m.reactions[em];
      row.append(h('button', { class: 'react' + (who.includes(S.me.id) ? ' mine' : ''), title: who.map((i) => user(i).username).join(', '), onclick: () => reactTo(m, em) }, em, h('span', { class: 'n' }, String(who.length))));
    }
    body.append(row);
  }

  const actions = h('div', { class: 'actions' },
    ...QUICK_REACTIONS.slice(0, 3).map((em) => h('button', { class: 'icon-btn', title: 'React ' + em, 'aria-label': 'React ' + em, onclick: () => reactTo(m, em) }, em)),
    h('button', { class: 'icon-btn', title: 'More reactions', 'aria-label': 'More reactions', onclick: (e) => emojiPicker(e.currentTarget, (em) => reactTo(m, em)) }, icon('smile')),
    h('button', { class: 'icon-btn', title: 'Reply', 'aria-label': 'Reply', onclick: () => startReply(m) }, icon('reply')),
    mine ? h('button', { class: 'icon-btn', title: 'Edit', 'aria-label': 'Edit', onclick: () => startEdit(m) }, icon('edit')) : null,
    canDelete ? h('button', { class: 'icon-btn danger', title: 'Delete', 'aria-label': 'Delete', onclick: () => deleteMsg(m) }, icon('trash')) : null);

  const gutter = cont
    ? h('div', { class: 'gutter' }, h('span', { class: 't' }, fmtTime(m.ts)))
    : h('div', { class: 'gutter' }, h('div', { onclick: () => u.id !== S.me.id && goHome(u.id) }, avatar(u, 38)));

  return h('div', { class: 'msg' + (cont ? '' : ' first') + (mentioned ? ' mentioned' : ''), 'data-id': m.id }, gutter, body, actions);
}

function appendMessage(m, own) {
  const list = S.msgs[m.channelId];
  const prev = list[list.length - 2];
  const box = msgsEl();
  const stick = nearBottom() || own;
  if (!prev || !sameDay(prev.ts, m.ts)) box.append(daySep(m.ts));
  box.append(msgNode(m, prev));
  if (stick) { toBottom(); $('#jump').classList.add('hidden'); } else $('#jump').classList.remove('hidden');
}

function replaceMessageNode(m) {
  const list = S.msgs[m.channelId] || [];
  const idx = list.findIndex((x) => x.id === m.id);
  const node = msgsEl().querySelector(`[data-id="${CSS.escape(m.id)}"]`);
  if (idx < 0 || !node) return;
  node.replaceWith(msgNode(m, list[idx - 1]));
}

function jumpToMessage(id) {
  const node = msgsEl().querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!node) { toast('That message is older than what is loaded.'); return; }
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
}

/* ---------- composer ---------- */
function renderComposer() {
  const box = $('#composer');
  box.replaceChildren();
  const ch = curChannel();
  if (!ch) return;

  if (S.replyTo && S.replyTo.channelId === ch.id) {
    box.append(h('div', { class: 'reply-bar' }, icon('reply', 'sm'),
      h('span', { class: 'grow' }, 'Replying to ', h('b', null, user(S.replyTo.authorId).username), ': ' + S.replyTo.text.slice(0, 80)),
      h('button', { class: 'icon-btn', style: { width: '24px', height: '24px' }, 'aria-label': 'Cancel reply', onclick: () => { S.replyTo = null; renderComposer(); } }, icon('x', 'sm'))));
  } else S.replyTo = null;

  const ta = h('textarea', { rows: 1, placeholder: ch.type === 'dm' ? 'Message @' + ch.name : 'Message #' + ch.name, 'aria-label': 'Message', maxlength: 2000 });
  ta.value = S.drafts[ch.id] || '';
  const send = h('button', { class: 'send-btn', type: 'button', title: 'Send', 'aria-label': 'Send message', onclick: () => submitComposer(ta) }, icon('send'));
  const sync = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
    send.classList.toggle('ready', ta.value.trim().length > 0);
    S.drafts[ch.id] = ta.value;
  };
  let lastTyping = 0;
  ta.addEventListener('input', () => {
    sync();
    if (!ta.value.trim()) { lastTyping = 0; return; } // cleared or sent: next keystroke signals again
    const now = Date.now();
    if (now - lastTyping > 2500 && S.socket) { lastTyping = now; S.socket.emit('typing', { channelId: ch.id }); }
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitComposer(ta); }
    else if (e.key === 'Escape' && S.replyTo) { S.replyTo = null; renderComposer(); }
  });
  ta.addEventListener('paste', () => setTimeout(sync, 0));
  const emojiBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Emoji', 'aria-label': 'Insert emoji', onclick: (e) => emojiPicker(e.currentTarget, (em) => { ta.setRangeText(em, ta.selectionStart, ta.selectionEnd, 'end'); ta.focus(); sync(); }) }, icon('smile'));
  box.append(h('div', { class: 'composer-box' }, ta, emojiBtn, send));
  sync();
  if (!S.editingId) ta.focus({ preventScroll: true });
}

function renderTyping() {
  const el = $('#typing');
  el.replaceChildren();
  const ch = curChannel();
  if (!ch) return;
  const t = S.typing[ch.id] || {};
  const now = Date.now();
  const names = Object.entries(t).filter(([id, exp]) => exp > now && id !== S.me.id).map(([id]) => user(id).username);
  if (!names.length) return;
  const text = names.length === 1 ? names[0] + ' is typing' : names.length === 2 ? names.join(' and ') + ' are typing' : 'Several people are typing';
  el.append(h('span', { class: 'dots' }, h('i'), h('i'), h('i')), h('span', null, text));
}

/* ---------- members ---------- */
function renderMembers() {
  const box = $('#members');
  box.replaceChildren();
  const s = curServer();
  if (S.view.kind !== 'server' || !s) return;
  const on = s.members.filter((m) => S.online.has(m.id));
  const off = s.members.filter((m) => !S.online.has(m.id));
  const row = (m) => h('button', { class: 'item' + (S.online.has(m.id) ? '' : ' off'), onclick: () => m.id !== S.me.id && goHome(m.id) },
    avatar(m, 28, { status: true, online: S.online.has(m.id) }), h('span', { class: 'name' }, m.username),
    m.id === s.ownerId ? h('span', { class: 'crown-mark', title: 'Owner' }, '★') : null);
  box.append(groupLabel('Online · ' + on.length));
  on.forEach((m) => box.append(row(m)));
  if (off.length) { box.append(groupLabel('Offline · ' + off.length)); off.forEach((m) => box.append(row(m))); }
}

/* ---------- user bar and voice bar ---------- */
function renderUserbar() {
  const bar = $('#userbar');
  bar.replaceChildren();
  if (!S.me) return;
  const inVoice = !!Voice.channelId;
  const a = avatar(S.me, 34);
  if (S.speaking.has(S.me.id)) a.classList.add('speaking');
  bar.append(a,
    h('div', { class: 'who' }, h('div', { class: 'uname' }, S.me.username), h('div', { class: 'ustate' }, inVoice ? 'In voice' : 'Online')),
    h('button', { class: 'icon-btn' + (inVoice && Voice.muted ? ' off' : ''), title: Voice.muted ? 'Unmute' : 'Mute', 'aria-label': 'Toggle microphone', style: { opacity: inVoice ? 1 : 0.55 }, onclick: toggleMute }, icon(inVoice && Voice.muted ? 'mic-off' : 'mic')),
    h('button', { class: 'icon-btn' + (inVoice && Voice.deafened ? ' off' : ''), title: Voice.deafened ? 'Undeafen' : 'Deafen', 'aria-label': 'Toggle deafen', style: { opacity: inVoice ? 1 : 0.55 }, onclick: toggleDeafen }, icon(inVoice && Voice.deafened ? 'headphones-off' : 'headphones')),
    h('button', { class: 'icon-btn', title: 'Settings', 'aria-label': 'Settings', onclick: openSettings }, icon('settings')));
}

function renderVoiceBar() {
  const bar = $('#voice-bar');
  bar.replaceChildren();
  if (!Voice.channelId || !S.voiceCtx) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const s = S.servers.find((x) => x.id === S.voiceCtx.serverId);
  const ch = s && s.channels.find((c) => c.id === S.voiceCtx.channelId);
  const isCall = !!S.voiceCtx.dmUser;
  const where = isCall ? 'with ' + user(S.voiceCtx.dmUser).username : (ch ? ch.name + ' · ' + s.name : '');
  const status = isCall ? (S.call && S.call.state === 'ringing' ? 'Calling…' : 'In a call') : 'Voice connected';
  bar.append(h('div', { class: 'info' }, h('div', { class: 'live' }, status), h('div', { class: 'where' }, where)),
    h('button', { class: 'icon-btn off', title: 'Leave voice', 'aria-label': 'Leave voice channel', onclick: leaveVoice }, icon('hangup')));
}

/* ---------- unread badge and title ---------- */
let lastBadge = -1;
function updateBadge() {
  let total = 0;
  for (const n of Object.values(S.mention)) total += n;
  total += S.incoming.length;
  document.title = total ? `(${total > 99 ? '99+' : total}) Hispace` : 'Hispace';
  if (desktop && total !== lastBadge) {
    lastBadge = total;
    if (!total) { desktop.setBadge(null); return; }
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.fillStyle = '#ff6f91';
    g.beginPath(); g.arc(16, 16, 15, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2a0010';
    g.font = '700 ' + (total > 9 ? 16 : 20) + 'px Figtree, Segoe UI, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(total > 99 ? '99+' : String(total), 16, 17);
    desktop.setBadge(c.toDataURL('image/png'));
  }
}

function applySpeaking(userId, on) {
  if (on) S.speaking.add(userId); else S.speaking.delete(userId);
  $$('.vpart [data-uid="' + userId + '"], #call-strip [data-uid="' + userId + '"]').forEach((n) => n.classList.toggle('speaking', on));
  if (userId === S.me.id) $$('#userbar [data-uid]').forEach((n) => n.classList.toggle('speaking', on));
}

/* ---------- friends ---------- */
function renderFriendsPanel() {
  const box = msgsEl();
  box.replaceChildren();
  const wrap = h('div', { class: 'friends-panel' });
  box.append(wrap);
  const tab = S.friendTab;

  if (tab === 'add') {
    const status = h('p', { class: 'form-error', role: 'status' });
    const input = h('input', { type: 'text', maxlength: 21, placeholder: 'Their username', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Username' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, icon('user-plus', 'sm'), 'Send request');
    const form = h('form', { class: 'add-form', onsubmit: async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) { status.className = 'form-error'; status.textContent = 'Type a username.'; return; }
      btn.disabled = true;
      const ok = await addFriend(name, status);
      btn.disabled = false;
      if (ok) { input.value = ''; }
      input.focus();
    } }, input, btn);
    wrap.append(h('h2', null, 'Add a friend'), h('p', { class: 'lead' }, 'Type your friend\'s exact username. Capital letters do not matter.'), form, status);
    setTimeout(() => input.focus(), 30);
    return;
  }

  if (tab === 'pending') {
    if (!S.incoming.length && !S.outgoing.length) { wrap.append(emptyFriends('No pending requests', 'When someone adds you, or you add someone, it shows up here.')); return; }
    if (S.incoming.length) wrap.append(h('h3', { class: 'list-title' }, 'Wants to be your friend · ' + S.incoming.length));
    S.incoming.forEach((u) => wrap.append(friendRow(u, 'incoming')));
    if (S.outgoing.length) wrap.append(h('h3', { class: 'list-title' }, 'Waiting for them to accept · ' + S.outgoing.length));
    S.outgoing.forEach((u) => wrap.append(friendRow(u, 'outgoing')));
    return;
  }

  const sorted = [...S.friends].sort((a, b) => (S.online.has(b.id) - S.online.has(a.id)) || a.username.localeCompare(b.username));
  const list = tab === 'online' ? sorted.filter((u) => S.online.has(u.id)) : sorted;
  if (!list.length) {
    if (!S.friends.length) wrap.append(emptyFriends('No friends yet', 'Add someone by their username and start talking.', true));
    else wrap.append(emptyFriends('Nobody is online', 'Your friends will show up here when they are.'));
    return;
  }
  wrap.append(h('h3', { class: 'list-title' }, (tab === 'online' ? 'Online' : 'All friends') + ' · ' + list.length));
  list.forEach((u) => wrap.append(friendRow(u, 'friend')));
}

function emptyFriends(title, text, withAdd) {
  return h('div', { class: 'empty' },
    h('div', { class: 'wave', 'aria-hidden': 'true' }, ...waveBars(9)),
    h('h3', null, title), h('p', null, text),
    withAdd ? h('button', { class: 'btn primary', onclick: () => { S.friendTab = 'add'; renderHead(); renderMessages(); } }, icon('user-plus', 'sm'), 'Add a friend') : null);
}

function friendRow(u, kind) {
  const on = S.online.has(u.id);
  const row = h('div', { class: 'friend-row' }, avatar(u, 40, { status: kind === 'friend', online: on }),
    h('div', { class: 'who' }, h('div', { class: 'n' }, u.username),
      h('div', { class: 's' }, kind === 'friend' ? (on ? 'Online' : 'Offline') : (kind === 'incoming' ? 'Sent you a request' : 'Request sent'))));
  const btns = h('div', { class: 'btns' });
  if (kind === 'friend') {
    btns.append(
      h('button', { class: 'icon-btn round', title: 'Message', 'aria-label': 'Message ' + u.username, onclick: () => goHome(u.id) }, icon('message')),
      h('button', { class: 'icon-btn round', title: 'Voice call', 'aria-label': 'Call ' + u.username, onclick: () => startCall(u) }, icon('phone')),
      h('button', { class: 'icon-btn round', title: 'More', 'aria-label': 'More options', onclick: (e) => menu(e.currentTarget, [{ label: 'Remove friend', icon: 'trash', danger: true, run: () => removeFriend(u) }], { alignRight: true }) }, icon('more')));
  } else if (kind === 'incoming') {
    btns.append(
      h('button', { class: 'icon-btn round accept', title: 'Accept', 'aria-label': 'Accept ' + u.username, onclick: () => friendAction('friend:accept', u) }, icon('check')),
      h('button', { class: 'icon-btn round', title: 'Decline', 'aria-label': 'Decline ' + u.username, onclick: () => friendAction('friend:decline', u) }, icon('x')));
  } else {
    btns.append(h('button', { class: 'icon-btn round', title: 'Cancel request', 'aria-label': 'Cancel request to ' + u.username, onclick: () => friendAction('friend:cancel', u) }, icon('x')));
  }
  row.append(btns);
  return row;
}

/* ---------- call strip (shown above a DM while you are in that call) ---------- */
function renderCallStrip() {
  const strip = $('#call-strip');
  strip.replaceChildren();
  const ch = curChannel();
  if (!Voice.channelId || !S.call || !ch || ch.id !== Voice.channelId) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');
  const parts = (S.voice[Voice.channelId] || []);
  const people = h('div', { class: 'people' });
  const ids = parts.length ? parts.map((p) => p.id) : [S.me.id];
  if (!ids.includes(S.call.userId)) ids.push(S.call.userId);
  for (const id of ids) {
    const u = user(id);
    const joined = parts.some((p) => p.id === id);
    const a = avatar(u, 44);
    if (!joined) a.classList.add('waiting');
    if (S.speaking.has(id)) a.classList.add('speaking');
    people.append(h('div', { class: 'person' }, a, h('span', null, id === S.me.id ? 'You' : u.username)));
  }
  strip.append(people,
    h('div', { class: 'state' }, S.call.state === 'ringing' ? 'Calling ' + user(S.call.userId).username + '…' : 'In a call'),
    h('div', { class: 'grow' }),
    h('button', { class: 'icon-btn round' + (Voice.muted ? ' off' : ''), title: Voice.muted ? 'Unmute' : 'Mute', 'aria-label': 'Toggle microphone', onclick: toggleMute }, icon(Voice.muted ? 'mic-off' : 'mic')),
    h('button', { class: 'btn danger', onclick: leaveVoice }, icon('hangup', 'sm'), S.call.state === 'ringing' ? 'Cancel' : 'End call'));
}
