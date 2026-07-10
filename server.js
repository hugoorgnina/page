const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const MAX_USERS = parseInt(process.env.MAX_USERS || '12', 10);
const INVITE_CODE = process.env.INVITE_CODE || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const MAX_MESSAGES_PER_CHANNEL = 300;
const CALL_CHANNEL = 'llamada'; // canal de voz especial para las llamadas directas

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- Base de datos (archivo JSON) ----------
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: [], tokens: {}, servers: [], messages: {} };
try {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch (_) { /* primera vez */ }

// Migración desde la versión anterior (un solo chat global)
if (Array.isArray(db.messages)) {
  const old = db.messages;
  db.messages = {};
  if (!Array.isArray(db.servers)) db.servers = [];
  if (old.length && db.users.length) {
    const ch = { id: newId(), name: 'general', type: 'text' };
    db.servers.push({
      id: newId(), name: 'Ale y Hugo 💜', icon: null, ownerId: db.users[0].id,
      passHash: null, members: db.users.map((u) => u.id),
      channels: [ch, { id: newId(), name: 'Sala de voz', type: 'voice' }]
    });
    db.messages[ch.id] = old.map((m) => ({ ...m, channel: ch.id }));
  }
}
if (!Array.isArray(db.servers)) db.servers = [];
if (typeof db.messages !== 'object' || db.messages === null) db.messages = {};

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(db), (err) => {
      if (err) console.error('Error guardando db:', err);
    });
  }, 300);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function newId() { return crypto.randomBytes(8).toString('hex'); }
const newToken = () => crypto.randomBytes(24).toString('hex');

function publicUser(u) {
  return { id: u.id, name: u.name, avatar: u.avatar || null };
}
function findUserByToken(token) {
  const userId = db.tokens[token];
  if (!userId) return null;
  return db.users.find((u) => u.id === userId) || null;
}
function findServer(id) {
  return db.servers.find((s) => s.id === id) || null;
}
// Busca a qué server pertenece un canal
function findChannel(channelId) {
  for (const s of db.servers) {
    const ch = s.channels.find((c) => c.id === channelId);
    if (ch) return { server: s, channel: ch };
  }
  return null;
}
function serverSummary(s, userId) {
  return {
    id: s.id, name: s.name, icon: s.icon,
    memberCount: s.members.length,
    hasPassword: !!s.passHash,
    isMember: s.members.includes(userId)
  };
}
function serverFull(s) {
  return {
    id: s.id, name: s.name, icon: s.icon, ownerId: s.ownerId,
    hasPassword: !!s.passHash, members: s.members, channels: s.channels
  };
}

