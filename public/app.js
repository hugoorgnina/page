/* ============================================================
   Nuestro Chat — cliente
   Chat de texto + fotos, sala de voz con cámara y pantalla,
   llamadas estilo WhatsApp. Pensado para el celular.
   ============================================================ */

const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem('token') || null,
  me: null,
  other: null, // la otra persona (solo son 2)
  config: null,
  socket: null,
  view: 'chat',
  unread: 0,
  // voz
  inVoice: false,
  wantVideoOnJoin: false,
  voiceMembers: [],
  micStream: null,
  camTrack: null,
  screenTrack: null,
  micOn: true,
  pc: null,
  audioTx: null,
  videoTx: null,
  makingOffer: false,
  ignoreOffer: false,
  polite: false,
  // llamadas
  calling: false,
  incoming: null,
  wakeLock: null
};

/* ================= Utilidades ================= */

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || 'Error'), { code: data.error, status: res.status });
  return data;
}

function setAvatar(el, user) {
  el.innerHTML = '';
  if (user && user.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar;
    img.alt = '';
    el.appendChild(img);
  } else {
    el.textContent = user && user.name ? user.name[0].toUpperCase() : '?';
    el.style.background = user ? colorFor(user.id) : 'var(--bg3)';
  }
}

function colorFor(id) {
  const colors = ['#5865f2', '#23a55a', '#f0b232', '#eb459e', '#3ba55c', '#faa61a'];
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return colors[h % colors.length];
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Hoy';
  if (d.toDateString() === yesterday.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es', { day: 'numeric', month: 'long' });
}

// Comprime una imagen en el navegador antes de subirla (clave en el celular)
function compressImage(file, maxSide = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const scale = Math.min(1, maxSide / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });
}

/* ================= Sonidos (generados, sin archivos) ================= */

let audioCtx = null;
function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function beep(freq, dur, when = 0, vol = 0.25, type = 'sine') {
  try {
    const c = ctx();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, c.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + when + dur);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + when);
    o.stop(c.currentTime + when + dur);
  } catch (_) {}
}
let ringTimer = null;
function startRingtone(incoming) {
  stopRingtone();
  const ring = () => {
    if (incoming) {
      beep(880, 0.35, 0, 0.3); beep(660, 0.35, 0.4, 0.3);
      beep(880, 0.35, 0.9, 0.3); beep(660, 0.35, 1.3, 0.3);
      if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    } else {
      beep(440, 0.7, 0, 0.12);
    }
  };
  ring();
  ringTimer = setInterval(ring, incoming ? 2600 : 2000);
}
function stopRingtone() {
  clearInterval(ringTimer);
  ringTimer = null;
  if (navigator.vibrate) navigator.vibrate(0);
}
function notifySound() { beep(740, 0.12, 0, 0.15); beep(988, 0.15, 0.12, 0.15); }

/* ================= Entrar / sesión ================= */

async function boot() {
  state.config = await fetch('/api/config').then((r) => r.json()).catch(() => ({ iceServers: [] }));

  if (state.config.inviteRequired) $('authInvite').classList.remove('hidden');
  if (state.config.googleClientId) setupGoogle();

  if (state.token) {
    try {
      await loadMe();
      enterApp();
      return;
    } catch (e) {
      // El servidor pudo reiniciarse (plan gratis): intenta re-entrar con credenciales guardadas
      const saved = JSON.parse(localStorage.getItem('creds') || 'null');
      if (saved) {
        try {
          const r = await api('/api/auth', { body: saved });
          state.token = r.token;
          localStorage.setItem('token', r.token);
          await restoreAvatarIfNeeded(r.me);
          await loadMe();
          enterApp();
          return;
        } catch (_) {}
      }
      state.token = null;
      localStorage.removeItem('token');
    }
  }
  $('authScreen').classList.remove('hidden');
}

async function loadMe() {
  const data = await api('/api/me');
  state.me = data.me;
  state.other = data.others[0] || null;
}

// Si el servidor se reinició y perdió mi avatar, lo vuelve a subir desde el celular
async function restoreAvatarIfNeeded(me) {
  const cached = localStorage.getItem('avatarCache');
  if (cached && !me.avatar) {
    try { await api('/api/profile', { body: { avatarDataUrl: cached } }); } catch (_) {}
  }
}

