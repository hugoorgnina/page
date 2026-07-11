/* ============================================================
   Ale y Hugo — cliente
   Servers estilo Discord (canales de texto y de voz grupales),
   buscador de servers, llamadas directas, fotos y perfil.
   ============================================================ */

const $ = (id) => document.getElementById(id);
const CALL_CHANNEL = 'llamada';

// Preferencias del usuario (se guardan en el aparato)
const PREFS_DEFAULT = { noise: true, echo: true, agc: true, res: 720, fps: 30, micId: '', spkId: '' };
let prefs = { ...PREFS_DEFAULT };
try { prefs = { ...PREFS_DEFAULT, ...JSON.parse(localStorage.getItem('prefs') || '{}') }; } catch (_) {}
function savePrefs() { localStorage.setItem('prefs', JSON.stringify(prefs)); }

function micConstraints() {
  const c = { echoCancellation: prefs.echo, noiseSuppression: prefs.noise, autoGainControl: prefs.agc };
  if (prefs.micId) c.deviceId = { ideal: prefs.micId };
  return c;
}
function screenConstraints() {
  const h = [480, 720, 1080].includes(prefs.res) ? prefs.res : 720;
  const fps = [15, 30, 60].includes(prefs.fps) ? prefs.fps : 30;
  return { width: { ideal: Math.round(h * 16 / 9) }, height: { ideal: h }, frameRate: { ideal: fps, max: fps } };
}

// Volumen por persona (0 a 2 = 0% a 200%), guardado en el aparato
let volumes = {};
try { volumes = JSON.parse(localStorage.getItem('volumes') || '{}'); } catch (_) {}
function getVolume(userId) {
  const v = volumes[userId];
  return typeof v === 'number' && v >= 0 && v <= 2 ? v : 1;
}
function setVolume(userId, v) {
  volumes[userId] = v;
  localStorage.setItem('volumes', JSON.stringify(volumes));
  const peer = state.voice.peers.get(userId);
  if (peer) applyPeerVolume(peer, document.hidden);
}