// ---------- Guardar imágenes (dataURL) ----------
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
function saveDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 12 * 1024 * 1024) return null;
  const file = `${Date.now()}-${newId()}.${MIME_EXT[m[1]]}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, file), buf);
  return `/uploads/${file}`;
}

// ---------- Servidor HTTP ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json({ limit: '16mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // el HTML nunca se cachea: así las actualizaciones llegan al instante
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '30d' }));

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = findUserByToken(token);
  if (!user) return res.status(401).json({ error: 'sesion_invalida' });
  req.user = user;
  next();
}

const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turns:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];
let iceServers = DEFAULT_ICE;
if (process.env.ICE_SERVERS) {
  try { iceServers = JSON.parse(process.env.ICE_SERVERS); } catch (_) { /* default */ }
}

app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || null,
    inviteRequired: !!INVITE_CODE,
    iceServers
  });
});

// ---------- Cuentas ----------
app.post('/api/auth', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  const password = String(req.body.password || '');
  const mode = req.body.mode;
  if (!name || password.length < 4) {
    return res.status(400).json({ error: 'datos_invalidos', message: 'Pon un nombre y una contraseña de al menos 4 letras.' });
  }
  let user = db.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
  if (user) {
    if (mode === 'register') {
      return res.status(409).json({ error: 'ya_existe', message: 'Ese nombre ya tiene cuenta. Usa "Iniciar sesión".' });
    }
    if (user.passHash !== sha256(password)) {
      return res.status(401).json({ error: 'pass_incorrecta', message: 'La contraseña no es correcta.' });
    }
  } else {
    if (mode === 'login') {
      return res.status(404).json({ error: 'no_existe', message: 'No hay ninguna cuenta con ese nombre. Usa "Registrarse".' });
    }
    if (db.users.length >= MAX_USERS) {
      return res.status(403).json({ error: 'lleno', message: 'Ya no hay lugares para más cuentas.' });
    }
    if (INVITE_CODE && String(req.body.invite || '') !== INVITE_CODE) {
      return res.status(403).json({ error: 'invite', message: 'Código de invitación incorrecto.' });
    }
    user = { id: newId(), name, passHash: sha256(password), avatar: null };
    db.users.push(user);
    io.emit('users-updated');
  }
  const token = newToken();
  db.tokens[token] = user.id;
  save();
  res.json({ token, me: publicUser(user) });
});

app.post('/api/google', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(400).json({ error: 'no_configurado' });
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(req.body.credential || ''));
    if (!r.ok) throw new Error('token invalido');
    const info = await r.json();
    if (info.aud !== GOOGLE_CLIENT_ID) throw new Error('aud incorrecto');
    let user = db.users.find((u) => u.googleId === info.sub);
    if (!user) {
      if (db.users.length >= MAX_USERS) {
        return res.status(403).json({ error: 'lleno', message: 'Ya no hay lugares para más cuentas.' });
      }
      user = {
        id: newId(),
        name: (info.name || info.email || 'Yo').slice(0, 30),
        passHash: sha256(newToken()),
        avatar: info.picture || null,
        googleId: info.sub
      };
      db.users.push(user);
      io.emit('users-updated');
    }
    const token = newToken();
    db.tokens[token] = user.id;
    save();
    res.json({ token, me: publicUser(user) });
  } catch (e) {
    res.status(401).json({ error: 'google_fallo', message: 'No se pudo validar con Google.' });
  }
});

app.get('/api/me', auth, (req, res) => {
  res.json({ me: publicUser(req.user) });
});

app.get('/api/users', auth, (req, res) => {
  res.json({ users: db.users.map(publicUser) });
});

app.post('/api/profile', auth, (req, res) => {
  if (req.body.name) req.user.name = String(req.body.name).trim().slice(0, 30) || req.user.name;
  if (req.body.avatarDataUrl) {
    const url = saveDataUrl(req.body.avatarDataUrl);
    if (url) req.user.avatar = url;
  }
  save();
  io.emit('users-updated');
  res.json({ me: publicUser(req.user) });
});

app.post('/api/logout', auth, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  delete db.tokens[token];
  save();
  res.json({ ok: true });
});

// ---------- Servers (como los de Discord) ----------
function socketsOf(userId) {
  const set = onlineSockets.get(userId);
  return set ? [...set] : [];
}
function joinSocketsToRoom(userId, room) {
  for (const s of socketsOf(userId)) s.join(room);
}
function leaveSocketsFromRoom(userId, room) {
  for (const s of socketsOf(userId)) s.leave(room);
}

// Buscador: lista todos los servers (con ?q= filtra por nombre)
app.get('/api/servers', auth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = db.servers;
  if (q) list = list.filter((s) => s.name.toLowerCase().includes(q));
  list = [...list].sort((a, b) => b.members.length - a.members.length);
  res.json({ servers: list.map((s) => serverSummary(s, req.user.id)) });
});

// Mis servers, con canales completos
app.get('/api/servers/mine', auth, (req, res) => {
  const mine = db.servers.filter((s) => s.members.includes(req.user.id));
  res.json({ servers: mine.map(serverFull) });
});

app.post('/api/servers', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'nombre', message: 'Ponle un nombre al server.' });
  if (db.servers.length >= 50) return res.status(403).json({ error: 'limite', message: 'Ya hay demasiados servers.' });
  const password = String(req.body.password || '');
  const s = {
    id: newId(), name, icon: null, ownerId: req.user.id,
    passHash: password ? sha256(password) : null,
    members: [req.user.id],
    channels: [
      { id: newId(), name: 'general', type: 'text' },
      { id: newId(), name: 'General', type: 'voice' }
    ]
  };
  if (req.body.iconDataUrl) s.icon = saveDataUrl(req.body.iconDataUrl);
  db.servers.push(s);
  save();
  joinSocketsToRoom(req.user.id, 'server:' + s.id);
  io.emit('server-list-updated');
  res.json({ server: serverFull(s) });
});

app.post('/api/servers/:id/join', auth, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_existe', message: 'Ese server ya no existe.' });
  if (s.members.includes(req.user.id)) return res.json({ server: serverFull(s) });
  if (s.passHash && s.passHash !== sha256(String(req.body.password || ''))) {
    return res.status(403).json({ error: 'password', message: 'Contraseña del server incorrecta.' });
  }
  s.members.push(req.user.id);
  save();
  joinSocketsToRoom(req.user.id, 'server:' + s.id);
  io.emit('server-list-updated');
  io.to('server:' + s.id).emit('server-changed', { serverId: s.id });
  res.json({ server: serverFull(s) });
});

app.post('/api/servers/:id/leave', auth, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_existe' });
  s.members = s.members.filter((id) => id !== req.user.id);
  // si estaba en un canal de voz de este server, sácalo
  for (const ch of s.channels) {
    if (ch.type === 'voice') removeFromVoice(req.user.id, ch.id);
  }
  leaveSocketsFromRoom(req.user.id, 'server:' + s.id);
  if (s.members.length === 0) {
    db.servers = db.servers.filter((x) => x.id !== s.id);
    for (const ch of s.channels) delete db.messages[ch.id];
  } else if (s.ownerId === req.user.id) {
    s.ownerId = s.members[0]; // el server pasa al miembro más antiguo
  }
  save();
  io.emit('server-list-updated');
  io.to('server:' + s.id).emit('server-changed', { serverId: s.id });
  res.json({ ok: true });
});

app.post('/api/servers/:id/channels', auth, (req, res) => {
  const s = findServer(req.params.id);
  if (!s) return res.status(404).json({ error: 'no_existe' });
  if (s.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'no_dueno', message: 'Solo el dueño del server puede crear canales.' });
  }
  if (s.channels.length >= 20) return res.status(403).json({ error: 'limite', message: 'Máximo 20 canales por server.' });
  const name = String(req.body.name || '').trim().slice(0, 30).replace(/\s+/g, '-').toLowerCase();
  const type = req.body.type === 'voice' ? 'voice' : 'text';
  if (!name) return res.status(400).json({ error: 'nombre', message: 'Ponle un nombre al canal.' });
  const ch = { id: newId(), name, type };
  s.channels.push(ch);
  save();
  io.to('server:' + s.id).emit('server-changed', { serverId: s.id });
  res.json({ channel: ch });
});

app.get('/api/channels/:id/messages', auth, (req, res) => {
  const found = findChannel(req.params.id);
  if (!found || !found.server.members.includes(req.user.id)) {
    return res.status(403).json({ error: 'sin_acceso' });
  }
  res.json({ messages: db.messages[req.params.id] || [] });
});

app.post('/api/upload', auth, (req, res) => {
  const url = saveDataUrl(req.body.dataUrl);
  if (!url) return res.status(400).json({ error: 'imagen_invalida' });
  res.json({ url });
});

// ---------- Tiempo real ----------
const onlineSockets = new Map(); // userId -> Set<socket>
const voice = new Map(); // channelId -> Map<userId, socketId>

function presenceList() {
  return [...onlineSockets.keys()];
}
function voiceMembersOf(channelId) {
  const room = voice.get(channelId);
  if (!room) return [];
  return [...room.keys()].map((id) => {
    const u = db.users.find((x) => x.id === id);
    return u ? publicUser(u) : { id, name: '?', avatar: null };
  });
}
// A quién avisar de los cambios de un canal de voz
function emitVoiceState(channelId) {
  const payload = { channel: channelId, members: voiceMembersOf(channelId) };
  if (channelId === CALL_CHANNEL) {
    io.emit('voice-state', payload);
  } else {
    const found = findChannel(channelId);
    if (found) io.to('server:' + found.server.id).emit('voice-state', payload);
  }
}
function removeFromVoice(userId, channelId, socketId) {
  const room = voice.get(channelId);
  if (!room || !room.has(userId)) return false;
  if (socketId && room.get(userId) !== socketId) return false;
  room.delete(userId);
  if (room.size === 0) voice.delete(channelId);
  emitVoiceState(channelId);
  return true;
}
function leaveAllVoice(userId, socketId) {
  for (const channelId of [...voice.keys()]) {
    removeFromVoice(userId, channelId, socketId);
  }
}
// ¿Puede este usuario usar este canal de voz?
function canUseVoice(user, channelId) {
  if (channelId === CALL_CHANNEL) return true;
  const found = findChannel(channelId);
  return !!(found && found.channel.type === 'voice' && found.server.members.includes(user.id));
}

io.use((socket, next) => {
  const user = findUserByToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error('no autorizado'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  if (!onlineSockets.has(user.id)) onlineSockets.set(user.id, new Set());
  onlineSockets.get(user.id).add(socket);
  for (const s of db.servers) {
    if (s.members.includes(user.id)) socket.join('server:' + s.id);
  }
  io.emit('presence', { online: presenceList() });
  // foto actual de todos los canales de voz que le tocan
  const snapshot = [];
  for (const channelId of voice.keys()) {
    if (canUseVoice(user, channelId) || channelId === CALL_CHANNEL) {
      snapshot.push({ channel: channelId, members: voiceMembersOf(channelId) });
    }
  }
  socket.emit('voice-snapshot', { states: snapshot });

  // ----- Chat por canal -----
  socket.on('chat', (data) => {
    const channelId = String((data && data.channel) || '');
    const found = findChannel(channelId);
    if (!found || found.channel.type !== 'text' || !found.server.members.includes(user.id)) return;
    const type = data.type === 'image' ? 'image' : 'text';
    const msg = { id: newId(), channel: channelId, from: user.id, type, ts: Date.now() };
    if (type === 'text') {
      msg.text = String(data.text || '').slice(0, 4000);
      if (!msg.text.trim()) return;
    } else {
      msg.url = String(data.url || '');
      if (!msg.url.startsWith('/uploads/')) return;
    }
    if (!db.messages[channelId]) db.messages[channelId] = [];
    db.messages[channelId].push(msg);
    if (db.messages[channelId].length > MAX_MESSAGES_PER_CHANNEL) {
      db.messages[channelId] = db.messages[channelId].slice(-MAX_MESSAGES_PER_CHANNEL);
    }
    save();
    io.to('server:' + found.server.id).emit('chat', msg);
  });

  socket.on('typing', (data) => {
    const channelId = String((data && data.channel) || '');
    const found = findChannel(channelId);
    if (!found || !found.server.members.includes(user.id)) return;
    socket.to('server:' + found.server.id).emit('typing', { userId: user.id, channel: channelId });
  });

  // ----- Voz (grupal, por canal) -----
  socket.on('voice-join', (data) => {
    const channelId = String((data && data.channel) || '');
    if (!canUseVoice(user, channelId)) return;
    leaveAllVoice(user.id); // solo se puede estar en un canal de voz a la vez
    if (!voice.has(channelId)) voice.set(channelId, new Map());
    voice.get(channelId).set(user.id, socket.id);
    emitVoiceState(channelId);
  });

  socket.on('voice-leave', () => {
    leaveAllVoice(user.id, socket.id);
  });

  // Señalización dirigida: cada par de personas negocia su propia conexión
  socket.on('rtc', (data) => {
    const channelId = String((data && data.channel) || '');
    const to = String((data && data.to) || '');
    const room = voice.get(channelId);
    if (!room || room.get(user.id) !== socket.id || !room.has(to)) return;
    const target = io.sockets.sockets.get(room.get(to));
    if (target) target.emit('rtc', { channel: channelId, from: user.id, payload: data.payload });
  });

  socket.on('voice-status', (data) => {
    const channelId = String((data && data.channel) || '');
    const room = voice.get(channelId);
    if (!room || room.get(user.id) !== socket.id) return;
    for (const [uid, sid] of room) {
      if (uid === user.id) continue;
      const target = io.sockets.sockets.get(sid);
      if (target) target.emit('voice-status', { channel: channelId, userId: user.id, status: data.status });
    }
  });

  // ----- Llamadas directas (timbran a todos los conectados) -----
  socket.on('call-start', (data) => {
    const video = !!(data && data.video);
    for (const [uid, set] of onlineSockets) {
      if (uid === user.id) continue;
      for (const s of set) s.emit('call-incoming', { from: publicUser(user), video });
    }
  });
  socket.on('call-accept', () => {
    for (const [uid, set] of onlineSockets) {
      for (const s of set) {
        if (s === socket) continue;
        if (uid === user.id) s.emit('call-handled');
        else s.emit('call-accepted', { by: publicUser(user) });
      }
    }
  });
  socket.on('call-reject', () => {
    for (const [uid, set] of onlineSockets) {
      for (const s of set) {
        if (s === socket) continue;
        if (uid === user.id) s.emit('call-handled');
        else s.emit('call-rejected', { by: publicUser(user) });
      }
    }
  });
  socket.on('call-cancel', () => {
    for (const [uid, set] of onlineSockets) {
      if (uid === user.id) continue;
      for (const s of set) s.emit('call-cancelled');
    }
  });

  socket.on('disconnect', () => {
    const set = onlineSockets.get(user.id);
    if (set) {
      set.delete(socket);
      if (set.size === 0) onlineSockets.delete(user.id);
    }
    leaveAllVoice(user.id, socket.id);
    io.emit('presence', { online: presenceList() });
  });
});

server.listen(PORT, () => {
  console.log(`Ale y Hugo corriendo en http://localhost:${PORT}`);
});