$('authBtn').addEventListener('click', doAuth);
$('authPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(); });

async function doAuth() {
  const name = $('authName').value.trim();
  const password = $('authPass').value;
  const invite = $('authInvite').value.trim();
  $('authError').textContent = '';
  try {
    const r = await api('/api/auth', { body: { name, password, invite } });
    state.token = r.token;
    localStorage.setItem('token', r.token);
    localStorage.setItem('creds', JSON.stringify({ name, password, invite }));
    await restoreAvatarIfNeeded(r.me);
    await loadMe();
    enterApp();
  } catch (e) {
    $('authError').textContent = e.message;
  }
}

function setupGoogle() {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.onload = () => {
    google.accounts.id.initialize({
      client_id: state.config.googleClientId,
      callback: async (resp) => {
        try {
          const r = await api('/api/google', { body: { credential: resp.credential } });
          state.token = r.token;
          localStorage.setItem('token', r.token);
          await loadMe();
          enterApp();
        } catch (e) {
          $('authError').textContent = e.message;
        }
      }
    });
    google.accounts.id.renderButton($('googleBtn'), { theme: 'filled_black', size: 'large', width: 280 });
    $('googleBtnWrap').classList.remove('hidden');
  };
  document.head.appendChild(s);
}

/* ================= App principal ================= */

function enterApp() {
  $('authScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
  renderPeer();
  setAvatar($('myAvatar'), state.me);
  $('settingsName').value = state.me.name;
  connectSocket();
  loadMessages();
  if ('Notification' in window && Notification.permission === 'default') {
    // se pide al primer toque para que el navegador lo permita
    document.body.addEventListener('click', () => Notification.requestPermission(), { once: true });
  }
  if (!('getDisplayMedia' in (navigator.mediaDevices || {}))) {
    $('btnScreen').classList.add('hidden'); // iPhone no deja compartir pantalla
  }
}

function renderPeer() {
  const p = state.other;
  $('peerName').textContent = p ? p.name : 'Esperando a tu persona…';
  setAvatar($('peerAvatar'), p);
  setAvatar($('remoteAvatar'), p);
  setAvatar($('incomingAvatar'), p);
  setAvatar($('outgoingAvatar'), p);
  $('outgoingName').textContent = p ? p.name : '';
}

function setPeerStatus(online) {
  const el = $('peerStatus');
  el.textContent = online ? 'en línea' : 'desconectado';
  el.classList.toggle('online', online);
}

/* ---- Navegación ---- */
$('navChat').addEventListener('click', () => switchView('chat'));
$('navVoice').addEventListener('click', () => switchView('voice'));

function switchView(v) {
  state.view = v;
  $('viewChat').classList.toggle('hidden', v !== 'chat');
  $('viewVoice').classList.toggle('hidden', v !== 'voice');
  $('navChat').classList.toggle('active', v === 'chat');
  $('navVoice').classList.toggle('active', v === 'voice');
  if (v === 'chat') {
    state.unread = 0;
    updateBadge();
    scrollMessages();
  }
}
function updateBadge() {
  const b = $('chatBadge');
  b.classList.toggle('hidden', state.unread === 0);
  b.textContent = state.unread;
}

/* ================= Socket ================= */

function connectSocket() {
  state.socket = io({ auth: { token: state.token } });
  const s = state.socket;

  s.on('connect', () => {
    if (state.inVoice) s.emit('voice-join'); // se cayó la conexión: vuelve a la sala solo
  });

  s.on('presence', ({ online }) => {
    state.lastOnline = online;
    if (state.other) setPeerStatus(online.includes(state.other.id));
  });

  s.on('users-updated', async () => {
    try {
      await loadMe();
      renderPeer();
      if (state.other && state.lastOnline) setPeerStatus(state.lastOnline.includes(state.other.id));
    } catch (_) {}
  });

  s.on('chat', (msg) => {
    appendMessage(msg);
    scrollMessages();
    if (msg.from !== state.me.id) {
      if (state.view !== 'chat' || document.hidden) {
        state.unread++;
        updateBadge();
        notifySound();
        showNotification(msg);
      }
    }
  });

  s.on('typing', ({ userId }) => {
    if (userId === state.me.id) return;
    const t = $('typingIndicator');
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), 2500);
  });

  /* ---- Sala de voz ---- */
  s.on('voice-state', ({ members }) => {
    const before = state.voiceMembers.map((m) => m.id).join(',');
    state.voiceMembers = members;
    renderVoiceMembers();

    const otherIn = members.some((m) => m.id !== state.me.id);
    $('voiceDot').classList.toggle('hidden', members.length === 0);

    // Aviso en el chat si el otro entró a la sala y yo no estoy
    if (!state.inVoice && otherIn) {
      $('voiceBanner').classList.remove('hidden');
      $('voiceBannerText').textContent = `🎧 ${state.other ? state.other.name : 'Alguien'} está en la sala de voz`;
      if (!before.includes(members.find((m) => m.id !== state.me.id).id)) notifySound();
    } else {
      $('voiceBanner').classList.add('hidden');
    }

    if (state.inVoice) {
      if (otherIn && !state.pc) startPeer();
      updateRemotePlaceholder();
    }
  });

  s.on('voice-peer-left', () => {
    // El otro salió: yo me quedo en la sala esperando a que vuelva
    closePeer();
    updateRemotePlaceholder();
  });

  s.on('rtc', ({ payload }) => onRtcMessage(payload));

  s.on('voice-status', ({ status }) => {
    $('remoteMicState').classList.toggle('hidden', status.mic !== false);
  });

  /* ---- Llamadas ---- */
  s.on('call-incoming', ({ from, video }) => {
    if (state.inVoice || state.calling) { s.emit('call-reject'); return; }
    state.incoming = { from, video };
    $('incomingName').textContent = from.name;
    $('incomingType').textContent = video ? 'Videollamada entrante' : 'Llamada entrante';
    setAvatar($('incomingAvatar'), from);
    $('incomingCall').classList.remove('hidden');
    startRingtone(true);
    showNotification({ type: 'call', from: from.name, video });
  });

  s.on('call-accepted', () => {
    if (!state.calling) return;
    stopRingtone();
    $('outgoingCall').classList.add('hidden');
    const video = state.calling === 'video';
    state.calling = false;
    joinVoice(video);
  });

  s.on('call-rejected', () => {
    if (!state.calling) return;
    stopRingtone();
    state.calling = false;
    $('outgoingCall').classList.add('hidden');
    toast('No contestó la llamada 💔');
  });

  s.on('call-cancelled', () => {
    state.incoming = null;
    stopRingtone();
    $('incomingCall').classList.add('hidden');
  });

  s.on('call-handled', () => {
    state.incoming = null;
    stopRingtone();
    $('incomingCall').classList.add('hidden');
  });
}