const state = {
  token: localStorage.getItem('token') || null,
  me: null,
  users: new Map(), // id -> {id,name,avatar}
  config: null,
  socket: null,
  view: 'chat',
  unread: 0,
  lastOnline: [],
  // servers
  servers: [], // mis servers, completos
  currentServerId: null,
  currentChannelId: null, // canal de texto abierto
  openServerId: null, // tarjeta expandida en la pestaña Servers
  voiceStates: {}, // channelId -> [publicUser]
  // sesión de voz
  voice: {
    channel: null,
    micStream: null,
    camTrack: null,
    screenTrack: null,
    micOn: true,
    peers: new Map() // userId -> peer
  },
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

function getUser(id) {
  return state.users.get(id) || { id, name: '?', avatar: null };
}

function setAvatar(el, user) {
  el.innerHTML = '';
  el.style.background = '';
  if (user && user.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar;
    img.alt = '';
    el.appendChild(img);
  } else {
    el.textContent = user && user.name ? [...user.name][0].toUpperCase() : '?';
    el.style.background = user ? colorFor(user.id || user.name) : 'var(--bg3)';
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

/* ================= Sonidos ================= */

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
      await loadCore();
      enterApp();
      return;
    } catch (e) {
      const saved = JSON.parse(localStorage.getItem('creds') || 'null');
      if (saved) {
        try {
          const r = await api('/api/auth', { body: saved });
          state.token = r.token;
          localStorage.setItem('token', r.token);
          await restoreAvatarIfNeeded(r.me);
          await loadCore();
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

async function loadCore() {
  const me = await api('/api/me');
  state.me = me.me;
  await Promise.all([loadUsers(), loadServers()]);
}
async function loadUsers() {
  const { users } = await api('/api/users');
  state.users = new Map(users.map((u) => [u.id, u]));
}
async function loadServers() {
  const { servers } = await api('/api/servers/mine');
  state.servers = servers;
}

async function restoreAvatarIfNeeded(me) {
  const cached = localStorage.getItem('avatarCache');
  if (cached && !me.avatar) {
    try { await api('/api/profile', { body: { avatarDataUrl: cached } }); } catch (_) {}
  }
}

$('authBtn').addEventListener('click', () => doAuth('login'));
$('registerBtn').addEventListener('click', () => doAuth('register'));
$('authPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth('login'); });
$('togglePass').addEventListener('click', () => {
  const inp = $('authPass');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  $('togglePass').classList.toggle('showing', show);
});

async function doAuth(mode) {
  const name = $('authName').value.trim();
  const password = $('authPass').value;
  const invite = $('authInvite').value.trim();
  $('authError').textContent = '';
  try {
    const r = await api('/api/auth', { body: { name, password, invite, mode } });
    state.token = r.token;
    localStorage.setItem('token', r.token);
    localStorage.setItem('creds', JSON.stringify({ name, password, invite }));
    await restoreAvatarIfNeeded(r.me);
    await loadCore();
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
          await loadCore();
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
  setAvatar($('myAvatar'), state.me);
  $('settingsName').value = state.me.name;

  pickInitialChannel();
  renderAll();
  connectSocket();
  if (state.currentChannelId) loadMessages(state.currentChannelId);
  else switchView('servers');

  if ('Notification' in window && Notification.permission === 'default') {
    document.body.addEventListener('click', () => Notification.requestPermission(), { once: true });
  }
  if (!('getDisplayMedia' in (navigator.mediaDevices || {}))) {
    $('btnScreen').classList.add('hidden');
  }
}

function findMyChannel(channelId) {
  for (const s of state.servers) {
    const ch = s.channels.find((c) => c.id === channelId);
    if (ch) return { server: s, channel: ch };
  }
  return null;
}

/* ---- Mensajes directos (MD) ---- */
const isDm = (id) => typeof id === 'string' && id.startsWith('dm-');
const dmIdWith = (uid) => 'dm-' + [state.me.id, uid].sort().join('-');
const dmPeerId = (chId) => chId.slice(3).split('-').find((x) => x !== state.me.id);

// Mis permisos en el canal abierto (en MD se puede todo lo básico)
function currentPerms() {
  if (!state.currentChannelId) return null;
  if (isDm(state.currentChannelId)) return { sendMessages: true, attachFiles: true, manageMessages: false };
  const f = findMyChannel(state.currentChannelId);
  return f ? (f.server.perms || {}) : null;
}

function pickInitialChannel() {
  const saved = localStorage.getItem('lastChannel');
  if (saved && (isDm(saved) || findMyChannel(saved))) {
    setCurrentChannel(saved, false);
    return;
  }
  for (const s of state.servers) {
    const ch = s.channels.find((c) => c.type === 'text');
    if (ch) { setCurrentChannel(ch.id, false); return; }
  }
  state.currentChannelId = null;
  state.currentServerId = null;
}

function setCurrentChannel(channelId, load = true) {
  if (isDm(channelId)) {
    state.currentChannelId = channelId;
    state.currentServerId = null;
  } else {
    const found = findMyChannel(channelId);
    if (!found) return;
    state.currentChannelId = channelId;
    state.currentServerId = found.server.id;
    state.openServerId = found.server.id;
  }
  localStorage.setItem('lastChannel', channelId);
  cancelReply();
  if (load) {
    loadMessages(channelId);
    renderAll();
  }
}

function renderAll() {
  renderTopbar();
  renderChatEmptyState();
  renderInputPerms();
  renderDmList();
  renderMyServers();
  renderVoiceLobby();
  renderVoiceBanner();
}

function renderTopbar() {
  if (state.currentChannelId && isDm(state.currentChannelId)) {
    const peer = getUser(dmPeerId(state.currentChannelId));
    $('topbarTitle').textContent = peer.name;
    $('topbarSub').textContent = 'Mensaje directo';
    setAvatar($('topbarIcon'), peer);
    return;
  }
  const found = state.currentChannelId ? findMyChannel(state.currentChannelId) : null;
  if (found) {
    const t = $('topbarTitle');
    t.innerHTML = '<span class="hash">#</span>';
    t.appendChild(document.createTextNode(found.channel.name));
    $('topbarSub').textContent = found.server.name;
    setAvatar($('topbarIcon'), { id: found.server.id, name: found.server.name, avatar: found.server.icon });
  } else {
    $('topbarTitle').textContent = 'Ale y Hugo';
    $('topbarSub').textContent = '';
    $('topbarIcon').innerHTML = '';
    $('topbarIcon').textContent = '💜';
  }
}

// Bloquea escribir/adjuntar si el rol no lo permite
function renderInputPerms() {
  const p = currentPerms();
  const canSend = !!(p && p.sendMessages);
  const canAttach = !!(p && p.attachFiles);
  $('msgInput').disabled = !canSend;
  $('msgInput').placeholder = canSend ? 'Escribe un mensaje…' : 'No tienes permiso para escribir aquí';
  $('btnSend').style.opacity = canSend ? '' : '.35';
  $('btnPhoto').style.display = canAttach ? '' : 'none';
}

function renderChatEmptyState() {
  const empty = !state.currentChannelId;
  $('noChannel').classList.toggle('hidden', !empty);
  $('messages').classList.toggle('hidden', empty);
  $('inputBar').classList.toggle('hidden', empty);
}

function setPeerStatusOnline() {
  const sub = $('topbarSub');
  if (state.currentChannelId && isDm(state.currentChannelId)) {
    const online = state.lastOnline.includes(dmPeerId(state.currentChannelId));
    sub.textContent = online ? 'en línea 🟢' : 'desconectado';
    return;
  }
  const others = state.lastOnline.filter((id) => id !== state.me.id).length;
  const found = state.currentChannelId ? findMyChannel(state.currentChannelId) : null;
  if (found) {
    sub.textContent = found.server.name + (others > 0 ? ` · ${others} en línea` : '');
  }
}

/* ---- Navegación ---- */
$('navChat').addEventListener('click', () => switchView('chat'));
$('navVoice').addEventListener('click', () => switchView('voice'));
$('navServers').addEventListener('click', () => switchView('servers'));
$('btnGoServers').addEventListener('click', () => switchView('servers'));

function switchView(v) {
  state.view = v;
  $('viewChat').classList.toggle('hidden', v !== 'chat');
  $('viewVoice').classList.toggle('hidden', v !== 'voice');
  $('viewServers').classList.toggle('hidden', v !== 'servers');
  $('navChat').classList.toggle('active', v === 'chat');
  $('navVoice').classList.toggle('active', v === 'voice');
  $('navServers').classList.toggle('active', v === 'servers');
  if (v === 'chat') {
    state.unread = 0;
    updateBadge();
    scrollMessages(true);
  }
  if (v === 'servers') refreshAllServers();
}
function updateBadge() {
  const b = $('chatBadge');
  b.classList.toggle('hidden', state.unread === 0);
  b.textContent = state.unread > 99 ? '99+' : state.unread;
}

/* ================= Socket ================= */

function connectSocket() {
  state.socket = io({ auth: { token: state.token } });
  const s = state.socket;

  s.on('connect', async () => {
    if (state.voice.channel) s.emit('voice-join', { channel: state.voice.channel });
    try { await Promise.all([loadUsers(), loadServers()]); renderAll(); } catch (_) {}
  });

  // Si el servidor se reinició, la sesión vieja ya no vale: vuelve a entrar
  // solo con las credenciales guardadas y reconecta (evita quedarse "zombi")
  let reauthing = false;
  s.on('connect_error', async () => {
    if (reauthing) return;
    reauthing = true;
    try {
      const saved = JSON.parse(localStorage.getItem('creds') || 'null');
      if (saved) {
        const r = await api('/api/auth', { body: saved });
        state.token = r.token;
        localStorage.setItem('token', r.token);
        await restoreAvatarIfNeeded(r.me);
        await loadCore();
        if (!findMyChannel(state.currentChannelId) && !isDm(state.currentChannelId)) pickInitialChannel();
        renderAll();
        s.auth = { token: r.token };
        s.connect();
      }
    } catch (_) {}
    setTimeout(() => { reauthing = false; }, 4000);
  });

  s.on('presence', ({ online }) => {
    state.lastOnline = online;
    setPeerStatusOnline();
    renderMyServers();
  });

  s.on('users-updated', async () => {
    try { await loadUsers(); renderAll(); } catch (_) {}
  });

  s.on('server-changed', async () => {
    try {
      await loadServers();
      if (state.currentChannelId && !findMyChannel(state.currentChannelId)) pickInitialChannel();
      renderAll();
    } catch (_) {}
  });

  s.on('server-list-updated', () => {
    if (state.view === 'servers') refreshAllServers();
  });

  s.on('force-mute', ({ by }) => {
    state.voice.micOn = false;
    if (state.voice.micStream) state.voice.micStream.getAudioTracks().forEach((t) => (t.enabled = false));
    $('btnMic').classList.remove('active');
    $('btnMic').classList.add('off');
    if (state.voice.selfTile) state.voice.selfTile.root.classList.add('muted');
    sendVoiceStatus();
    toast(`🔇 ${by || 'Un moderador'} te silenció`);
  });

  s.on('force-voice-leave', ({ by }) => {
    if (state.voice.channel) leaveVoice();
    toast(`⛔ ${by || 'Un moderador'} te sacó de la sala de voz`);
  });

  s.on('chat-deleted', ({ channel, id }) => {
    if (channel !== state.currentChannelId) return;
    const row = document.querySelector(`.dmsg[data-mid="${id}"]`);
    if (row) row.remove();
  });

  s.on('reaction', ({ channel, id, reactions }) => {
    if (channel !== state.currentChannelId) return;
    const row = document.querySelector(`.dmsg[data-mid="${id}"]`);
    if (row) renderReactionChips(row.querySelector('.dreacts'), channel, id, reactions);
  });

  s.on('chat', (msg) => {
    if (msg.channel === state.currentChannelId) {
      appendMessage(msg);
      scrollMessages();
    }
    if (msg.from !== state.me.id && (msg.channel !== state.currentChannelId || state.view !== 'chat' || document.hidden)) {
      state.unread++;
      updateBadge();
      notifySound();
      showNotification(msg);
    }
  });

  s.on('typing', ({ userId, channel }) => {
    if (userId === state.me.id || channel !== state.currentChannelId) return;
    const t = $('typingIndicator');
    $('typingText').textContent = `${getUser(userId).name} está escribiendo`;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), 2500);
  });

  /* ---- Voz ---- */
  s.on('voice-snapshot', ({ states }) => {
    state.voiceStates = {};
    for (const st of states) state.voiceStates[st.channel] = st.members;
    renderVoiceLobby();
    renderMyServers();
    renderVoiceBanner();
    if (state.voice.channel) syncPeers();
  });

  s.on('voice-state', ({ channel, members }) => {
    // sonido de "entró/salió alguien" en mi sala (como Discord)
    if (channel === state.voice.channel && state.voice.channel) {
      const before = new Set((state.voiceStates[channel] || []).map((m) => m.id));
      const now = new Set(members.map((m) => m.id));
      if (before.size) {
        for (const m of members) {
          if (!before.has(m.id) && m.id !== state.me.id) { beep(520, 0.1, 0, 0.2); beep(784, 0.14, 0.1, 0.2); }
        }
      }
      for (const id of before) {
        if (!now.has(id) && id !== state.me.id) { beep(784, 0.1, 0, 0.18); beep(520, 0.14, 0.1, 0.18); }
      }
    }
    if (members.length === 0) delete state.voiceStates[channel];
    else state.voiceStates[channel] = members;
    renderVoiceLobby();
    renderMyServers();
    renderVoiceBanner();
    if (state.voice.channel === channel) syncPeers();
  });

  s.on('rtc', ({ channel, from, payload }) => {
    if (channel !== state.voice.channel) return;
    let peer = state.voice.peers.get(from);
    // si me llega una oferta nueva y mi conexión con él no está sana
    // desde hace rato, la tiro y empiezo de cero con esta oferta
    if (peer && payload.description && payload.description.type === 'offer'
        && peer.pc.connectionState !== 'connected'
        && Date.now() - Math.max(peer.lastOk || 0, peer.createdAt) > 8000) {
      removePeer(from);
      peer = null;
    }
    if (!peer) {
      peer = createPeer(getUser(from));
      updateTilesLayout();
    }
    handleRtc(peer, payload);
  });

  s.on('voice-status', ({ channel, userId, status }) => {
    if (channel !== state.voice.channel) return;
    const peer = state.voice.peers.get(userId);
    if (peer && peer.tile) peer.tile.root.classList.toggle('muted', status && status.mic === false);
  });

  /* ---- Llamadas ---- */
  s.on('call-incoming', ({ from, video }) => {
    if (state.voice.channel || state.calling) { s.emit('call-reject'); return; }
    state.incoming = { from, video };
    $('incomingName').textContent = from.name;
    $('incomingType').textContent = video ? 'Videollamada entrante' : 'Llamada entrante';
    setAvatar($('incomingAvatar'), from);
    $('incomingCall').classList.remove('hidden');
    startRingtone(true);
    showNotification({ type: 'call', fromUser: from, video });
  });

  s.on('call-accepted', () => {
    if (!state.calling) return;
    stopRingtone();
    $('outgoingCall').classList.add('hidden');
    const video = state.calling === 'video';
    state.calling = false;
    joinVoice(CALL_CHANNEL, video);
  });

  s.on('call-rejected', () => {
    if (!state.calling) return;
    stopRingtone();
    state.calling = false;
    $('outgoingCall').classList.add('hidden');
    toast('No contestaron la llamada 💔');
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
    if (msg.type === 'call') {
      new Notification(`📞 ${msg.fromUser.name}`, { body: msg.video ? 'Videollamada entrante' : 'Llamada entrante' });
    } else {
      new Notification(getUser(msg.from).name, { body: msg.type === 'image' ? '📷 Foto' : msg.text });
    }
  } catch (_) {}
}

/* ================= Chat (estilo Discord: mensajes agrupados) ================= */

let lastDay = null;
let lastAuthor = null;
let lastTs = 0;

async function loadMessages(channelId) {
  const list = $('messages');
  list.innerHTML = '';
  lastDay = null;
  lastAuthor = null;
  lastTs = 0;
  const intro = document.createElement('div');
  intro.className = 'channel-intro';
  if (isDm(channelId)) {
    const peer = getUser(dmPeerId(channelId));
    const icon = document.createElement('div');
    icon.className = 'avatar big-avatar';
    setAvatar(icon, peer);
    intro.appendChild(icon);
    const h = document.createElement('h2');
    h.textContent = peer.name;
    intro.appendChild(h);
    const p = document.createElement('p');
    p.textContent = 'Este es el comienzo de sus mensajes directos. Solo ustedes dos los ven. 💌';
    intro.appendChild(p);
    list.appendChild(intro);
  } else {
    const found = findMyChannel(channelId);
    if (found) {
      const icon = document.createElement('div');
      icon.className = 'ci-icon';
      icon.textContent = '#';
      intro.appendChild(icon);
      const h = document.createElement('h2');
      h.textContent = '¡Bienvenido a #' + found.channel.name + '!';
      intro.appendChild(h);
      const p = document.createElement('p');
      p.textContent = `Este es el comienzo del canal #${found.channel.name} de ${found.server.name}.`;
      intro.appendChild(p);
      list.appendChild(intro);
    }
  }
  try {
    const { messages } = await api('/api/channels/' + channelId + '/messages');
    messages.forEach(appendMessage);
    scrollMessages(true);
  } catch (_) {}
}

function appendMessage(msg) {
  const list = $('messages');
  const day = fmtDay(msg.ts);
  if (day !== lastDay) {
    lastDay = day;
    lastAuthor = null;
    const sep = document.createElement('div');
    sep.className = 'day-sep';
    sep.textContent = day;
    list.appendChild(sep);
  }
  const author = msg.from === state.me.id ? state.me : getUser(msg.from);
  // agrupa mensajes seguidos del mismo autor (menos de 5 min entre sí)
  const grouped = lastAuthor === msg.from && msg.ts - lastTs < 5 * 60 * 1000;
  lastAuthor = msg.from;
  lastTs = msg.ts;

  const row = document.createElement('div');
  row.className = 'dmsg' + (grouped ? ' grouped' : ' first');
  row.dataset.mid = msg.id;

  const content = document.createElement('div');
  content.className = 'dcontent';

  if (!grouped) {
    const av = document.createElement('div');
    av.className = 'avatar';
    setAvatar(av, author);
    row.appendChild(av);
    const header = document.createElement('div');
    header.className = 'dheader';
    const name = document.createElement('span');
    name.className = 'dname';
    name.textContent = author.name;
    name.style.color = roleColorFor(author.id);
    header.appendChild(name);
    const time = document.createElement('span');
    time.className = 'dtime';
    time.textContent = fmtTime(msg.ts);
    header.appendChild(time);
    content.appendChild(header);
  }

  if (msg.type === 'image') {
    const wrap = document.createElement('div');
    wrap.className = 'dimg';
    const img = document.createElement('img');
    img.src = msg.url;
    img.loading = 'lazy';
    img.addEventListener('click', () => openImage(msg.url));
    img.addEventListener('load', () => scrollMessages());
    wrap.appendChild(img);
    content.appendChild(wrap);
  } else {
    const text = document.createElement('div');
    text.className = 'dtext';
    text.textContent = msg.text;
    content.appendChild(text);
  }

  // cita de respuesta (va encima del texto)
  if (msg.replyTo) {
    const quote = document.createElement('div');
    quote.className = 'dreply';
    const who = document.createElement('b');
    who.textContent = '↩ ' + getUser(msg.replyTo.from).name + ': ';
    quote.appendChild(who);
    quote.appendChild(document.createTextNode(msg.replyTo.text));
    content.insertBefore(quote, content.querySelector('.dtext, .dimg'));
  }

  // chips de reacciones
  const reacts = document.createElement('div');
  reacts.className = 'dreacts';
  content.appendChild(reacts);
  renderReactionChips(reacts, msg.channel || state.currentChannelId, msg.id, msg.reactions || {});

  row.appendChild(content);

  // acciones: reaccionar, responder y borrar
  const acts = document.createElement('div');
  acts.className = 'msg-acts';
  const reactBtn = document.createElement('button');
  reactBtn.textContent = '😀';
  reactBtn.title = 'Reaccionar';
  reactBtn.addEventListener('click', () => openReactPicker(msg));
  acts.appendChild(reactBtn);
  const replyBtn = document.createElement('button');
  replyBtn.textContent = '↩';
  replyBtn.title = 'Responder';
  replyBtn.addEventListener('click', () => startReply(msg));
  acts.appendChild(replyBtn);
  const p = currentPerms();
  if (msg.from === state.me.id || (p && p.manageMessages)) {
    const del = document.createElement('button');
    del.textContent = '🗑';
    del.title = 'Borrar mensaje';
    del.addEventListener('click', () => {
      if (confirm('¿Borrar este mensaje?')) {
        state.socket.emit('chat-delete', { channel: msg.channel || state.currentChannelId, id: msg.id });
      }
    });
    acts.appendChild(del);
  }
  row.appendChild(acts);
  list.appendChild(row);
}

/* ---- Reacciones ---- */
const REACT_EMOJIS = ['❤️', '😂', '😮', '😢', '👍', '🔥', '💜', '😍'];

function renderReactionChips(container, channel, id, reactions) {
  container.innerHTML = '';
  for (const [emoji, users] of Object.entries(reactions || {})) {
    if (!users.length) continue;
    const chip = document.createElement('button');
    chip.className = users.includes(state.me.id) ? 'mine' : '';
    chip.textContent = `${emoji} ${users.length}`;
    chip.title = users.map((u) => getUser(u).name).join(', ');
    chip.addEventListener('click', () => {
      state.socket.emit('react', { channel, id, emoji });
    });
    container.appendChild(chip);
  }
}

let reactTarget = null;
function openReactPicker(msg) {
  reactTarget = msg;
  const card = $('reactCard');
  card.innerHTML = '';
  for (const e of REACT_EMOJIS) {
    const b = document.createElement('button');
    b.textContent = e;
    b.addEventListener('click', () => {
      state.socket.emit('react', { channel: reactTarget.channel || state.currentChannelId, id: reactTarget.id, emoji: e });
      $('reactOverlay').classList.add('hidden');
    });
    card.appendChild(b);
  }
  $('reactOverlay').classList.remove('hidden');
}
$('reactOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'reactOverlay') $('reactOverlay').classList.add('hidden');
});

/* ---- Responder / citar ---- */
let replyTo = null;
function startReply(msg) {
  replyTo = msg;
  const snippet = msg.type === 'image' ? '📷 Foto' : (msg.text || '').slice(0, 60);
  $('replyText').textContent = `↩ Respondiendo a ${getUser(msg.from).name}: ${snippet}`;
  $('replyBar').classList.remove('hidden');
  $('msgInput').focus();
}
function cancelReply() {
  replyTo = null;
  $('replyBar').classList.add('hidden');
}
$('btnCancelReply').addEventListener('click', cancelReply);

// El nombre toma el color del rol más alto (como Discord)
function roleColorFor(userId) {
  const chId = state.currentChannelId;
  if (chId && !isDm(chId)) {
    const f = findMyChannel(chId);
    if (f) {
      const rids = (f.server.memberRoles || {})[userId] || [];
      for (const rid of rids) {
        const r = f.server.roles.find((x) => x.id === rid);
        if (r) return r.color;
      }
    }
  }
  return colorFor(userId);
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
  if (now - typingThrottle > 1500 && state.currentChannelId) {
    typingThrottle = now;
    state.socket && state.socket.emit('typing', { channel: state.currentChannelId });
  }
});

function sendText() {
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text || !state.currentChannelId) return;
  const data = { channel: state.currentChannelId, type: 'text', text };
  if (replyTo) data.replyTo = replyTo.id;
  state.socket.emit('chat', data);
  cancelReply();
  input.value = '';
  input.focus();
}

$('btnPhoto').addEventListener('click', () => $('photoInput').click());
$('photoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.currentChannelId) return;
  toast('Enviando foto…');
  try {
    const dataUrl = await compressImage(file);
    const { url } = await api('/api/upload', { body: { dataUrl } });
    state.socket.emit('chat', { channel: state.currentChannelId, type: 'image', url });
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

/* ================= Pestaña Servers ================= */

function renderMyServers() {
  const wrap = $('myServers');
  wrap.innerHTML = '';
  if (state.servers.length === 0) {
    const p = document.createElement('p');
    p.className = 'voice-room-desc';
    p.style.padding = '10px';
    p.textContent = 'Todavía no estás en ningún server. Crea uno o busca arriba ⬆️';
    wrap.appendChild(p);
    return;
  }
  for (const srv of state.servers) {
    wrap.appendChild(serverCard(srv));
  }
}

function serverCard(srv) {
  const card = document.createElement('div');
  card.className = 'server-card' + (state.openServerId === srv.id ? ' open' : '');

  const head = document.createElement('button');
  head.className = 'server-head';
  const icon = document.createElement('div');
  icon.className = 'avatar';
  setAvatar(icon, { id: srv.id, name: srv.name, avatar: srv.icon });
  head.appendChild(icon);
  const title = document.createElement('div');
  title.className = 'server-title';
  title.innerHTML = `<div class="s-name"></div><div class="s-meta"></div>`;
  title.querySelector('.s-name').textContent = (srv.hasPassword ? '🔒 ' : '') + srv.name;
  const online = srv.members.filter((id) => state.lastOnline.includes(id)).length;
  const meta = title.querySelector('.s-meta');
  const dot = document.createElement('span');
  dot.className = 'online-dot';
  meta.appendChild(dot);
  meta.appendChild(document.createTextNode(
    `${online} en línea · ${srv.members.length} miembro${srv.members.length === 1 ? '' : 's'}${srv.ownerId === state.me.id ? ' · tuyo' : ''}`
  ));
  head.appendChild(title);
  const chev = document.createElement('span');
  chev.className = 'server-chevron';
  chev.textContent = '▶';
  head.appendChild(chev);
  head.addEventListener('click', () => {
    state.openServerId = state.openServerId === srv.id ? null : srv.id;
    renderMyServers();
  });
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'server-channels';
  for (const ch of srv.channels) {
    const item = document.createElement('button');
    item.className = 'channel-item' + (ch.id === state.currentChannelId ? ' current' : '');
    if (ch.type === 'text') {
      item.textContent = '# ' + ch.name;
      item.addEventListener('click', () => {
        setCurrentChannel(ch.id);
        switchView('chat');
      });
    } else {
      item.textContent = '🔊 ' + ch.name;
      const members = state.voiceStates[ch.id] || [];
      if (members.length) {
        const mm = document.createElement('span');
        mm.className = 'ch-members';
        for (const m of members.slice(0, 4)) {
          const a = document.createElement('div');
          a.className = 'avatar';
          setAvatar(a, m);
          mm.appendChild(a);
        }
        item.appendChild(mm);
      }
      item.addEventListener('click', () => joinVoice(ch.id));
    }
    body.appendChild(item);
  }
  const perms = srv.perms || {};
  if (perms.manageChannels) {
    const add = document.createElement('button');
    add.className = 'channel-item add';
    add.textContent = '＋ Crear canal';
    add.addEventListener('click', () => openCreateChannel(srv.id));
    body.appendChild(add);
  }
  const actions = document.createElement('div');
  actions.className = 'server-actions';
  if (perms.manageServer || perms.manageRoles || perms.manageChannels || perms.kickMembers || perms.banMembers) {
    const settings = document.createElement('button');
    settings.className = 'btn-ghost';
    settings.style.color = 'var(--text)';
    settings.textContent = '⚙️ Ajustes';
    settings.addEventListener('click', () => openServerSettings(srv.id));
    actions.appendChild(settings);
  }
  const leave = document.createElement('button');
  leave.className = 'btn-ghost';
  leave.textContent = 'Salir del server';
  leave.addEventListener('click', async () => {
    if (!confirm(`¿Salir de "${srv.name}"?${srv.members.length === 1 ? ' Eres el último: el server se borrará.' : ''}`)) return;
    try {
      await api(`/api/servers/${srv.id}/leave`, { body: {} });
      await loadServers();
      if (!findMyChannel(state.currentChannelId)) pickInitialChannel();
      renderAll();
      if (state.currentChannelId) loadMessages(state.currentChannelId);
    } catch (e) { toast(e.message); }
  });
  actions.appendChild(leave);
  body.appendChild(actions);
  card.appendChild(body);
  return card;
}

/* ---- Mensajes directos (lista de personas) ---- */

function renderDmList() {
  const wrap = $('dmList');
  if (!wrap) return;
  wrap.innerHTML = '';
  const others = [...state.users.values()].filter((u) => u.id !== state.me.id);
  if (others.length === 0) {
    const p = document.createElement('p');
    p.className = 'voice-room-desc';
    p.style.padding = '6px';
    p.textContent = 'Cuando alguien más se registre, aparecerá aquí para escribirle.';
    wrap.appendChild(p);
    return;
  }
  for (const u of others) {
    const card = document.createElement('div');
    card.className = 'server-card';
    const head = document.createElement('button');
    head.className = 'server-head';
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.borderRadius = '50%';
    setAvatar(av, u);
    head.appendChild(av);
    const title = document.createElement('div');
    title.className = 'server-title';
    title.innerHTML = `<div class="s-name"></div><div class="s-meta"></div>`;
    title.querySelector('.s-name').textContent = u.name;
    const online = state.lastOnline.includes(u.id);
    title.querySelector('.s-meta').textContent = online ? '🟢 en línea' : 'desconectado';
    head.appendChild(title);
    const chip = document.createElement('span');
    chip.className = 'server-chevron';
    chip.textContent = '💬';
    head.appendChild(chip);
    head.addEventListener('click', () => {
      setCurrentChannel(dmIdWith(u.id));
      switchView('chat');
    });
    card.appendChild(head);
    wrap.appendChild(card);
  }
}

/* ---- Lista de TODOS los servers (con buscador que filtra) ---- */

let searchTimer = null;
let allServersCache = [];
$('serverSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refreshAllServers, 300);
});

async function refreshAllServers() {
  const q = $('serverSearch').value.trim();
  try {
    const { servers } = await api('/api/servers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    allServersCache = servers;
    renderAllServers();
  } catch (_) {}
}

function renderAllServers() {
  const box = $('allServers');
  box.innerHTML = '';
  if (allServersCache.length === 0) {
    const p = document.createElement('p');
    p.className = 'voice-room-desc';
    p.style.padding = '6px';
    const q = $('serverSearch').value.trim();
    p.textContent = q ? `No hay ningún server que se llame "${q}". ¡Créalo tú!` : 'Todavía no hay servers. ¡Crea el primero!';
    box.appendChild(p);
    return;
  }
  for (const srv of allServersCache) {
    const card = document.createElement('div');
    card.className = 'server-card';
    const head = document.createElement('div');
    head.className = 'server-head';
    const icon = document.createElement('div');
    icon.className = 'avatar';
    setAvatar(icon, { id: srv.id, name: srv.name, avatar: srv.icon });
    head.appendChild(icon);
    const title = document.createElement('div');
    title.className = 'server-title';
    title.innerHTML = `<div class="s-name"></div><div class="s-meta"></div>`;
    title.querySelector('.s-name').textContent = (srv.hasPassword ? '🔒 ' : '') + srv.name;
    title.querySelector('.s-meta').textContent = `${srv.memberCount} miembro${srv.memberCount === 1 ? '' : 's'}`;
    head.appendChild(title);
    const btn = document.createElement('button');
    btn.className = 'server-join-btn';
    if (srv.isMember) {
      btn.textContent = 'Dentro ✓';
      btn.style.background = 'var(--bg-raised)';
    } else {
      btn.textContent = 'Unirme';
      btn.addEventListener('click', () => joinServer(srv));
    }
    head.appendChild(btn);
    card.appendChild(head);
    box.appendChild(card);
  }
}

async function joinServer(srv, password) {
  try {
    const { server } = await api(`/api/servers/${srv.id}/join`, { body: { password } });
    $('joinPassOverlay').classList.add('hidden');
    await loadServers();
    const general = server.channels.find((c) => c.type === 'text');
    if (general) setCurrentChannel(general.id);
    renderAll();
    switchView('chat');
    toast(`¡Bienvenido a ${server.name}! 🎉`);
    $('serverSearch').value = '';
  } catch (e) {
    if (e.code === 'password') {
      // pide la contraseña del server
      $('joinPassTitle').textContent = '🔒 ' + srv.name;
      $('joinPassError').textContent = password ? 'Contraseña incorrecta.' : '';
      $('joinPassInput').value = '';
      $('joinPassOverlay').classList.remove('hidden');
      $('btnDoJoinPass').onclick = () => joinServer(srv, $('joinPassInput').value);
    } else {
      toast(e.message);
    }
  }
}
$('btnCloseJoinPass').addEventListener('click', () => $('joinPassOverlay').classList.add('hidden'));

/* ---- Crear server ---- */

let newServerIconData = null;
$('btnCreateServer').addEventListener('click', () => {
  newServerIconData = null;
  $('newServerIcon').innerHTML = '🎮';
  $('newServerName').value = '';
  $('newServerPass').value = '';
  $('createServerError').textContent = '';
  $('createServerOverlay').classList.remove('hidden');
});
$('btnCloseCreateServer').addEventListener('click', () => $('createServerOverlay').classList.add('hidden'));
$('btnServerIcon').addEventListener('click', () => $('serverIconInput').click());
$('serverIconInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    newServerIconData = await compressImage(file, 256, 0.9);
    $('newServerIcon').innerHTML = `<img src="${newServerIconData}" alt="" />`;
  } catch (_) {}
});
$('btnDoCreateServer').addEventListener('click', async () => {
  try {
    const { server } = await api('/api/servers', {
      body: {
        name: $('newServerName').value,
        password: $('newServerPass').value,
        iconDataUrl: newServerIconData
      }
    });
    $('createServerOverlay').classList.add('hidden');
    await loadServers();
    const general = server.channels.find((c) => c.type === 'text');
    if (general) setCurrentChannel(general.id);
    renderAll();
    switchView('chat');
    toast(`Server "${server.name}" creado 🎉 Ya aparece en el buscador.`);
  } catch (e) {
    $('createServerError').textContent = e.message;
  }
});

/* ---- Ajustes del server: roles, miembros y canales ---- */

const PERM_LABELS = {
  admin: '🛡️ Administrador (todo el poder)',
  manageServer: 'Gestionar server (nombre, foto, contraseña)',
  manageChannels: 'Gestionar canales (crear y borrar)',
  manageRoles: 'Gestionar roles',
  manageMessages: 'Gestionar mensajes (borrar de otros)',
  kickMembers: 'Expulsar miembros',
  banMembers: 'Banear miembros',
  sendMessages: 'Enviar mensajes',
  attachFiles: 'Adjuntar fotos',
  connect: 'Conectarse a canales de voz',
  speak: 'Hablar (micrófono)',
  video: 'Cámara y compartir pantalla',
  muteMembers: 'Silenciar a otros en voz',
  disconnectMembers: 'Sacar a otros de la sala de voz'
};
const ROLE_COLORS = ['#5865f2', '#23a55a', '#f0b232', '#eb459e', '#f23f43', '#3498db', '#9b59b6', '#e67e22'];

function myServer(serverId) {
  return state.servers.find((s) => s.id === serverId);
}

function openServerSettings(serverId) {
  const srv = myServer(serverId);
  if (!srv) return;
  const perms = srv.perms || {};
  $('ssTitle').textContent = '⚙️ ' + srv.name;
  const body = $('ssBody');
  body.innerHTML = '';

  const section = (text) => {
    const h = document.createElement('h3');
    h.className = 'settings-section';
    h.textContent = text;
    body.appendChild(h);
  };

  // --- Server (nombre, foto, contraseña) ---
  if (perms.manageServer) {
    section('Server');
    const nameInput = document.createElement('input');
    nameInput.value = srv.name;
    nameInput.maxLength = 40;
    body.appendChild(nameInput);
    const passInput = document.createElement('input');
    passInput.placeholder = 'Contraseña (vacía = público)';
    body.appendChild(passInput);
    const row = document.createElement('div');
    row.className = 'channel-type-row';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-secondary active';
    saveBtn.textContent = 'Guardar';
    saveBtn.addEventListener('click', async () => {
      try {
        await api(`/api/servers/${srv.id}`, { method: 'PATCH', body: { name: nameInput.value, password: passInput.value } });
        await loadServers();
        renderAll();
        toast('Server actualizado ✅');
        openServerSettings(serverId);
      } catch (e) { toast(e.message); }
    });
    row.appendChild(saveBtn);
    const iconBtn = document.createElement('button');
    iconBtn.className = 'btn-secondary';
    iconBtn.textContent = 'Cambiar foto';
    const iconInput = document.createElement('input');
    iconInput.type = 'file';
    iconInput.accept = 'image/*';
    iconInput.className = 'hidden';
    iconBtn.addEventListener('click', () => iconInput.click());
    iconInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const dataUrl = await compressImage(file, 256, 0.9);
        await api(`/api/servers/${srv.id}`, { method: 'PATCH', body: { iconDataUrl: dataUrl } });
        await loadServers();
        renderAll();
        toast('Foto del server actualizada ✨');
      } catch (err) { toast('No se pudo cambiar la foto'); }
    });
    row.appendChild(iconBtn);
    body.appendChild(row);
    body.appendChild(iconInput);
  }

  // --- Roles ---
  if (perms.manageRoles) {
    section('Roles');
    for (const role of srv.roles) {
      const rrow = document.createElement('div');
      rrow.className = 'setting-row';
      const label = document.createElement('span');
      label.innerHTML = '<span class="online-dot"></span> ';
      label.querySelector('.online-dot').style.background = role.color;
      label.appendChild(document.createTextNode(role.name));
      rrow.appendChild(label);
      const btns = document.createElement('span');
      const edit = document.createElement('button');
      edit.className = 'btn-small';
      edit.textContent = 'Editar';
      edit.addEventListener('click', () => openRoleEditor(serverId, role));
      btns.appendChild(edit);
      if (role.id !== 'everyone') {
        const del = document.createElement('button');
        del.className = 'btn-ghost';
        del.textContent = '🗑';
        del.addEventListener('click', async () => {
          if (!confirm(`¿Borrar el rol "${role.name}"?`)) return;
          try {
            await api(`/api/servers/${srv.id}/roles/${role.id}`, { method: 'DELETE' });
            await loadServers();
            openServerSettings(serverId);
          } catch (e) { toast(e.message); }
        });
        btns.appendChild(del);
      }
      rrow.appendChild(btns);
      body.appendChild(rrow);
    }
    const addRole = document.createElement('button');
    addRole.className = 'btn-secondary';
    addRole.textContent = '＋ Crear rol';
    addRole.addEventListener('click', () => openRoleEditor(serverId, null));
    body.appendChild(addRole);
  }

  // --- Miembros ---
  section('Miembros');
  for (const uid of srv.members) {
    const u = getUser(uid);
    const mrow = document.createElement('div');
    mrow.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px 0;border-bottom:1px solid var(--divider)';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;gap:10px';
    const av = document.createElement('div');
    av.className = 'avatar';
    setAvatar(av, u);
    top.appendChild(av);
    const nm = document.createElement('span');
    nm.style.cssText = 'flex:1;font-weight:600';
    nm.textContent = u.name + (uid === srv.ownerId ? ' 👑' : '');
    top.appendChild(nm);
    if (uid !== srv.ownerId && uid !== state.me.id) {
      if (perms.kickMembers) {
        const kick = document.createElement('button');
        kick.className = 'btn-ghost';
        kick.textContent = '🥾';
        kick.title = 'Expulsar';
        kick.addEventListener('click', async () => {
          if (!confirm(`¿Expulsar a ${u.name}? Podrá volver a unirse.`)) return;
          try { await api(`/api/servers/${srv.id}/kick`, { body: { userId: uid } }); await loadServers(); openServerSettings(serverId); }
          catch (e) { toast(e.message); }
        });
        top.appendChild(kick);
      }
      if (perms.banMembers) {
        const ban = document.createElement('button');
        ban.className = 'btn-ghost';
        ban.textContent = '🔨';
        ban.title = 'Banear';
        ban.addEventListener('click', async () => {
          if (!confirm(`¿Banear a ${u.name}? No podrá volver a entrar.`)) return;
          try { await api(`/api/servers/${srv.id}/ban`, { body: { userId: uid } }); await loadServers(); openServerSettings(serverId); }
          catch (e) { toast(e.message); }
        });
        top.appendChild(ban);
      }
    }
    mrow.appendChild(top);
    // chips de roles: tocar para asignar/quitar
    if (perms.manageRoles && srv.roles.some((r) => r.id !== 'everyone')) {
      const chips = document.createElement('div');
      chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
      for (const role of srv.roles) {
        if (role.id === 'everyone') continue;
        const has = ((srv.memberRoles || {})[uid] || []).includes(role.id);
        const chip = document.createElement('button');
        chip.textContent = role.name;
        chip.style.cssText = `font-size:12px;font-weight:600;padding:5px 10px;border-radius:12px;border:1.5px solid ${role.color};` +
          (has ? `background:${role.color};color:#fff` : `color:${role.color};background:transparent;opacity:.6`);
        chip.addEventListener('click', async () => {
          try {
            await api(`/api/servers/${srv.id}/members/${uid}/roles`, { body: { roleId: role.id, add: !has } });
            await loadServers();
            openServerSettings(serverId);
          } catch (e) { toast(e.message); }
        });
        chips.appendChild(chip);
      }
      mrow.appendChild(chips);
    }
    body.appendChild(mrow);
  }

  // --- Canales ---
  if (perms.manageChannels) {
    section('Canales');
    for (const ch of srv.channels) {
      const crow = document.createElement('div');
      crow.className = 'setting-row';
      const label = document.createElement('span');
      label.textContent = (ch.type === 'voice' ? '🔊 ' : '# ') + ch.name;
      crow.appendChild(label);
      const del = document.createElement('button');
      del.className = 'btn-ghost';
      del.textContent = '🗑';
      del.addEventListener('click', async () => {
        if (!confirm(`¿Borrar el canal "${ch.name}" y todos sus mensajes?`)) return;
        try {
          await api(`/api/servers/${srv.id}/channels/${ch.id}`, { method: 'DELETE' });
          await loadServers();
          if (!findMyChannel(state.currentChannelId) && !isDm(state.currentChannelId)) pickInitialChannel();
          renderAll();
          openServerSettings(serverId);
        } catch (e) { toast(e.message); }
      });
      crow.appendChild(del);
      body.appendChild(crow);
    }
  }

  $('serverSettingsOverlay').classList.remove('hidden');
}
$('btnCloseServerSettings').addEventListener('click', () => $('serverSettingsOverlay').classList.add('hidden'));

