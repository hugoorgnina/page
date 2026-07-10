const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const MAX_USERS = parseInt(process.env.MAX_USERS || '2', 10);
const INVITE_CODE = process.env.INVITE_CODE || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const MAX_MESSAGES = 500;

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- Base de datos (archivo JSON, suficiente para 2 personas) ----------
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: [], tokens: {}, messages: [] };
try {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch (_) { /* primera vez, no existe */ }

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
const newId = () => crypto.randomBytes(8).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');

function publicUser(u) {
  return { id: u.id, name: u.name, avatar: u.avatar || null };
}

function findUserByToken(token) {
  const userId = db.tokens[token];
  if (!userId) return null;
  return db.users.find((u) => u.id === userId) || null;
}

// ---------- Guardar imágenes que llegan como dataURL ----------
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
app.use(express.static(path.join(__dirname, 'public')));
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
  try { iceServers = JSON.parse(process.env.ICE_SERVERS); } catch (_) { /* usa los default */ }
}

app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || null,
    inviteRequired: !!INVITE_CODE,
    iceServers
  });
});

// Entrar: si el nombre no existe crea la cuenta, si existe valida la contraseña.
app.post('/api/auth', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  const password = String(req.body.password || '');
  if (!name || password.length < 4) {
    return res.status(400).json({ error: 'datos_invalidos', message: 'Pon un nombre y una contraseña de al menos 4 letras.' });
  }
  let user = db.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
  if (user) {
    if (user.passHash !== sha256(password)) {
      return res.status(401).json({ error: 'pass_incorrecta', message: 'La contraseña no es correcta.' });
    }
  } else {
    if (db.users.length >= MAX_USERS) {
      return res.status(403).json({ error: 'lleno', message: 'Este chat es privado, ya no hay lugares.' });
    }
    if (INVITE_CODE && String(req.body.invite || '') !== INVITE_CODE) {
      return res.status(403).json({ error: 'invite', message: 'Código de invitación incorrecto.' });
    }
    user = { id: newId(), name, passHash: sha256(password), avatar: null };
    db.users.push(user);
    io.emit('users-updated'); // avisa al otro que ya existes
  }
  const token = newToken();
  db.tokens[token] = user.id;
  save();
  res.json({ token, me: publicUser(user) });
});

// Login con Google (opcional). Verifica el id_token contra Google.
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
        return res.status(403).json({ error: 'lleno', message: 'Este chat es privado, ya no hay lugares.' });
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
  res.json({
    me: publicUser(req.user),
    others: db.users.filter((u) => u.id !== req.user.id).map(publicUser)
  });
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

app.get('/api/messages', auth, (req, res) => {
  res.json({ messages: db.messages });
});

app.post('/api/upload', auth, (req, res) => {
  const url = saveDataUrl(req.body.dataUrl);
  if (!url) return res.status(400).json({ error: 'imagen_invalida' });
  res.json({ url });
});

app.post('/api/logout', auth, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  delete db.tokens[token];
  save();
  res.json({ ok: true });
});

// ---------- Tiempo real: chat, presencia, sala de voz, llamadas ----------
const onlineSockets = new Map(); // userId -> Set<socket>
const voiceMembers = new Map(); // userId -> { socketId }

function presenceList() {
  return [...onlineSockets.keys()];
}
function voiceStateList() {
  return [...voiceMembers.keys()].map((id) => {
    const u = db.users.find((x) => x.id === id);
    return u ? publicUser(u) : { id, name: '?', avatar: null };
  });
}
function emitVoiceState() {
  io.emit('voice-state', { members: voiceStateList() });
}
function socketsOf(userId) {
  return onlineSockets.get(userId) || new Set();
}
function otherVoiceSocket(myUserId) {
  for (const [uid, info] of voiceMembers) {
    if (uid !== myUserId) {
      const s = io.sockets.sockets.get(info.socketId);
      if (s) return s;
    }
  }
  return null;
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
  io.emit('presence', { online: presenceList() });
  socket.emit('voice-state', { members: voiceStateList() });

  // ----- Chat -----
  socket.on('chat', (data, ack) => {
    const type = data && data.type === 'image' ? 'image' : 'text';
    const msg = { id: newId(), from: user.id, type, ts: Date.now() };
    if (type === 'text') {
      msg.text = String((data && data.text) || '').slice(0, 4000);
      if (!msg.text.trim()) return;
    } else {
      msg.url = String((data && data.url) || '');
      if (!msg.url.startsWith('/uploads/')) return;
    }
    db.messages.push(msg);
    if (db.messages.length > MAX_MESSAGES) db.messages = db.messages.slice(-MAX_MESSAGES);
    save();
    io.emit('chat', msg);
    if (ack) ack({ ok: true });
  });

  socket.on('typing', () => {
    socket.broadcast.emit('typing', { userId: user.id });
  });

  // ----- Sala de voz: entrar / salir / volver a entrar -----
  socket.on('voice-join', () => {
    voiceMembers.set(user.id, { socketId: socket.id });
    emitVoiceState();
  });

  socket.on('voice-leave', () => {
    const info = voiceMembers.get(user.id);
    if (info && info.socketId === socket.id) {
      voiceMembers.delete(user.id);
      emitVoiceState();
      const other = otherVoiceSocket(user.id);
      if (other) other.emit('voice-peer-left', { userId: user.id });
    }
  });

  // Señalización WebRTC entre los dos miembros de la sala
  socket.on('rtc', (payload) => {
    const me = voiceMembers.get(user.id);
    if (!me || me.socketId !== socket.id) return;
    const other = otherVoiceSocket(user.id);
    if (other) other.emit('rtc', { from: user.id, payload });
  });

  // Estado de micrófono / cámara / pantalla del compañero
  socket.on('voice-status', (status) => {
    const other = otherVoiceSocket(user.id);
    if (other) other.emit('voice-status', { userId: user.id, status });
  });

  // ----- Llamadas estilo WhatsApp (timbran al otro) -----
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
        if (uid === user.id) s.emit('call-handled'); // otro dispositivo mío deja de sonar
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
    const info = voiceMembers.get(user.id);
    if (info && info.socketId === socket.id) {
      voiceMembers.delete(user.id);
      emitVoiceState();
      const other = otherVoiceSocket(user.id);
      if (other) other.emit('voice-peer-left', { userId: user.id });
    }
    io.emit('presence', { online: presenceList() });
  });
});

server.listen(PORT, () => {
  console.log(`Ale y Hugo corriendo en http://localhost:${PORT}`);
});