function showNotification(msg) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const from = state.other ? state.other.name : 'Mensaje';
    if (msg.type === 'call') new Notification(`📞 ${msg.from}`, { body: msg.video ? 'Videollamada entrante' : 'Llamada entrante' });
    else new Notification(from, { body: msg.type === 'image' ? '📷 Foto' : msg.text });
  } catch (_) {}
}

/* ================= Chat ================= */

let lastDay = null;

async function loadMessages() {
  try {
    const { messages } = await api('/api/messages');
    $('messages').innerHTML = '';
    lastDay = null;
    messages.forEach(appendMessage);
    scrollMessages(true);
  } catch (_) {}
}

function appendMessage(msg) {
  const list = $('messages');
  const day = fmtDay(msg.ts);
  if (day !== lastDay) {
    lastDay = day;
    const sep = document.createElement('div');
    sep.className = 'day-sep';
    sep.textContent = day;
    list.appendChild(sep);
  }
  const mine = msg.from === state.me.id;
  const row = document.createElement('div');
  row.className = 'msg' + (mine ? ' mine' : '');

  const av = document.createElement('div');
  av.className = 'avatar';
  setAvatar(av, mine ? state.me : state.other);
  row.appendChild(av);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (msg.type === 'image') {
    bubble.classList.add('img-bubble');
    const img = document.createElement('img');
    img.src = msg.url;
    img.loading = 'lazy';
    img.addEventListener('click', () => openImage(msg.url));
    img.addEventListener('load', () => scrollMessages());
    bubble.appendChild(img);
  } else {
    bubble.textContent = msg.text;
  }
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(msg.ts);
  bubble.appendChild(time);
  row.appendChild(bubble);
  list.appendChild(row);
}