/* ---- Editor de rol ---- */

let roleEditCtx = null; // { serverId, roleId|null, color, perms }
function openRoleEditor(serverId, role) {
  const srv = myServer(serverId);
  if (!srv) return;
  roleEditCtx = {
    serverId,
    roleId: role ? role.id : null,
    color: role ? role.color : ROLE_COLORS[0],
    perms: role ? { ...role.perms } : {}
  };
  $('reTitle').textContent = role ? 'Editar rol: ' + role.name : 'Crear rol';
  $('reError').textContent = '';
  const body = $('reBody');
  body.innerHTML = '';

  const isEveryone = role && role.id === 'everyone';
  const nameInput = document.createElement('input');
  nameInput.id = 'reName';
  nameInput.maxLength = 30;
  nameInput.placeholder = 'Nombre del rol';
  nameInput.value = role ? role.name : '';
  nameInput.disabled = isEveryone;
  body.appendChild(nameInput);

  if (!isEveryone) {
    const palette = document.createElement('div');
    palette.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;padding:6px 0';
    for (const c of ROLE_COLORS) {
      const b = document.createElement('button');
      b.style.cssText = `width:34px;height:34px;border-radius:50%;background:${c};border:3px solid ${c === roleEditCtx.color ? '#fff' : 'transparent'}`;
      b.addEventListener('click', () => {
        roleEditCtx.color = c;
        palette.querySelectorAll('button').forEach((x, i) => { x.style.borderColor = ROLE_COLORS[i] === c ? '#fff' : 'transparent'; });
      });
      palette.appendChild(b);
    }
    body.appendChild(palette);
  }

  const h = document.createElement('h3');
  h.className = 'settings-section';
  h.textContent = 'Permisos';
  body.appendChild(h);
  for (const [key, label] of Object.entries(PERM_LABELS)) {
    const row = document.createElement('div');
    row.className = 'setting-row';
    const span = document.createElement('span');
    span.textContent = label;
    span.style.fontSize = '14px';
    row.appendChild(span);
    const sw = document.createElement('button');
    sw.className = 'switch' + (roleEditCtx.perms[key] ? ' on' : '');
    sw.addEventListener('click', () => {
      roleEditCtx.perms[key] = !roleEditCtx.perms[key];
      sw.classList.toggle('on', roleEditCtx.perms[key]);
    });
    row.appendChild(sw);
    body.appendChild(row);
  }
  $('roleEditOverlay').classList.remove('hidden');
}

