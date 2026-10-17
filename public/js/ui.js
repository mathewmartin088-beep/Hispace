/* UI helpers: DOM builder, icons, avatars, rich text, emoji picker, modals, menus, toasts.
   Everything that touches user text uses textContent or DOM nodes, never innerHTML. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) e.style.setProperty(sk, sv); else e.style[sk] = sv;
        }
      } else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

function icon(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

function iconBtn(name, title, onclick, extra = '') {
  return h('button', { class: 'icon-btn ' + extra, title, 'aria-label': title, onclick }, icon(name));
}

function avatar(user, size = 24, opts = {}) {
  const name = user ? user.username : '?';
  const a = h('div', { class: 'avatar' + (opts.status ? ' status' + (opts.online ? ' on' : '') : ''), style: { '--h': user ? user.hue : 260, '--s': size + 'px' } }, name[0].toUpperCase());
  if (user) a.dataset.uid = user.id;
  return a;
}

/* ---------- time ---------- */
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtDay(ts) {
  const d = new Date(ts), now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/* ---------- emoji ---------- */
const EMOJI = ['😀', '😄', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '😅', '😉', '🙂', '🙃', '😴', '😮', '😢', '😭', '😡', '🥳', '🤯', '😬', '🫠', '🥹',
  '👍', '👎', '👏', '🙌', '🙏', '💪', '👀', '🤝', '👋', '✌️', '🤞', '🫡', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '🔥', '✨', '⭐', '💯',
  '🎉', '🎮', '🕹️', '🎧', '🎵', '🍕', '🍔', '🍿', '☕', '🍺', '🎂', '🏆', '⚽', '🏀', '🚀', '💡', '💻', '📱', '⚡', '🌈', '☀️', '🌙', '🌸', '🐶',
  '🐱', '🦊', '🐼', '🐸', '🐧', '🦄', '💀', '👻', '🤖', '💩', '✅', '❌', '❓', '❗', '➕', '🆗'];
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '🎉', '👀'];
const SHORTCODES = {
  smile: '😄', grin: '😁', joy: '😂', lol: '😂', heart: '❤️', fire: '🔥', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', clap: '👏', pray: '🙏',
  eyes: '👀', tada: '🎉', party: '🥳', cry: '😢', sob: '😭', angry: '😡', thinking: '🤔', cool: '😎', wink: '😉', sleep: '😴', skull: '💀',
  rocket: '🚀', star: '⭐', sparkles: '✨', hundred: '💯', check: '✅', x: '❌', wave: '👋', muscle: '💪', ok: '👌', gg: '🎮', pizza: '🍕',
  coffee: '☕', beer: '🍺', cake: '🎂', trophy: '🏆', bulb: '💡', zap: '⚡', ghost: '👻', robot: '🤖'
};

function emojiPicker(anchor, onPick) {
  closeFloating();
  const pop = h('div', { class: 'emoji-pop floating', role: 'menu' });
  EMOJI.forEach((em) => pop.appendChild(h('button', { type: 'button', onclick: () => { closeFloating(); onPick(em); } }, em)));
  placeFloating(pop, anchor);
}

/* ---------- rich text (markdown-lite, DOM only) ---------- */
function richText(text, ctx = {}) {
  const frag = document.createDocumentFragment();
  for (const part of text.split(/(```[\s\S]*?```)/g)) {
    if (part.length >= 6 && part.startsWith('```') && part.endsWith('```')) {
      const code = part.slice(3, -3).replace(/^[A-Za-z0-9+#-]*\n/, '').replace(/^\n+|\n+$/g, '');
      frag.append(h('pre', null, h('code', null, code)));
    } else inline(part, frag, ctx);
  }
  return frag;
}

const INLINE_RE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\*([^*\s][^*\n]*?)\*|~~([^~\n]+?)~~|(https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]])|(@[A-Za-z0-9_.-]{2,20})|:([a-z0-9_+-]{1,15}):/gi;