function scrollMessages(instant) {
  const list = $('messages');
  list.scrollTo({ top: list.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
}

$('btnSend').addEventListener('click', sendText);
$('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });
let typingThrottle = 0;
$('msgInput').addEventListener('input', () => {
  const now = Date.now();
  if (now - typingThrottle > 1500) {
    typingThrottle = now;
    state.socket && state.socket.emit('typing');
  }
});

function sendText() {
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text) return;
  state.socket.emit('chat', { type: 'text', text });
  input.value = '';
  input.focus();
}

$('btnPhoto').addEventListener('click', () => $('photoInput').click());
$('photoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  toast('Enviando foto…');
  try {
    const dataUrl = await compressImage(file);
    const { url } = await api('/api/upload', { body: { dataUrl } });
    state.socket.emit('chat', { type: 'image', url });
  } catch (err) {
    toast('No se pudo enviar la foto 😕');
  }
});

function openImage(url) {
  $('imageViewerImg').src = url;
  $('imageViewer').classList.remove('hidden');
}
$('imageViewerClose').addEventListener('click', () => $('imageViewer').classList.add('hidden'));
$('imageViewer').addEventListener('click', (e) => { if (e.target.id === 'imageViewer') $('imageViewer').classList.add('hidden'); });

/* ================= Sala de voz ================= */

function renderVoiceMembers() {
  const wrap = $('voiceMembersList');
  wrap.innerHTML = '';
  if (state.voiceMembers.length === 0) {
    wrap.innerHTML = '<span class="voice-empty">La sala está vacía</span>';
    return;
  }
  for (const m of state.voiceMembers) {
    const el = document.createElement('div');
    el.className = 'voice-member';
    const av = document.createElement('div');
    av.className = 'avatar';
    setAvatar(av, m);
    el.appendChild(av);
    const name = document.createElement('span');
    name.textContent = m.id === state.me.id ? 'Tú' : m.name;
    el.appendChild(name);
    wrap.appendChild(el);
  }
}

$('btnJoinVoice').addEventListener('click', () => joinVoice(false));
$('voiceBannerJoin').addEventListener('click', () => joinVoice(false));
$('btnLeaveVoice').addEventListener('click', leaveVoice);

async function joinVoice(withVideo) {
  if (state.inVoice) { switchView('voice'); return; }
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    toast('Necesito permiso del micrófono 🎙️');
    return;
  }
  state.inVoice = true;
  state.micOn = true;
  state.wantVideoOnJoin = !!withVideo;
  $('btnMic').classList.add('active');
  $('btnMic').classList.remove('off');
  switchView('voice');
  $('voiceLobby').classList.add('hidden');
  $('voiceRoom').classList.remove('hidden');
  state.socket.emit('voice-join');
  updateRemotePlaceholder();
  requestWakeLock();

  // Si el otro ya está dentro, conecta ya
  if (state.voiceMembers.some((m) => m.id !== state.me.id)) startPeer();
  if (withVideo) toggleCam(true);
}

function leaveVoice() {
  state.socket.emit('voice-leave');
  state.inVoice = false;
  closePeer();
  stopLocalMedia();
  $('voiceRoom').classList.add('hidden');
  $('voiceLobby').classList.remove('hidden');
  releaseWakeLock();
  switchView('chat');
}

function stopLocalMedia() {
  if (state.micStream) { state.micStream.getTracks().forEach((t) => t.stop()); state.micStream = null; }
  stopCam();
  stopScreen();
  $('localPip').classList.remove('visible');
}

function updateRemotePlaceholder() {
  const otherIn = state.voiceMembers.some((m) => m.id !== state.me.id);
  $('remoteLabel').textContent = otherIn
    ? (state.other ? state.other.name : '')
    : `Esperando a que ${state.other ? state.other.name : 'tu persona'} entre…`;
  if (!otherIn) {
    $('remoteVideo').classList.add('novideo');
    $('remotePlaceholder').classList.remove('hidden');
    $('remoteMicState').classList.add('hidden');
  }
}

/* ---- WebRTC (negociación "perfecta" para que nunca choque) ---- */