$('btnCloseRoleEdit').addEventListener('click', () => $('roleEditOverlay').classList.add('hidden'));
$('btnSaveRole').addEventListener('click', async () => {
  if (!roleEditCtx) return;
  const bodyData = {
    name: $('reName') ? $('reName').value : '',
    color: roleEditCtx.color,
    perms: roleEditCtx.perms
  };
  try {
    if (roleEditCtx.roleId) {
      await api(`/api/servers/${roleEditCtx.serverId}/roles/${roleEditCtx.roleId}`, { method: 'PATCH', body: bodyData });
    } else {
      await api(`/api/servers/${roleEditCtx.serverId}/roles`, { body: bodyData });
    }
    await loadServers();
    $('roleEditOverlay').classList.add('hidden');
    openServerSettings(roleEditCtx.serverId);
  } catch (e) {
    $('reError').textContent = e.message;
  }
});

/* ---- Crear canal ---- */

let newChannelType = 'text';
let newChannelServerId = null;
function openCreateChannel(serverId) {
  newChannelServerId = serverId;
  newChannelType = 'text';
  $('chTypeText').classList.add('active');
  $('chTypeVoice').classList.remove('active');
  $('newChannelName').value = '';
  $('createChannelError').textContent = '';
  $('createChannelOverlay').classList.remove('hidden');
}
$('chTypeText').addEventListener('click', () => {
  newChannelType = 'text';
  $('chTypeText').classList.add('active');
  $('chTypeVoice').classList.remove('active');
});
$('chTypeVoice').addEventListener('click', () => {
  newChannelType = 'voice';
  $('chTypeVoice').classList.add('active');
  $('chTypeText').classList.remove('active');
});
$('btnCloseCreateChannel').addEventListener('click', () => $('createChannelOverlay').classList.add('hidden'));
$('btnDoCreateChannel').addEventListener('click', async () => {
  try {
    await api(`/api/servers/${newChannelServerId}/channels`, {
      body: { name: $('newChannelName').value, type: newChannelType }
    });
    $('createChannelOverlay').classList.add('hidden');
    await loadServers();
    renderAll();
  } catch (e) {
    $('createChannelError').textContent = e.message;
  }
});

