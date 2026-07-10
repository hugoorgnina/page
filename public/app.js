/* ============================================================
   Ale y Hugo — cliente
   Servers estilo Discord (canales de texto y de voz grupales),
   buscador de servers, llamadas directas, fotos y perfil.
   ============================================================ */

const $ = (id) => document.getElementById(id);
const CALL_CHANNEL = 'llamada';

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

function pickInitialChannel() {
  const saved = localStorage.getItem('lastChannel');
  if (saved && findMyChannel(saved)) {
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
  const found = findMyChannel(channelId);
  if (!found) return;
  state.currentChannelId = channelId;
  state.currentServerId = found.server.id;
  state.openServerId = found.server.id;
  localStorage.setItem('lastChannel', channelId);
  if (load) {
    loadMessages(channelId);
    renderAll();
  }
}

function renderAll() {
  renderTopbar();
  renderChatEmptyState();
  renderMyServers();
  renderVoiceLobby();
  renderVoiceBanner();
}

function renderTopbar() {
  const found = state.currentChannelId ? findMyChannel(state.currentChannelId) : null;
  if (found) {
    $('topbarTitle').textContent = '# ' + found.channel.name;
    $('topbarSub').textContent = found.server.name;
    setAvatar($('topbarIcon'), { id: found.server.id, name: found.server.name, avatar: found.server.icon });
  } else {
    $('topbarTitle').textContent = 'Ale y Hugo';
    $('topbarSub').textContent = '';
    $('topbarIcon').innerHTML = '';
    $('topbarIcon').textContent = '💜';
  }
}

function renderChatEmptyState() {
  const empty = !state.currentChannelId;
  $('noChannel').classList.toggle('hidden', !empty);
  $('messages').classList.toggle('hidden', empty);
  $('inputBar').classList.toggle('hidden', empty);
}

function setPeerStatusOnline() {
  // pequeño indicador: cuántos están en línea (además de mí)
  const others = state.lastOnline.filter((id) => id !== state.me.id).length;
  const sub = $('topbarSub');
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

  s.on('presence', ({ online }) => {
    state.lastOnline = online;
    setPeerStatusOnline();
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
    if (!$('searchResults').classList.contains('hidden')) doSearch();
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
    t.textContent = `${getUser(userId).name} está escribiendo…`;
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
    // si me llega una oferta nueva y mi conexión con él lleva rato trabada,
    // la tiro y empiezo de cero con esta oferta
    if (peer && payload.description && payload.description.type === 'offer'
        && (peer.pc.connectionState === 'new' || peer.pc.connectionState === 'failed')
        && Date.now() - peer.createdAt > 8000) {
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

/* ================= Chat ================= */

let lastDay = null;

async function loadMessages(channelId) {
  try {
    const { messages } = await api('/api/channels/' + channelId + '/messages');
    $('messages').innerHTML = '';
    lastDay = null;
    messages.forEach(appendMessage);
    scrollMessages(true);
  } catch (_) {
    $('messages').innerHTML = '';
  }
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
  const author = mine ? state.me : getUser(msg.from);
  const row = document.createElement('div');
  row.className = 'msg' + (mine ? ' mine' : '');

  const av = document.createElement('div');
  av.className = 'avatar';
  setAvatar(av, author);
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
  time.textContent = (mine ? '' : author.name + ' · ') + fmtTime(msg.ts);
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
  if (now - typingThrottle > 1500 && state.currentChannelId) {
    typingThrottle = now;
    state.socket && state.socket.emit('typing', { channel: state.currentChannelId });
  }
});

function sendText() {
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text || !state.currentChannelId) return;
  state.socket.emit('chat', { channel: state.currentChannelId, type: 'text', text });
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
  title.querySelector('.s-meta').textContent = `${srv.members.length} miembro${srv.members.length === 1 ? '' : 's'}${srv.ownerId === state.me.id ? ' · tuyo' : ''}`;
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
  if (srv.ownerId === state.me.id) {
    const add = document.createElement('button');
    add.className = 'channel-item add';
    add.textContent = '＋ Crear canal';
    add.addEventListener('click', () => openCreateChannel(srv.id));
    body.appendChild(add);
  }
  const actions = document.createElement('div');
  actions.className = 'server-actions';
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

/* ---- Buscador de servers ---- */

let searchTimer = null;
$('serverSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 300);
});

async function doSearch() {
  const q = $('serverSearch').value.trim();
  const box = $('searchResults');
  if (!q) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  try {
    const { servers } = await api('/api/servers?q=' + encodeURIComponent(q));
    box.innerHTML = '';
    box.classList.remove('hidden');
    if (servers.length === 0) {
      const p = document.createElement('p');
      p.className = 'voice-room-desc';
      p.style.padding = '8px';
      p.textContent = `No hay ningún server que se llame "${q}". ¡Créalo tú!`;
      box.appendChild(p);
      return;
    }
    for (const srv of servers) {
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
        btn.style.background = 'var(--bg3)';
      } else {
        btn.textContent = 'Unirme';
        btn.addEventListener('click', () => joinServer(srv));
      }
      head.appendChild(btn);
      card.appendChild(head);
      box.appendChild(card);
    }
  } catch (_) {}
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
    $('searchResults').classList.add('hidden');
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

async function joinVoice(channelId, withVideo) {
  if (state.voice.channel === channelId) { switchView('voice'); return; }
  if (state.voice.channel) leaveVoice(true);
  try {
    state.voice.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    toast('Necesito permiso del micrófono 🎙️');
    return;
  }
  state.voice.channel = channelId;
  state.voice.micOn = true;
  $('btnMic').classList.add('active');
  $('btnMic').classList.remove('off');
  switchView('voice');
  $('voiceLobby').classList.add('hidden');
  $('voiceRoom').classList.remove('hidden');
  setAvatar($('aloneAvatar'), state.me);
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
  stopLocalMedia();
  $('voiceRoom').classList.add('hidden');
  $('voiceLobby').classList.remove('hidden');
  releaseWakeLock();
  if (!silent) switchView('chat');
  renderVoiceBanner();
}

function stopLocalMedia() {
  if (state.voice.micStream) { state.voice.micStream.getTracks().forEach((t) => t.stop()); state.voice.micStream = null; }
  stopCam();
  stopScreen();
  $('localPip').classList.remove('visible');
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

  // Vigilante: si en ~9s la conexión no arrancó, se recrea sola
  peer.watchdog = setInterval(() => {
    const st = peer.pc.connectionState;
    if (st === 'connected') { clearInterval(peer.watchdog); peer.watchdog = null; return; }
    if ((st === 'new' || st === 'failed') && Date.now() - peer.createdAt > 9000) {
      const m = (state.voiceStates[state.voice.channel] || []).find((x) => x.id === peer.id);
      removePeer(peer.id);
      // reintenta el lado de ID menor; el otro la recreará al recibir la oferta
      if (m && String(state.me.id) < String(peer.id)) createPeer(m);
      updateTilesLayout();
    }
  }, 3000);

  // audio (mi micro) + video (cámara o pantalla, se cambia sin renegociar)
  pc.addTransceiver(state.voice.micStream.getAudioTracks()[0], { direction: 'sendrecv' });
  peer.videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
  const sendTrack = state.voice.screenTrack || state.voice.camTrack;
  if (sendTrack) peer.videoTx.sender.replaceTrack(sendTrack);

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
      peer.audioEl = document.createElement('audio');
      peer.audioEl.autoplay = true;
      peer.audioEl.srcObject = new MediaStream([track]);
      $('remoteAudios').appendChild(peer.audioEl);
      peer.audioEl.play().catch(() => {});
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
  if (peer.audioEl) peer.audioEl.remove();
  if (peer.tile) peer.tile.root.remove();
  state.voice.peers.delete(peerId);
  updateTilesLayout();
}

function makeTile(member) {
  const root = document.createElement('div');
  root.className = 'tile';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
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
  name.textContent = member.name;
  root.appendChild(name);
  const mic = document.createElement('div');
  mic.className = 'tile-mic';
  mic.textContent = '🔇';
  root.appendChild(mic);
  $('tiles').appendChild(root);
  return { root, video };
}

function updateTilesLayout() {
  const n = state.voice.peers.size;
  const tiles = $('tiles');
  tiles.classList.remove('n2', 'n3', 'n4');
  if (n === 2) tiles.classList.add('n2');
  else if (n >= 3) tiles.classList.add('n4');
  $('voiceAlone').classList.toggle('hidden', n > 0);
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
  state.voice.micOn = !state.voice.micOn;
  if (state.voice.micStream) state.voice.micStream.getAudioTracks().forEach((t) => (t.enabled = state.voice.micOn));
  $('btnMic').classList.toggle('active', state.voice.micOn);
  $('btnMic').classList.toggle('off', !state.voice.micOn);
  sendVoiceStatus();
});

$('btnCam').addEventListener('click', () => toggleCam(!state.voice.camTrack));

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
    showLocalPreview(state.voice.camTrack, false);
    replaceVideoEverywhere(state.voice.camTrack);
  } else {
    stopCam();
    replaceVideoEverywhere(null);
  }
  $('btnCam').classList.toggle('active', !!state.voice.camTrack);
  sendVoiceStatus();
}