function startPeer() {
  if (state.pc) return;
  const otherId = state.voiceMembers.find((m) => m.id !== state.me.id)?.id || (state.other && state.other.id);
  state.polite = String(state.me.id) < String(otherId); // determinista: uno cede y el otro no
  state.makingOffer = false;
  state.ignoreOffer = false;

  const pc = new RTCPeerConnection({ iceServers: state.config.iceServers });
  state.pc = pc;

  // Transceivers fijos: audio (mi micro) + video (cámara O pantalla, se cambia sin renegociar)
  state.audioTx = pc.addTransceiver(state.micStream.getAudioTracks()[0], { direction: 'sendrecv' });
  state.videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
  const sendTrack = state.screenTrack || state.camTrack;
  if (sendTrack) state.videoTx.sender.replaceTrack(sendTrack);

  pc.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      state.socket.emit('rtc', { description: pc.localDescription });
    } catch (e) {
      console.error(e);
    } finally {
      state.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => state.socket.emit('rtc', { candidate });

  pc.ontrack = ({ track }) => {
    if (track.kind === 'audio') {
      $('remoteAudio').srcObject = new MediaStream([track]);
      $('remoteAudio').play().catch(() => {});
    } else {
      $('remoteVideo').srcObject = new MediaStream([track]);
      const show = (on) => {
        $('remoteVideo').classList.toggle('novideo', !on);
        $('remotePlaceholder').classList.toggle('hidden', on);
      };
      track.onunmute = () => show(true);
      track.onmute = () => show(false);
      show(!track.muted);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      // Reintenta la conexión desde cero
      closePeer();
      if (state.inVoice && state.voiceMembers.some((m) => m.id !== state.me.id)) startPeer();
    }
  };

  sendVoiceStatus();
}

async function onRtcMessage({ description, candidate }) {
  const pc = state.pc;
  if (!pc) return;
  try {
    if (description) {
      const collision = description.type === 'offer' && (state.makingOffer || pc.signalingState !== 'stable');
      state.ignoreOffer = !state.polite && collision;
      if (state.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        state.socket.emit('rtc', { description: pc.localDescription });
      }
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate); }
      catch (e) { if (!state.ignoreOffer) throw e; }
    }
  } catch (e) {
    console.error('rtc', e);
  }
}

function closePeer() {
  if (state.pc) {
    state.pc.onnegotiationneeded = null;
    state.pc.onicecandidate = null;
    state.pc.ontrack = null;
    state.pc.close();
    state.pc = null;
  }
  state.audioTx = null;
  state.videoTx = null;
  $('remoteAudio').srcObject = null;
  $('remoteVideo').srcObject = null;
  $('remoteVideo').classList.add('novideo');
  $('remotePlaceholder').classList.remove('hidden');
}

function sendVoiceStatus() {
  if (!state.inVoice) return;
  state.socket.emit('voice-status', {
    mic: state.micOn,
    cam: !!state.camTrack,
    screen: !!state.screenTrack
  });
}

/* ---- Controles: micro, cámara, pantalla ---- */

$('btnMic').addEventListener('click', () => {
  state.micOn = !state.micOn;
  if (state.micStream) state.micStream.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
  $('btnMic').classList.toggle('active', state.micOn);
  $('btnMic').classList.toggle('off', !state.micOn);
  sendVoiceStatus();
});

$('btnCam').addEventListener('click', () => toggleCam(!state.camTrack));

async function toggleCam(on) {
  if (on) {
    stopScreen();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      state.camTrack = stream.getVideoTracks()[0];
    } catch (e) {
      toast('Necesito permiso de la cámara 📹');
      return;
    }
    showLocalPreview(state.camTrack, false);
    if (state.videoTx) state.videoTx.sender.replaceTrack(state.camTrack);
  } else {
    stopCam();
    if (state.videoTx) state.videoTx.sender.replaceTrack(null);
  }
  $('btnCam').classList.toggle('active', !!state.camTrack);
  sendVoiceStatus();
}

function stopCam() {
  if (state.camTrack) { state.camTrack.stop(); state.camTrack = null; }
  if (!state.screenTrack) $('localPip').classList.remove('visible');
  $('btnCam').classList.remove('active');
}

$('btnScreen').addEventListener('click', async () => {
  if (state.screenTrack) { stopScreenAndRestore(); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    state.screenTrack = stream.getVideoTracks()[0];
  } catch (e) {
    return; // canceló el selector
  }
  stopCam();
  showLocalPreview(state.screenTrack, true);
  if (state.videoTx) state.videoTx.sender.replaceTrack(state.screenTrack);
  $('btnScreen').classList.add('active');
  state.screenTrack.onended = () => stopScreenAndRestore(); // botón "dejar de compartir" del sistema
  sendVoiceStatus();
});