/* ================= Voz: lobby y banner ================= */

function renderVoiceLobby() {
  const list = $('voiceChannelList');
  list.innerHTML = '';
  let any = false;
  for (const srv of state.servers) {
    for (const ch of srv.channels) {
      if (ch.type !== 'voice') continue;
      any = true;
      const item = document.createElement('button');
      item.className = 'voice-channel-item';
      const name = document.createElement('span');
      name.className = 'vc-name';
      name.textContent = `🔊 ${ch.name} · ${srv.name}`;
      item.appendChild(name);
      const members = state.voiceStates[ch.id] || [];
      const mm = document.createElement('span');
      mm.className = 'vc-members';
      for (const m of members.slice(0, 5)) {
        const a = document.createElement('div');
        a.className = 'avatar';
        setAvatar(a, m);
        mm.appendChild(a);
      }
      item.appendChild(mm);
      item.addEventListener('click', () => joinVoice(ch.id));
      list.appendChild(item);
    }
  }
  $('voiceLobbyHint').textContent = any
    ? 'Toca un canal para entrar. Entra y sal cuando quieras: los demás se quedan.'
    : 'Únete a un server (pestaña Servers) para tener canales de voz.';
}

function renderVoiceBanner() {
  // aviso en el chat cuando hay gente en algún canal de voz de mis servers
  let found = null;
  for (const srv of state.servers) {
    for (const ch of srv.channels) {
      if (ch.type !== 'voice') continue;
      const members = (state.voiceStates[ch.id] || []).filter((m) => m.id !== state.me.id);
      if (members.length) { found = { srv, ch, members }; break; }
    }
    if (found) break;
  }
  if (found && !state.voice.channel) {
    $('voiceBanner').classList.remove('hidden');
    const names = found.members.map((m) => m.name).join(', ');
    $('voiceBannerText').textContent = `🎧 ${names} en ${found.ch.name}`;
    $('voiceBannerJoin').onclick = () => joinVoice(found.ch.id);
  } else {
    $('voiceBanner').classList.add('hidden');
  }
  $('voiceDot').classList.toggle('hidden', !found && !state.voice.channel);
}

/* ================= Voz: sala grupal (mesh WebRTC) ================= */

$('btnLeaveVoice').addEventListener('click', () => leaveVoice());

// Mis permisos en el canal de voz actual (en llamadas directas, todos)
function voicePermsNow(channelId) {
  const ch = channelId || state.voice.channel;
  if (!ch || ch === CALL_CHANNEL) {
    return { connect: true, speak: true, video: true, muteMembers: false, disconnectMembers: false };
  }
  const f = findMyChannel(ch);
  return f ? (f.server.perms || {}) : {};
}

async function joinVoice(channelId, withVideo) {
  if (state.voice.channel === channelId) { switchView('voice'); return; }
  const vp = voicePermsNow(channelId);
  if (!vp.connect) { toast('No tienes permiso para entrar a este canal de voz'); return; }
  if (state.voice.channel) leaveVoice(true);
  try {
    state.voice.micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
  } catch (e) {
    toast('Necesito permiso del micrófono 🎙️');
    return;
  }
  state.voice.micOn = !!vp.speak;
  if (!vp.speak) {
    state.voice.micStream.getAudioTracks().forEach((t) => (t.enabled = false));
    toast('En este canal no tienes permiso para hablar 🔇');
  }
  state.voice.channel = channelId;
  $('btnMic').classList.toggle('active', state.voice.micOn);
  $('btnMic').classList.toggle('off', !state.voice.micOn);
  switchView('voice');
  $('voiceLobby').classList.add('hidden');
  $('voiceRoom').classList.remove('hidden');
  state.voice.selfTile = makeTile(state.me, true); // mi propio cuadro en la cuadrícula
  if (!state.voice.micOn) state.voice.selfTile.root.classList.add('muted');
  state.voice.selfMeter = makeMeter(state.voice.micStream);
  // recuadro verde en quien está hablando (como Discord)
  state.voice.speakTimer = setInterval(() => {
    selfAudioLevel().then((lvl) => {
      const st = state.voice.selfTile;
      if (st) st.root.classList.toggle('speaking', state.voice.micOn && lvl > 0.03);
    });
    for (const peer of state.voice.peers.values()) {
      remoteAudioLevel(peer).then((lvl) => {
        if (peer.tile) peer.tile.root.classList.toggle('speaking', lvl > 0.02);
      });
    }
  }, 200);
  setMediaSession(true);
  state.socket.emit('voice-join', { channel: channelId });
  requestWakeLock();
  syncPeers();
  if (withVideo) toggleCam(true);
  renderVoiceBanner();
}

