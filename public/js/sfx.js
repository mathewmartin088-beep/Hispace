/* Hispace sound engine.
   Everything is synthesized with the Web Audio API (no audio files).
   - Bell tones use inharmonic partials with individual decays, which is what
     gives them a glassy, "struck" quality instead of a plain beep.
   - A generated room reverb and a master compressor keep stacked sounds smooth.
   - Each sound has a cooldown so bursts of events never turn into noise. */
const SFX = (() => {
  let ctx = null, master, comp, dry, wet, convolver;
  const prefs = { enabled: true, volume: 0.7 };
  const lastPlayed = {};

  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  function init() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    master = ctx.createGain();
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 24; comp.ratio.value = 4;
    comp.attack.value = 0.003; comp.release.value = 0.2;

    dry = ctx.createGain();
    wet = ctx.createGain();
    wet.gain.value = 0.9;
    convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(1.6, 3.2);

    dry.connect(comp);
    wet.connect(convolver);
    convolver.connect(comp);
    comp.connect(master);
    master.connect(ctx.destination);
    applyVolume();
    return ctx;
  }

  // Exponentially decaying stereo noise, softened so the tail is warm rather than hissy.
  function makeImpulse(seconds, decay) {
    const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let prev = 0;
      for (let i = 0; i < len; i++) {
        const noise = Math.random() * 2 - 1;
        prev = prev * 0.55 + noise * 0.45;
        d[i] = prev * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function applyVolume() {
    if (!ctx) return;
    // Squared curve feels more natural on a slider than a linear one.
    master.gain.setTargetAtTime(prefs.enabled ? prefs.volume * prefs.volume * 1.2 : 0, ctx.currentTime, 0.02);
  }

  function resume() {
    const c = init();
    if (c && c.state === 'suspended') c.resume();
  }

  function route(node, { pan = 0, send = 0.3 }) {
    let out = node;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      out.connect(p);
      out = p;
    }
    out.connect(dry);
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = send;
      out.connect(s);
      s.connect(wet);
    }
  }

  // A struck-bell note: fundamental plus decaying inharmonic partials.
  function bell({ note, at = 0, dur = 1, gain = 0.25, partials, attack = 0.004, pan = 0, send = 0.35, type = 'sine' }) {
    const t0 = ctx.currentTime + at;
    const f = midi(note);
    const parts = partials || [[1, 1, 1], [2.76, 0.32, 0.45], [5.4, 0.12, 0.22], [8.93, 0.05, 0.12]];
    const bus = ctx.createGain();
    bus.gain.value = 1;
    for (const [ratio, amp, decayScale] of parts) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = f * ratio;
      const peak = gain * amp;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + dur * decayScale);
      o.connect(g); g.connect(bus);
      o.start(t0);
      o.stop(t0 + attack + dur * decayScale + 0.05);
    }
    route(bus, { pan, send });
  }

  // A soft, sustained tone with a slow attack. Used for the welcome swell.
  function pad({ note, at = 0, dur = 1.6, gain = 0.08, attack = 0.25, pan = 0, send = 0.6 }) {
    const t0 = ctx.currentTime + at;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1800;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    for (const detune of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = midi(note);
      o.detune.value = detune;
      o.connect(lp);
      o.start(t0); o.stop(t0 + dur + 0.05);
    }
    lp.connect(g);
    route(g, { pan, send });
  }

  // A pitch-gliding sine "pop" for UI feedback.
  function pop({ from, to, at = 0, dur = 0.09, gain = 0.22, pan = 0, send = 0.12, type = 'sine', cutoff = 4000 }) {
    const t0 = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = cutoff;
    o.type = type;
    o.frequency.setValueAtTime(from, t0);
    o.frequency.exponentialRampToValueAtTime(to, t0 + dur * 0.8);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(lp); lp.connect(g);
    o.start(t0); o.stop(t0 + dur + 0.03);
    route(g, { pan, send });
  }

  // A short filtered noise burst, like a soft key tick.
  function tick({ at = 0, freq = 2600, q = 1.2, dur = 0.022, gain = 0.1 }) {
    const t0 = ctx.currentTime + at;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(bp); bp.connect(g);
    src.start(t0);
    route(g, { send: 0.05 });
  }

  // The sound set. Notes are MIDI numbers (69 = A4).
  const sounds = {
    send() {
      pop({ from: 420, to: 820, dur: 0.08, gain: 0.2 });
      tick({ freq: 3200, gain: 0.05 });
    },
    receive() {
      bell({ note: 76, at: 0, dur: 0.9, gain: 0.2, pan: -0.1 });
      bell({ note: 83, at: 0.09, dur: 1.1, gain: 0.17, pan: 0.1 });
    },
    dm() {
      bell({ note: 81, at: 0, dur: 0.8, gain: 0.19 });
      bell({ note: 88, at: 0.08, dur: 1.0, gain: 0.17 });
      bell({ note: 93, at: 0.17, dur: 1.2, gain: 0.09, send: 0.5 });
    },
    mention() {
      [79, 83, 86, 91].forEach((n, i) => bell({ note: n, at: i * 0.07, dur: 1.0, gain: 0.18 - i * 0.015, pan: (i - 1.5) * 0.15 }));
      bell({ note: 98, at: 0.3, dur: 1.3, gain: 0.06, send: 0.6 });
    },
    voiceJoin() {
      [72, 76, 79, 84].forEach((n, i) => bell({
        note: n, at: i * 0.075, dur: 0.7, gain: 0.17, send: 0.4,
        partials: [[1, 1, 1], [2, 0.3, 0.5], [3, 0.12, 0.3]], type: 'triangle'
      }));
    },
    voiceLeave() {
      [84, 79, 76, 72].forEach((n, i) => bell({
        note: n, at: i * 0.085, dur: 0.55, gain: 0.13 - i * 0.012, send: 0.35,
        partials: [[1, 1, 1], [2, 0.25, 0.4]], type: 'triangle'
      }));
    },
    peerJoin() {
      bell({ note: 81, at: 0, dur: 0.45, gain: 0.14, partials: [[1, 1, 1], [2, 0.2, 0.4]] });
      bell({ note: 86, at: 0.08, dur: 0.6, gain: 0.14, partials: [[1, 1, 1], [2, 0.2, 0.4]] });
    },
    peerLeave() {
      bell({ note: 86, at: 0, dur: 0.4, gain: 0.12, partials: [[1, 1, 1], [2, 0.2, 0.4]] });
      bell({ note: 79, at: 0.08, dur: 0.55, gain: 0.12, partials: [[1, 1, 1], [2, 0.2, 0.4]] });
    },
    mute() {
      pop({ from: 560, to: 300, dur: 0.1, gain: 0.2, type: 'triangle' });
      tick({ freq: 1800, gain: 0.07 });
    },
    unmute() {
      pop({ from: 300, to: 620, dur: 0.1, gain: 0.2, type: 'triangle' });
      tick({ freq: 3000, gain: 0.06 });
    },
    deafen() {
      pop({ from: 520, to: 260, dur: 0.12, gain: 0.18, type: 'triangle' });
      pop({ from: 390, to: 190, at: 0.09, dur: 0.14, gain: 0.16, type: 'triangle' });
    },
    undeafen() {
      pop({ from: 260, to: 520, dur: 0.12, gain: 0.17, type: 'triangle' });
      pop({ from: 390, to: 780, at: 0.09, dur: 0.14, gain: 0.17, type: 'triangle' });
    },
    click() {
      tick({ freq: 2400, gain: 0.07, dur: 0.018 });
    },
    success() {
      [76, 83, 88].forEach((n, i) => bell({ note: n, at: i * 0.06, dur: 0.9, gain: 0.15 }));
    },
    error() {
      pop({ from: 200, to: 170, dur: 0.18, gain: 0.2, type: 'triangle', cutoff: 900, send: 0.05 });
      pop({ from: 188, to: 150, at: 0.1, dur: 0.22, gain: 0.18, type: 'triangle', cutoff: 800, send: 0.05 });
    },
    ringIn() {
      [84, 88, 84, 88].forEach((n, i) => bell({ note: n, at: i * 0.22, dur: 0.6, gain: 0.2, pan: i % 2 ? 0.15 : -0.15, send: 0.4 }));
    },
    ringOut() {
      bell({ note: 79, at: 0, dur: 0.9, gain: 0.13, send: 0.5 });
      bell({ note: 83, at: 0.32, dur: 1.1, gain: 0.11, send: 0.5 });
    },
    welcome() {
      [48, 55, 59, 64, 67].forEach((n, i) => pad({ note: n, at: i * 0.05, gain: 0.07 }));
      bell({ note: 84, at: 0.32, dur: 1.6, gain: 0.13, send: 0.55 });
      bell({ note: 91, at: 0.46, dur: 1.8, gain: 0.09, send: 0.6 });
    }
  };

  // Minimum gap (ms) between plays of the same sound.
  const cooldown = { receive: 140, dm: 200, mention: 300, click: 40, send: 60, peerJoin: 200, peerLeave: 200, mute: 80, unmute: 80 };

  function play(name) {
    if (!prefs.enabled || !sounds[name]) return;
    const c = init();
    if (!c) return;
    if (c.state === 'suspended') c.resume();
    const now = performance.now();
    if (now - (lastPlayed[name] || 0) < (cooldown[name] || 0)) return;
    lastPlayed[name] = now;
    try { sounds[name](); } catch (err) { console.warn('SFX failed', name, err); }
  }

  // Looping ring for calls. kind: 'incoming' | 'outgoing'.
  let ringTimer = null;
  function stopRing() { if (ringTimer) { clearInterval(ringTimer); ringTimer = null; } }
  function startRing(kind) {
    stopRing();
    const name = kind === 'incoming' ? 'ringIn' : 'ringOut';
    const tick = () => {
      if (!prefs.enabled) return;
      const c = init();
      if (!c) return;
      if (c.state === 'suspended') c.resume();
      try { sounds[name](); } catch (err) { console.warn('SFX failed', name, err); }
    };
    tick();
    ringTimer = setInterval(tick, kind === 'incoming' ? 1800 : 3200);
  }

  function configure(p) {
    if (typeof p.enabled === 'boolean') prefs.enabled = p.enabled;
    if (typeof p.volume === 'number') prefs.volume = Math.min(1, Math.max(0, p.volume));
    applyVolume();
  }

  // Browsers only allow audio after a user gesture.
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, resume, { once: true, capture: true }));

  return { play, configure, resume, startRing, stopRing, names: Object.keys(sounds) };
})();