function stopScreen() {
  if (state.screenTrack) { state.screenTrack.onended = null; state.screenTrack.stop(); state.screenTrack = null; }
  $('btnScreen').classList.remove('active');
}

function stopScreenAndRestore() {
  stopScreen();
  if (state.videoTx) state.videoTx.sender.replaceTrack(null);
  $('localPip').classList.remove('visible');
  sendVoiceStatus();
}

function showLocalPreview(track, isScreen) {
  const v = $('localVideo');
  v.srcObject = new MediaStream([track]);
  v.classList.toggle('screen', isScreen);
  $('localPip').classList.add('visible');
}

/* ---- Mantener la pantalla despierta durante la llamada ---- */
async function requestWakeLock() {
  try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}
function releaseWakeLock() {
  if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.inVoice) requestWakeLock();
});

/* ================= Llamadas estilo WhatsApp ================= */

$('btnAudioCall').addEventListener('click', () => startCall(false));
$('btnVideoCall').addEventListener('click', () => startCall(true));

function startCall(video) {
  if (!state.other) { toast('Todavía no hay nadie más registrado'); return; }
  if (state.inVoice) { toast('Ya estás en la sala de voz'); return; }
  state.calling = video ? 'video' : 'audio';
  $('outgoingName').textContent = state.other.name;
  $('outgoingCall').classList.remove('hidden');
  state.socket.emit('call-start', { video });
  startRingtone(false);
  // Si no contesta en 45s, corta solo
  clearTimeout(startCall._timeout);
  startCall._timeout = setTimeout(() => {
    if (state.calling) {
      state.socket.emit('call-cancel');
      state.calling = false;
      stopRingtone();
      $('outgoingCall').classList.add('hidden');
      toast('No contestó 😔');
    }
  }, 45000);
}

$('btnCancelCall').addEventListener('click', () => {
  state.socket.emit('call-cancel');
  state.calling = false;
  stopRingtone();
  $('outgoingCall').classList.add('hidden');
});

$('btnAcceptCall').addEventListener('click', async () => {
  const call = state.incoming;
  state.incoming = null;
  stopRingtone();
  $('incomingCall').classList.add('hidden');
  if (!call) return;
  state.socket.emit('call-accept');
  await joinVoice(call.video);
});

$('btnRejectCall').addEventListener('click', () => {
  state.incoming = null;
  stopRingtone();
  $('incomingCall').classList.add('hidden');
  state.socket.emit('call-reject');
});

/* ================= Ajustes / perfil ================= */

$('btnSettings').addEventListener('click', () => {
  $('settingsName').value = state.me.name;
  setAvatar($('myAvatar'), state.me);
  $('settingsOverlay').classList.remove('hidden');
});
$('btnCloseSettings').addEventListener('click', () => $('settingsOverlay').classList.add('hidden'));

$('btnChangeAvatar').addEventListener('click', () => $('avatarInput').click());
$('avatarInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const dataUrl = await compressImage(file, 256, 0.9);
    localStorage.setItem('avatarCache', dataUrl); // por si el servidor gratis se reinicia
    const { me } = await api('/api/profile', { body: { avatarDataUrl: dataUrl } });
    state.me = me;
    setAvatar($('myAvatar'), state.me);
    toast('Foto de perfil actualizada ✨');
  } catch (err) {
    toast('No se pudo cambiar la foto');
  }
});

$('btnSaveProfile').addEventListener('click', async () => {
  try {
    const { me } = await api('/api/profile', { body: { name: $('settingsName').value } });
    state.me = me;
    const creds = JSON.parse(localStorage.getItem('creds') || 'null');
    if (creds) { creds.name = me.name; localStorage.setItem('creds', JSON.stringify(creds)); }
    $('settingsOverlay').classList.add('hidden');
    toast('Guardado ✅');
  } catch (e) {
    toast(e.message);
  }
});

$('btnLogout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: {} }); } catch (_) {}
  localStorage.removeItem('token');
  localStorage.removeItem('creds');
  location.reload();
});

/* ================= Arranque ================= */
window.state = state; // útil para depurar desde la consola
boot();
