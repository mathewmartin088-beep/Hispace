/* Voice chat: a full mesh of WebRTC peer connections, signaled through the server's socket.
   Each person who joins a voice channel offers to everyone already in it. */
const Voice = (() => {
  let socket = null;
  let iceServers = [];
  let channelId = null;
  let localStream = null;
  let muted = false;
  let deafened = false;
  let mutedBeforeDeafen = false;
  let voiceVolume = 1;
  let meId = null;
  const peers = new Map(); // userId -> { pc, audio, stopMeter }
  const handlers = { speaking: () => {}, peerState: () => {}, ended: () => {} };

  let meterCtx = null;
  const speakingNow = new Set();
  let meterTimer = null;
  const meters = new Map(); // userId -> {analyser, data, holdUntil}

  const audioConstraints = (deviceId, ns) => ({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: !!ns,
      autoGainControl: true
    }
  });

  function ensureMeterCtx() {
    if (!meterCtx) meterCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (meterCtx.state === 'suspended') meterCtx.resume();
    return meterCtx;
  }

  function addMeter(userId, stream) {
    removeMeter(userId);
    try {
      const c = ensureMeterCtx();
      const src = c.createMediaStreamSource(stream);
      const analyser = c.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      meters.set(userId, { analyser, src, data: new Uint8Array(analyser.fftSize), holdUntil: 0 });
      if (!meterTimer) meterTimer = setInterval(pollMeters, 90);
    } catch (err) { console.warn('meter failed', err); }
  }

  function removeMeter(userId) {
    const m = meters.get(userId);
    if (m) { try { m.src.disconnect(); } catch (_) {} meters.delete(userId); }
    if (speakingNow.delete(userId)) handlers.speaking(userId, false);
    if (!meters.size && meterTimer) { clearInterval(meterTimer); meterTimer = null; }
  }

  function pollMeters() {
    const now = performance.now();
    for (const [userId, m] of meters) {
      m.analyser.getByteTimeDomainData(m.data);
      let sum = 0;
      for (let i = 0; i < m.data.length; i++) { const v = (m.data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / m.data.length);
      const isMutedLocal = userId === meId && (muted || deafened);
      if (rms > 0.035 && !isMutedLocal) m.holdUntil = now + 260;
      const speaking = now < m.holdUntil;
      if (speaking !== speakingNow.has(userId)) {
        if (speaking) speakingNow.add(userId); else speakingNow.delete(userId);
        handlers.speaking(userId, speaking);
      }
    }
  }

  function createPeer(userId) {
    if (peers.has(userId)) return peers.get(userId);
    const pc = new RTCPeerConnection({ iceServers });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.muted = deafened;
    audio.volume = voiceVolume;
    document.getElementById('audio-sink').appendChild(audio);
    const peer = { pc, audio };
    peers.set(userId, peer);

    if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice:signal', { to: userId, data: { type: 'candidate', candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0];
      audio.play().catch(() => {});
      addMeter(userId, e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      handlers.peerState(userId, pc.connectionState);
      if (pc.connectionState === 'failed') {
        try { pc.restartIce(); } catch (_) {}
      }
    };
    return peer;
  }

  function closePeer(userId) {
    const p = peers.get(userId);
    if (!p) return;
    try { p.pc.close(); } catch (_) {}
    p.audio.srcObject = null;
    p.audio.remove();
    peers.delete(userId);
    removeMeter(userId);
  }

  async function onSignal({ from, data }) {
    if (!channelId) return;
    try {
      if (data.type === 'offer') {
        const { pc } = createPeer(from);
        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice:signal', { to: from, data: { type: 'answer', sdp: pc.localDescription } });
      } else if (data.type === 'answer') {
        const p = peers.get(from);
        if (p) await p.pc.setRemoteDescription(data.sdp);
      } else if (data.type === 'candidate') {
        const p = createPeer(from);
        await p.pc.addIceCandidate(data.candidate).catch(() => {});
      }
    } catch (err) {
      console.warn('signal error', err);
    }
  }

  function onPeerLeft({ channelId: cid, userId }) {
    if (cid === channelId) closePeer(userId);
  }

  async function offerTo(userId) {
    const { pc } = createPeer(userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('voice:signal', { to: userId, data: { type: 'offer', sdp: pc.localDescription } });
  }

  async function join(sock, cid, opts) {
    if (channelId) await leave(true);
    socket = sock;
    meId = opts.meId;
    iceServers = opts.iceServers || [];
    voiceVolume = opts.volume ?? 1;

    try {
      localStream = await navigator.mediaDevices.getUserMedia(audioConstraints(opts.deviceId, opts.noiseSuppression));
    } catch (err) {
      // Fall back to the default microphone if the saved device vanished.
      if (opts.deviceId) {
        localStream = await navigator.mediaDevices.getUserMedia(audioConstraints('', opts.noiseSuppression));
      } else throw err;
    }

    muted = false; deafened = false;
    const res = await new Promise((r) => socket.emit('voice:join', { channelId: cid }, r));
    if (!res || !res.ok) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
      throw new Error((res && res.error) || 'Could not join voice.');
    }
    channelId = cid;
    socket.off('voice:signal', onSignal).on('voice:signal', onSignal);
    socket.off('voice:peer-left', onPeerLeft).on('voice:peer-left', onPeerLeft);
    addMeter(meId, localStream);
    for (const userId of res.peers) offerTo(userId).catch((e) => console.warn('offer failed', e));
    return res;
  }

  async function leave(silent) {
    if (!channelId) return;
    const cid = channelId;
    channelId = null;
    for (const userId of [...peers.keys()]) closePeer(userId);
    removeMeter(meId);
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    if (socket) {
      socket.off('voice:signal', onSignal);
      socket.off('voice:peer-left', onPeerLeft);
      socket.emit('voice:leave', {});
    }
    muted = false; deafened = false;
    if (!silent) handlers.ended(cid);
  }

  function pushStatus() {
    if (channelId && socket) socket.emit('voice:status', { muted: muted || deafened, deafened });
  }

  function applyMute() {
    if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = !(muted || deafened); });
    pushStatus();
  }

  function toggleMute() {
    if (deafened) return toggleDeafen();
    muted = !muted;
    applyMute();
    return { muted, deafened };
  }

  function toggleDeafen() {
    if (!deafened) { mutedBeforeDeafen = muted; deafened = true; }
    else { deafened = false; muted = mutedBeforeDeafen; }
    for (const p of peers.values()) p.audio.muted = deafened;
    applyMute();
    return { muted: muted || deafened, deafened };
  }

  async function setInputDevice(deviceId, noiseSuppression) {
    if (!channelId) return;
    const fresh = await navigator.mediaDevices.getUserMedia(audioConstraints(deviceId, noiseSuppression));
    const track = fresh.getAudioTracks()[0];
    track.enabled = !(muted || deafened);
    for (const p of peers.values()) {
      const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (sender) await sender.replaceTrack(track);
    }
    localStream.getTracks().forEach((t) => t.stop());
    localStream = fresh;
    addMeter(meId, fresh);
  }

  function setVolume(v) {
    voiceVolume = v;
    for (const p of peers.values()) p.audio.volume = v;
  }

  return {
    join, leave, toggleMute, toggleDeafen, setInputDevice, setVolume,
    on(name, fn) { handlers[name] = fn; },
    get channelId() { return channelId; },
    get muted() { return muted || deafened; },
    get deafened() { return deafened; }
  };
})();