function leaveVoice(silent) {
  state.socket.emit('voice-leave');
  state.voice.channel = null;
  for (const peerId of [...state.voice.peers.keys()]) removePeer(peerId);
  clearInterval(state.voice.speakTimer);
  stopMeter(state.voice.selfMeter);
  state.voice.selfMeter = null;
  stopLocalMedia();
  if (state.voice.selfTile) { state.voice.selfTile.root.remove(); state.voice.selfTile = null; }
  $('tiles').classList.remove('has-expanded');
  $('voiceRoom').classList.add('hidden');
  $('voiceLobby').classList.remove('hidden');
  releaseWakeLock();
  setMediaSession(false);
  if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); }
  if (!silent) switchView('chat');
  renderVoiceBanner();
}

function stopLocalMedia() {
  if (state.voice.micStream) { state.voice.micStream.getTracks().forEach((t) => t.stop()); state.voice.micStream = null; }
  stopCam();
  stopScreen();
  updateSelfPreview();
}

// Crea/cierra conexiones según quién está en el canal.
// Regla: yo solo inicio la conexión con quienes YA estaban cuando entré;
// los que llegan después me mandan su oferta y la creo al recibirla.
// Así nunca chocan dos ofertas a la vez.
function syncPeers() {
  const members = state.voiceStates[state.voice.channel] || [];
  const ids = members.map((m) => m.id);
  const myIdx = ids.indexOf(state.me.id);
  for (const peerId of [...state.voice.peers.keys()]) {
    if (!ids.includes(peerId)) removePeer(peerId);
  }
  members.forEach((m, idx) => {
    if (m.id === state.me.id) return;
    if (myIdx !== -1 && idx < myIdx && !state.voice.peers.has(m.id)) createPeer(m);
  });
  updateTilesLayout();
}

function createPeer(member) {
  const pc = new RTCPeerConnection({ iceServers: state.config.iceServers });
  const peer = {
    id: member.id,
    pc,
    polite: String(state.me.id) < String(member.id),
    makingOffer: false,
    ignoreOffer: false,
    videoTx: null,
    audioEl: null,
    createdAt: Date.now(),
    watchdog: null,
    tile: makeTile(member)
  };
  state.voice.peers.set(member.id, peer);

  // Vigilante permanente: si la conexión no arranca en ~10s, o se cae a
  // mitad de llamada y no se recupera en ~8s, se recrea sola
  peer.lastOk = 0;
  peer.watchdog = setInterval(() => {
    const st = peer.pc.connectionState;
    if (st === 'connected') { peer.lastOk = Date.now(); return; }
    const stuckMs = Date.now() - Math.max(peer.lastOk, peer.createdAt);
    if (st === 'failed' || st === 'closed' || stuckMs > (peer.lastOk ? 8000 : 10000)) {
      const m = (state.voiceStates[state.voice.channel] || []).find((x) => x.id === peer.id);
      removePeer(peer.id);
      // reintenta el lado de ID menor; el otro la recreará al recibir la oferta
      if (m && String(state.me.id) < String(peer.id)) createPeer(m);
      updateTilesLayout();
    }
  }, 2000);

  // 3 canales fijos: micro + video (cámara/pantalla) + audio de la transmisión.
  // Se cambian con replaceTrack, sin renegociar.
  pc.addTransceiver(state.voice.micStream.getAudioTracks()[0], { direction: 'sendrecv' });
  peer.videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
  peer.streamAudioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
  const sendTrack = state.voice.screenTrack || state.voice.camTrack;
  if (sendTrack) peer.videoTx.sender.replaceTrack(sendTrack);
  if (state.voice.screenAudioTrack) peer.streamAudioTx.sender.replaceTrack(state.voice.screenAudioTrack);

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendRtc(peer, { description: pc.localDescription });
    } catch (e) { console.error(e); }
    finally { peer.makingOffer = false; }
  };
  pc.onicecandidate = ({ candidate }) => sendRtc(peer, { candidate });
  pc.ontrack = ({ track }) => {
    if (track.kind === 'audio') {
      // el primer audio es la voz; el segundo, el sonido de su transmisión
      if (!peer.audioEl) attachPeerAudio(peer, track);
      else attachStreamAudio(peer, track);
    } else {
      peer.tile.video.srcObject = new MediaStream([track]);
      const show = (on) => peer.tile.root.classList.toggle('hasvideo', on);
      track.onunmute = () => show(true);
      track.onmute = () => show(false);
      show(!track.muted);
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      removePeer(member.id);
      const still = (state.voiceStates[state.voice.channel] || []).some((m) => m.id === member.id);
      if (state.voice.channel && still) createPeer(member);
      updateTilesLayout();
    }
  };
  sendVoiceStatus();
  return peer;
}

function sendRtc(peer, payload) {
  state.socket.emit('rtc', { channel: state.voice.channel, to: peer.id, payload });
}

// Audio de cada persona. Hasta 100% suena directo del reproductor
// (los celulares lo dejan sonar aunque salgas de la app, como Discord).
// Arriba de 100% se amplifica con WebAudio, y al irte a otra app se
// cambia solo al modo seguro para que la voz nunca se corte.
function attachPeerAudio(peer, track) {
  const stream = new MediaStream([track]);
  peer.audioEl = document.createElement('audio');
  peer.audioEl.autoplay = true;
  peer.audioEl.srcObject = stream;
  $('remoteAudios').appendChild(peer.audioEl);
  applySinkTo(peer.audioEl);
  applyPeerVolume(peer);
  peer.audioEl.play().catch(() => {});
  peer.meter = makeMeter(stream); // para el recuadro verde de "está hablando"
}

// Medidor de voz: solo analiza, no reproduce (no duplica el audio)
function makeMeter(stream) {
  try {
    const c = ctx();
    const src = c.createMediaStreamSource(stream);
    const an = c.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    return { an, src, data: new Uint8Array(an.fftSize) };
  } catch (_) { return null; }
}
function meterLevel(meter) {
  if (!meter) return 0;
  meter.an.getByteTimeDomainData(meter.data);
  let max = 0;
  for (let i = 0; i < meter.data.length; i++) {
    const v = Math.abs(meter.data[i] - 128);
    if (v > max) max = v;
  }
  return max;
}
function stopMeter(meter) {
  if (!meter) return;
  try { meter.src.disconnect(); meter.an.disconnect(); } catch (_) {}
}

// Nivel de voz del otro, sacado de las estadísticas oficiales de WebRTC
async function remoteAudioLevel(peer) {
  try {
    const stats = await peer.pc.getStats();
    let lvl = 0;
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio' && typeof r.audioLevel === 'number') {
        lvl = Math.max(lvl, r.audioLevel);
      }
    });
    return lvl;
  } catch (_) { return 0; }
}

// Mi propio nivel: analizador local + estadísticas del micro (lo que sea mayor)
async function selfAudioLevel() {
  let lvl = meterLevel(state.voice.selfMeter) / 128;
  const first = [...state.voice.peers.values()][0];
  if (first) {
    try {
      const stats = await first.pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'media-source' && r.kind === 'audio' && typeof r.audioLevel === 'number') {
          lvl = Math.max(lvl, r.audioLevel);
        }
      });
    } catch (_) {}
  }
  return lvl;
}

function applyPeerVolume(peer, forceSimple) {
  if (!peer.audioEl) return;
  const v = getVolume(peer.id);
  const wantBoost = v > 1.001 && !forceSimple;
  if (!wantBoost) {
    if (peer.gain) {
      try { peer.srcNode.disconnect(); peer.gain.disconnect(); } catch (_) {}
      peer.gain = null;
      peer.srcNode = null;
    }
    peer.audioEl.muted = false;
    peer.audioEl.volume = Math.max(0, Math.min(v, 1));
    return;
  }
  try {
    const c = ctx();
    if (!peer.gain) {
      peer.srcNode = c.createMediaStreamSource(peer.audioEl.srcObject);
      peer.gain = c.createGain();
      peer.srcNode.connect(peer.gain).connect(c.destination);
    }
    peer.gain.gain.value = v;
    peer.audioEl.muted = true; // el sonido sale amplificado por WebAudio
  } catch (_) {
    peer.audioEl.muted = false;
    peer.audioEl.volume = 1;
  }
}

// Audio de la transmisión (pantalla compartida con sonido), con su propio volumen
function attachStreamAudio(peer, track) {
  const stream = new MediaStream([track]);
  peer.streamAudioEl = document.createElement('audio');
  peer.streamAudioEl.autoplay = true;
  peer.streamAudioEl.srcObject = stream;
  $('remoteAudios').appendChild(peer.streamAudioEl);
  applySinkTo(peer.streamAudioEl);
  applyStreamVolume(peer, document.hidden);
  peer.streamAudioEl.play().catch(() => {});
}

function applyStreamVolume(peer, forceSimple) {
  if (!peer.streamAudioEl) return;
  const v = getVolume('stream:' + peer.id);
  const wantBoost = v > 1.001 && !forceSimple;
  if (!wantBoost) {
    if (peer.streamGain) {
      try { peer.streamSrc.disconnect(); peer.streamGain.disconnect(); } catch (_) {}
      peer.streamGain = null;
      peer.streamSrc = null;
    }
    peer.streamAudioEl.muted = false;
    peer.streamAudioEl.volume = Math.max(0, Math.min(v, 1));
    return;
  }
  try {
    const c = ctx();
    if (!peer.streamGain) {
      peer.streamSrc = c.createMediaStreamSource(peer.streamAudioEl.srcObject);
      peer.streamGain = c.createGain();
      peer.streamSrc.connect(peer.streamGain).connect(c.destination);
    }
    peer.streamGain.gain.value = v;
    peer.streamAudioEl.muted = true;
  } catch (_) {
    peer.streamAudioEl.muted = false;
    peer.streamAudioEl.volume = 1;
  }
}