function stopCam() {
  if (state.voice.camTrack) { state.voice.camTrack.stop(); state.voice.camTrack = null; }
  if (!state.voice.screenTrack) $('localPip').classList.remove('visible');
  $('btnCam').classList.remove('active');
}

$('btnScreen').addEventListener('click', async () => {
  if (state.voice.screenTrack) { stopScreenAndRestore(); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    state.voice.screenTrack = stream.getVideoTracks()[0];
  } catch (e) {
    return; // canceló
  }
  stopCam();
  showLocalPreview(state.voice.screenTrack, true);
  replaceVideoEverywhere(state.voice.screenTrack);
  $('btnScreen').classList.add('active');
  state.voice.screenTrack.onended = () => stopScreenAndRestore();
  sendVoiceStatus();
});

function stopScreen() {
  if (state.voice.screenTrack) { state.voice.screenTrack.onended = null; state.voice.screenTrack.stop(); state.voice.screenTrack = null; }
  $('btnScreen').classList.remove('active');
}

function stopScreenAndRestore() {
  stopScreen();
  replaceVideoEverywhere(null);
  $('localPip').classList.remove('visible');
  sendVoiceStatus();
}

function showLocalPreview(track, isScreen) {
  const v = $('localVideo');
  v.srcObject = new MediaStream([track]);
  v.classList.toggle('screen', isScreen);
  $('localPip').classList.add('visible');
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