function inline(text, frag, ctx) {
  let last = 0, m;
  const re = new RegExp(INLINE_RE.source, 'gi'); // fresh state: this function recurses
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) frag.append(h('code', null, m[1]));
    else if (m[2] !== undefined) { const s = h('strong'); inline(m[2], s, ctx); frag.append(s); }
    else if (m[3] !== undefined) { const s = h('em'); inline(m[3], s, ctx); frag.append(s); }
    else if (m[4] !== undefined) { const s = h('s'); inline(m[4], s, ctx); frag.append(s); }
    else if (m[5] !== undefined) frag.append(h('a', { href: m[5], target: '_blank', rel: 'noopener noreferrer' }, m[5]));
    else if (m[6] !== undefined) {
      const trimmed = m[6].replace(/[.-]+$/, '');
      const tail = m[6].slice(trimmed.length);
      const name = trimmed.slice(1).toLowerCase();
      if (name === 'everyone' || (ctx.userByName && ctx.userByName(name))) frag.append(h('span', { class: 'mention' }, trimmed));
      else frag.append(trimmed);
      if (tail) frag.append(tail);
    } else if (m[7] !== undefined) {
      const em = SHORTCODES[m[7].toLowerCase()];
      frag.append(em || m[0]);
    }
  }
  if (last < text.length) frag.append(text.slice(last));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentionsUser(text, username) {
  return /@everyone(?![A-Za-z0-9_])/i.test(text) || new RegExp('@' + escapeRe(username) + '(?![A-Za-z0-9_])', 'i').test(text);
}

/* ---------- floating layers: modals, menus, toasts ---------- */
function closeFloating() { $$('.floating').forEach((n) => n.remove()); }

function placeFloating(node, anchor, opts = {}) {
  node.style.visibility = 'hidden';
  $('#layers').appendChild(node);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const w = node.offsetWidth, hgt = node.offsetHeight;
  let left = opts.alignRight ? r.right - w : r.left;
  let top = r.bottom + 6;
  if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
  left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
  node.style.left = left + 'px';
  node.style.top = top + 'px';
  node.style.visibility = '';
}

function menu(anchor, items, opts) {
  closeFloating();
  const m = h('div', { class: 'menu floating', role: 'menu' });
  for (const it of items) {
    if (it === '-') { m.appendChild(h('hr')); continue; }
    m.appendChild(h('button', { type: 'button', class: it.danger ? 'danger' : '', role: 'menuitem', onclick: () => { closeFloating(); it.run(); } }, it.icon ? icon(it.icon, 'sm') : null, it.label));
  }
  placeFloating(m, anchor, opts);
}

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.floating')) closeFloating();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFloating(); });

function modal({ title, lead, body, actions = [], wide = false, onClose }) {
  const backdrop = h('div', { class: 'backdrop' });
  const card = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); if (onClose) onClose(); };
  const onKey = (e) => { if (e.key === 'Escape' && !$('.floating')) { e.stopPropagation(); close(); } };
  card.append(h('h2', null, title));
  if (lead) card.append(h('p', { class: 'lead' }, lead));
  if (body) card.append(body);
  if (actions.length) {
    const foot = h('div', { class: 'foot' });
    for (const a of actions) {
      foot.append(h('button', { type: 'button', class: 'btn ' + (a.kind || ''), onclick: () => a.run(close) }, a.label));
    }
    card.append(foot);
  }
  backdrop.append(card);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  $('#layers').appendChild(backdrop);
  const first = card.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
  return { close, card };
}

function confirmDialog({ title, lead, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    modal({
      title, lead, onClose: () => finish(false),
      actions: [
        { label: 'Cancel', run: (c) => { finish(false); c(); } },
        { label: confirm, kind: danger ? 'danger' : 'primary', run: (c) => { finish(true); c(); } }
      ]
    });
  });
}

function toast(message, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, message);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 260); }, 3600);
}

function switchRow(title, desc, checked, onChange) {
  const input = h('input', { type: 'checkbox', role: 'switch' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('div', { class: 'row' }, h('div', { class: 'what' }, h('b', null, title), desc ? h('span', null, desc) : null), h('label', { class: 'switch', style: { margin: 0 } }, input, h('i')));
}

function sliderRow(title, desc, value, onInput, onChange) {
  const input = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': title });
  input.value = Math.round(value * 100);
  input.addEventListener('input', () => onInput(input.value / 100));
  if (onChange) input.addEventListener('change', () => onChange(input.value / 100));
  return h('div', { class: 'row' }, h('div', { class: 'what' }, h('b', null, title), desc ? h('span', null, desc) : null), input);
}