// Al salir de la app: modo seguro (el reproductor sigue sonando de fondo).
// Al volver: se restaura el volumen elegido y se despierta WebAudio.
document.addEventListener('visibilitychange', () => {
  for (const peer of state.voice.peers.values()) {
    applyPeerVolume(peer, document.hidden);
    applyStreamVolume(peer, document.hidden);
  }
  if (!document.hidden) {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    // reanuda videos que el celular pausó en segundo plano (pantalla en negro)
    document.querySelectorAll('#tiles video').forEach((v) => {
      if (v.srcObject) v.play().catch(() => {});
    });
    for (const el of document.querySelectorAll('#remoteAudios audio')) {
      el.play().catch(() => {});
    }
  }
});

async function handleRtc(peer, { description, candidate }) {
  const pc = peer.pc;
  try {
    if (description) {
      const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        sendRtc(peer, { description: pc.localDescription });
      }
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate); }
      catch (e) { if (!peer.ignoreOffer) throw e; }
    }
  } catch (e) { console.error('rtc', e); }
}

function removePeer(peerId) {
  const peer = state.voice.peers.get(peerId);
  if (!peer) return;
  if (peer.watchdog) clearInterval(peer.watchdog);
  peer.pc.onnegotiationneeded = null;
  peer.pc.onicecandidate = null;
  peer.pc.ontrack = null;
  peer.pc.close();
  try { if (peer.srcNode) peer.srcNode.disconnect(); if (peer.gain) peer.gain.disconnect(); } catch (_) {}
  try { if (peer.streamSrc) peer.streamSrc.disconnect(); if (peer.streamGain) peer.streamGain.disconnect(); } catch (_) {}
  stopMeter(peer.meter);
  if (peer.audioEl) peer.audioEl.remove();
  if (peer.streamAudioEl) peer.streamAudioEl.remove();
  if (peer.tile) {
    if (peer.tile.root.classList.contains('expanded')) $('tiles').classList.remove('has-expanded');
    peer.tile.root.remove();
  }
  state.voice.peers.delete(peerId);
  updateTilesLayout();
}

function makeTile(member, isSelf) {
  const root = document.createElement('div');
  root.className = 'tile' + (isSelf ? ' self' : '');
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isSelf || undefined;
  video.setAttribute('playsinline', '');
  if (isSelf) video.setAttribute('muted', '');
  video.setAttribute('autopictureinpicture', ''); // salta a ventanita al salir de la app (Chrome)
  // si el navegador pausa el video (pantalla en negro), lo reanuda solo
  video.addEventListener('pause', () => {
    if (!document.hidden && video.srcObject) video.play().catch(() => {});
  });
  root.appendChild(video);
  const wrap = document.createElement('div');
  wrap.className = 'tile-avatar-wrap';
  const av = document.createElement('div');
  av.className = 'avatar big-avatar';
  setAvatar(av, member);
  wrap.appendChild(av);
  root.appendChild(wrap);
  const name = document.createElement('div');
  name.className = 'tile-name';
  name.textContent = isSelf ? 'Tú' : member.name;
  root.appendChild(name);
  const mic = document.createElement('div');
  mic.className = 'tile-mic';
  mic.textContent = '🔇';
  root.appendChild(mic);

  // Botón 🔊: volumen de esa persona (0-200%)
  if (!isSelf) {
    const vol = document.createElement('button');
    vol.className = 'tile-vol';
    vol.textContent = '🔊';
    vol.title = 'Volumen de ' + member.name;
    vol.addEventListener('click', (e) => {
      e.stopPropagation();
      openVolume(member);
    });
    root.appendChild(vol);
  }

  // Tocar el cuadro: se expande a toda la sala (otro toque lo devuelve)
  root.addEventListener('click', () => {
    if (!root.classList.contains('hasvideo')) return;
    const tiles = $('tiles');
    const wasExpanded = root.classList.contains('expanded');
    tiles.querySelectorAll('.tile.expanded').forEach((t) => t.classList.remove('expanded'));
    tiles.classList.remove('has-expanded');
    if (!wasExpanded) {
      root.classList.add('expanded');
      tiles.classList.add('has-expanded');
    }
  });
  // Botón ⛶: pantalla completa de verdad (en iPhone usa el reproductor nativo)
  const fs = document.createElement('button');
  fs.className = 'tile-fs';
  fs.textContent = '⛶';
  fs.title = 'Pantalla completa';
  fs.addEventListener('click', (e) => {
    e.stopPropagation();
    if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else if (video.webkitEnterFullscreen) { try { video.webkitEnterFullscreen(); } catch (_) {} }
  });
  root.appendChild(fs);

  $('tiles').appendChild(root);
  return { root, video };
}

function updateTilesLayout() {
  const n = state.voice.peers.size + (state.voice.selfTile ? 1 : 0);
  const tiles = $('tiles');
  tiles.classList.remove('n2', 'n3', 'n4');
  if (n === 2) tiles.classList.add('n2');
  else if (n >= 3) tiles.classList.add('n4');
  $('voiceAlone').classList.toggle('hidden', state.voice.peers.size > 0 || !state.voice.channel);
}

function sendVoiceStatus() {
  if (!state.voice.channel) return;
  state.socket.emit('voice-status', {
    channel: state.voice.channel,
    status: { mic: state.voice.micOn, cam: !!state.voice.camTrack, screen: !!state.voice.screenTrack }
  });
}

/* ---- Controles ---- */

$('btnMic').addEventListener('click', () => {
  if (!state.voice.micOn && !voicePermsNow().speak) { toast('No tienes permiso para hablar aquí 🔇'); return; }
  state.voice.micOn = !state.voice.micOn;
  if (state.voice.micStream) state.voice.micStream.getAudioTracks().forEach((t) => (t.enabled = state.voice.micOn));
  $('btnMic').classList.toggle('active', state.voice.micOn);
  $('btnMic').classList.toggle('off', !state.voice.micOn);
  if (state.voice.selfTile) state.voice.selfTile.root.classList.toggle('muted', !state.voice.micOn);
  sendVoiceStatus();
});

$('btnCam').addEventListener('click', () => {
  if (!state.voice.camTrack && !voicePermsNow().video) { toast('No tienes permiso de cámara aquí 📷'); return; }
  toggleCam(!state.voice.camTrack);
});

function replaceVideoEverywhere(track) {
  for (const peer of state.voice.peers.values()) {
    if (peer.videoTx) peer.videoTx.sender.replaceTrack(track);
  }
}

async function toggleCam(on) {
  if (on) {
    stopScreen();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      state.voice.camTrack = stream.getVideoTracks()[0];
    } catch (e) {
      toast('Necesito permiso de la cámara 📹');
      return;
    }
    updateSelfPreview();
    replaceVideoEverywhere(state.voice.camTrack);
  } else {
    stopCam();
    replaceVideoEverywhere(null);
    updateSelfPreview();
  }
  $('btnCam').classList.toggle('active', !!state.voice.camTrack);
  sendVoiceStatus();
}

function stopCam() {
  if (state.voice.camTrack) { state.voice.camTrack.stop(); state.voice.camTrack = null; }
  $('btnCam').classList.remove('active');
}

$('btnScreen').addEventListener('click', async () => {
  if (state.voice.screenTrack) { stopScreenAndRestore(); return; }
  if (!voicePermsNow().video) { toast('No tienes permiso para transmitir aquí 🖥️'); return; }
  try {
    // audio: true → en PC puedes marcar "compartir audio" y se oye tu transmisión
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: screenConstraints(), audio: true });
    state.voice.screenTrack = stream.getVideoTracks()[0];
    state.voice.screenAudioTrack = stream.getAudioTracks()[0] || null;
  } catch (e) {
    return; // canceló
  }
  stopCam();
  updateSelfPreview();
  replaceVideoEverywhere(state.voice.screenTrack);
  if (state.voice.screenAudioTrack) {
    for (const peer of state.voice.peers.values()) {
      if (peer.streamAudioTx) peer.streamAudioTx.sender.replaceTrack(state.voice.screenAudioTrack);
    }
  }
  $('btnScreen').classList.add('active');
  state.voice.screenTrack.onended = () => stopScreenAndRestore();
  sendVoiceStatus();
});

function stopScreen() {
  if (state.voice.screenTrack) { state.voice.screenTrack.onended = null; state.voice.screenTrack.stop(); state.voice.screenTrack = null; }
  if (state.voice.screenAudioTrack) { state.voice.screenAudioTrack.stop(); state.voice.screenAudioTrack = null; }
  $('btnScreen').classList.remove('active');
}

function stopScreenAndRestore() {
  stopScreen();
  replaceVideoEverywhere(null);
  for (const peer of state.voice.peers.values()) {
    if (peer.streamAudioTx) peer.streamAudioTx.sender.replaceTrack(null);
  }
  updateSelfPreview();
  sendVoiceStatus();
}

// Mi cuadro en la cuadrícula muestra mi cámara o mi pantalla (o mi avatar)
function updateSelfPreview() {
  const tile = state.voice.selfTile;
  if (!tile) return;
  const track = state.voice.screenTrack || state.voice.camTrack;
  tile.root.classList.toggle('screen', !!state.voice.screenTrack);
  if (track) {
    tile.video.srcObject = new MediaStream([track]);
    tile.root.classList.add('hasvideo');
  } else {
    tile.video.srcObject = null;
    tile.root.classList.remove('hasvideo');
    if (tile.root.classList.contains('expanded')) {
      tile.root.classList.remove('expanded');
      $('tiles').classList.remove('has-expanded');
    }
  }
}

/* ---- Volumen por persona (voz y transmisión) + moderación ---- */
let volumeUserId = null;
function openVolume(member) {
  volumeUserId = member.id;
  $('volumeTitle').textContent = '🔊 ' + member.name;
  const v = Math.round(getVolume(member.id) * 100);
  $('volumeSlider').value = v;
  $('volumeValue').textContent = v + '%';
  const sv = Math.round(getVolume('stream:' + member.id) * 100);
  $('streamVolSlider').value = sv;
  $('streamVolValue').textContent = sv + '%';
  const vp = voicePermsNow();
  const canMod = vp.muteMembers || vp.disconnectMembers;
  $('volModRow').classList.toggle('hidden', !canMod);
  $('btnModMute').style.display = vp.muteMembers ? '' : 'none';
  $('btnModKick').style.display = vp.disconnectMembers ? '' : 'none';
  $('volumeOverlay').classList.remove('hidden');
}
$('volumeSlider').addEventListener('input', () => {
  const v = +$('volumeSlider').value;
  $('volumeValue').textContent = v + '%';
  if (volumeUserId) setVolume(volumeUserId, v / 100);
});
$('streamVolSlider').addEventListener('input', () => {
  const v = +$('streamVolSlider').value;
  $('streamVolValue').textContent = v + '%';
  if (volumeUserId) {
    volumes['stream:' + volumeUserId] = v / 100;
    localStorage.setItem('volumes', JSON.stringify(volumes));
    const peer = state.voice.peers.get(volumeUserId);
    if (peer) applyStreamVolume(peer, document.hidden);
  }
});
$('btnVolumeReset').addEventListener('click', () => {
  $('volumeSlider').value = 100;
  $('volumeValue').textContent = '100%';
  $('streamVolSlider').value = 100;
  $('streamVolValue').textContent = '100%';
  if (volumeUserId) {
    setVolume(volumeUserId, 1);
    volumes['stream:' + volumeUserId] = 1;
    localStorage.setItem('volumes', JSON.stringify(volumes));
    const peer = state.voice.peers.get(volumeUserId);
    if (peer) applyStreamVolume(peer, document.hidden);
  }
});
$('btnModMute').addEventListener('click', () => {
  if (volumeUserId && state.voice.channel) {
    state.socket.emit('voice-mod', { channel: state.voice.channel, userId: volumeUserId, action: 'mute' });
    toast('Silenciado 🔇');
  }
});
$('btnModKick').addEventListener('click', () => {
  if (volumeUserId && state.voice.channel) {
    state.socket.emit('voice-mod', { channel: state.voice.channel, userId: volumeUserId, action: 'kick' });
    $('volumeOverlay').classList.add('hidden');
  }
});
$('btnCloseVolume').addEventListener('click', () => $('volumeOverlay').classList.add('hidden'));
$('volumeOverlay').addEventListener('click', (e) => { if (e.target.id === 'volumeOverlay') $('volumeOverlay').classList.add('hidden'); });

/* ---- Ventana flotante (Picture in Picture): seguir viéndose usando otras apps ---- */

// elige el video: el expandido, si no el de otra persona, si no el mío
function pickPipVideo() {
  return document.querySelector('#tiles .tile.expanded.hasvideo video')
    || document.querySelector('#tiles .tile.hasvideo:not(.self) video')
    || document.querySelector('#tiles .tile.hasvideo video');
}

async function enterPip(video, silent) {
  // espera a que el video tenga imagen (si acaba de llegar)
  if (video.readyState === 0) {
    await new Promise((res) => {
      video.addEventListener('loadedmetadata', res, { once: true });
      setTimeout(res, 1500);
    });
  }
  await video.play().catch(() => {});
  if (video.requestPictureInPicture) {
    await video.requestPictureInPicture();
  } else if (video.webkitSupportsPresentationMode
    && video.webkitSupportsPresentationMode('picture-in-picture')) {
    video.webkitSetPresentationMode('picture-in-picture');
  } else {
    if (!silent) toast('Tu navegador no permite ventana flotante. Prueba el botón ⛶ del video y luego sal al inicio 📱');
    return false;
  }
  if (!silent) toast('Listo: sal a otras apps, el video queda flotando y el audio sigue 🪟');
  return true;
}

$('btnPip').addEventListener('click', async () => {
  if (document.pictureInPictureElement) {
    try { await document.exitPictureInPicture(); } catch (_) {}
    return;
  }
  const video = pickPipVideo();
  if (!video) { toast('Nadie tiene video prendido ahora mismo 📹'); return; }
  try {
    await enterPip(video, false);
  } catch (e) {
    toast('No se pudo la ventana flotante (' + (e && (e.message || e.name) || '?') + '). Prueba ⛶ y luego sal al inicio 📱', 4000);
  }
});

// Chrome moderno: permite que el video salte a ventana flotante SOLO
// cuando el usuario se va de la app (registrando este handler)
try {
  navigator.mediaSession.setActionHandler('enterpictureinpicture', async () => {
    const video = pickPipVideo();
    if (video) { try { await enterPip(video, true); } catch (_) {} }
  });
} catch (_) { /* no soportado, no pasa nada */ }

// Presenta la llamada al sistema como audio activo (ayuda a que
// el celular no corte el sonido en segundo plano)
function setMediaSession(active) {
  if (!('mediaSession' in navigator)) return;
  try {
    if (active) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'En llamada 💜',
        artist: 'Ale y Hugo'
      });
      navigator.mediaSession.playbackState = 'playing';
    } else {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
  } catch (_) {}
}

async function requestWakeLock() {
  try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}
function releaseWakeLock() {
  if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.voice.channel) requestWakeLock();
});

/* ================= Llamadas directas ================= */

$('btnAudioCall').addEventListener('click', () => startCall(false));
$('btnVideoCall').addEventListener('click', () => startCall(true));

function startCall(video) {
  const others = state.lastOnline.filter((id) => id !== state.me.id);
  if (others.length === 0) { toast('No hay nadie conectado ahora mismo'); return; }
  if (state.voice.channel) { toast('Ya estás en un canal de voz'); return; }
  state.calling = video ? 'video' : 'audio';
  const first = getUser(others[0]);
  $('outgoingName').textContent = others.length === 1 ? first.name : 'Llamando a todos…';
  setAvatar($('outgoingAvatar'), others.length === 1 ? first : state.me);
  $('outgoingCall').classList.remove('hidden');
  state.socket.emit('call-start', { video });
  startRingtone(false);
  clearTimeout(startCall._timeout);
  startCall._timeout = setTimeout(() => {
    if (state.calling) {
      state.socket.emit('call-cancel');
      state.calling = false;
      stopRingtone();
      $('outgoingCall').classList.add('hidden');
      toast('No contestaron 😔');
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
  await joinVoice(CALL_CHANNEL, call.video);
});

$('btnRejectCall').addEventListener('click', () => {
  state.incoming = null;
  stopRingtone();
  $('incomingCall').classList.add('hidden');
  state.socket.emit('call-reject');
});

/* ================= Ajustes / perfil ================= */

function renderPrefsUI() {
  $('swNoise').classList.toggle('on', prefs.noise);
  $('swEcho').classList.toggle('on', prefs.echo);
  $('swAgc').classList.toggle('on', prefs.agc);
  $('segRes').querySelectorAll('button').forEach((b) => b.classList.toggle('active', +b.dataset.v === prefs.res));
  $('segFps').querySelectorAll('button').forEach((b) => b.classList.toggle('active', +b.dataset.v === prefs.fps));
}

// Aplica los ajustes de audio al micro en vivo, sin reconectar
async function applyMicPrefs() {
  const stream = state.voice.micStream;
  if (!stream) return;
  const track = stream.getAudioTracks()[0];
  const want = micConstraints();
  try { await track.applyConstraints(want); } catch (_) {}
  const s = track.getSettings();
  if (s.noiseSuppression === want.noiseSuppression
    && s.echoCancellation === want.echoCancellation
    && s.autoGainControl === want.autoGainControl) return;
  await reacquireMic();
}

// Pide el micrófono de nuevo (con los ajustes y dispositivo elegidos)
// y lo intercambia en la llamada sin cortarla
async function reacquireMic() {
  const stream = state.voice.micStream;
  if (!stream) return;
  // apaga el viejo primero: si sigue activo, el nuevo hereda sus ajustes
  stream.getAudioTracks().forEach((t) => t.stop());
  let fresh = null;
  try {
    fresh = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
  } catch (_) {
    try { fresh = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (_) { return; }
  }
  const freshTrack = fresh.getAudioTracks()[0];
  freshTrack.enabled = state.voice.micOn;
  for (const peer of state.voice.peers.values()) {
    const sender = peer.pc.getSenders().find((x) => x.track && x.track.kind === 'audio');
    if (sender) sender.replaceTrack(freshTrack);
  }
  state.voice.micStream = fresh;
  // el medidor de "estás hablando" también cambia al micro nuevo
  stopMeter(state.voice.selfMeter);
  state.voice.selfMeter = makeMeter(fresh);
}
// Aplica resolución/fps a la pantalla compartida en vivo
async function applyScreenPrefs() {
  if (state.voice.screenTrack) {
    try { await state.voice.screenTrack.applyConstraints(screenConstraints()); } catch (_) {}
  }
}

/* ---- Elegir micrófono y salida (auriculares/altavoces) ---- */

const canPickOutput = 'setSinkId' in HTMLMediaElement.prototype;

async function populateDeviceSelects() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, savedId, defLabel) => {
      sel.innerHTML = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = defLabel;
      sel.appendChild(def);
      let i = 0;
      for (const d of devices) {
        if (d.kind !== kind || d.deviceId === 'default') continue;
        i++;
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `${kind === 'audioinput' ? 'Micrófono' : 'Salida'} ${i}`;
        sel.appendChild(opt);
      }
      sel.value = savedId && [...sel.options].some((o) => o.value === savedId) ? savedId : '';
    };
    fill($('micSelect'), 'audioinput', prefs.micId, 'Micrófono predeterminado');
    fill($('spkSelect'), 'audiooutput', prefs.spkId, 'Salida predeterminada');
  } catch (_) {}
  $('spkSelect').classList.toggle('hidden', !canPickOutput);
  $('spkHint').classList.toggle('hidden', canPickOutput);
}

$('micSelect').addEventListener('change', () => {
  prefs.micId = $('micSelect').value;
  savePrefs();
  if (state.voice.micStream) reacquireMic();
  toast('Micrófono cambiado 🎙️');
});

// Aplica la salida elegida a un reproductor (y a los futuros)
function applySinkTo(el) {
  if (canPickOutput && prefs.spkId) el.setSinkId(prefs.spkId).catch(() => {});
}
$('spkSelect').addEventListener('change', () => {
  prefs.spkId = $('spkSelect').value;
  savePrefs();
  document.querySelectorAll('#remoteAudios audio').forEach((el) => {
    if (canPickOutput) el.setSinkId(prefs.spkId || '').catch(() => {});
  });
  if (audioCtx && audioCtx.setSinkId) audioCtx.setSinkId(prefs.spkId || '').catch(() => {});
  toast('Salida de audio cambiada 🎧');
});

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (!$('settingsOverlay').classList.contains('hidden')) populateDeviceSelects();
  });
}

function bindSwitch(id, key) {
  $(id).addEventListener('click', () => {
    prefs[key] = !prefs[key];
    savePrefs();
    renderPrefsUI();
    applyMicPrefs();
  });
}
bindSwitch('swNoise', 'noise');
bindSwitch('swEcho', 'echo');
bindSwitch('swAgc', 'agc');
$('segRes').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  prefs.res = +b.dataset.v;
  savePrefs();
  renderPrefsUI();
  applyScreenPrefs();
}));
$('segFps').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  prefs.fps = +b.dataset.v;
  savePrefs();
  renderPrefsUI();
  applyScreenPrefs();
}));

$('btnSettings').addEventListener('click', () => {
  $('settingsName').value = state.me.name;
  setAvatar($('myAvatar'), state.me);
  renderPrefsUI();
  populateDeviceSelects();
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
    localStorage.setItem('avatarCache', dataUrl);
    const { me } = await api('/api/profile', { body: { avatarDataUrl: dataUrl } });
    state.me = me;
    state.users.set(me.id, me);
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
    state.users.set(me.id, me);
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
window.state = state; // útil para depurar
boot();
