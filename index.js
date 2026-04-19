// ============================================================
// Cineminha — Servidor WebSocket v26.4.1
// 🆕 v26.2.0.0: Relay de sinalização WebRTC para screen sharing
// (host → guests em mesh P2P). Servidor NÃO trafega mídia.
// ============================================================
'use strict';

const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const MAX_CONNECTIONS_PER_IP = 10;
const MSG_RATE_REFILL_PER_SEC = 30;
const MSG_RATE_BURST = 50;
// 🆕 v26.1.1.0 — Grace do host aumentado de 15s → 90s.
// Motivo: SW MV3 do Chrome pode dormir e levar tempo pra reconectar.
// Com 90s, host pode ausentar 1min30s sem perder a sala.
const HOST_ORPHAN_GRACE_MS = 90_000;
// 🆕 v26.1.1.0 — Debounce de mudança de plataforma (evita ping-pong)
const PLATFORM_CHANGE_DEBOUNCE_MS = 5_000;
const MIGRATION_WINDOW_MS = 20_000;

const rooms = new Map();
const ipConnections = new Map();

function generateRoomId() {
  for (let i = 0; i < 10; i++) {
    const id = crypto.randomBytes(4).toString('hex');
    if (!rooms.has(id)) return id;
  }
  return crypto.randomBytes(6).toString('hex');
}
function generateHostToken() { return crypto.randomBytes(16).toString('hex'); }
function sanitizeName(n) { return String(n || '').trim().substring(0, 30) || 'Anônimo'; }
function sanitizeText(t, max = 500) { return String(t || '').trim().substring(0, max); }
function sanitizeColor(c) { return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#f0f0f5'; }

// 🆕 v0.5: Sala pertence a uma plataforma. Identifica plataforma da URL.
const PLATFORM_PATTERNS = [
  { name: 'youtube',    re: /^https?:\/\/(www\.|m\.)?youtube\.com\/|^https?:\/\/youtu\.be\// },
  { name: 'netflix',    re: /^https?:\/\/(www\.)?netflix\.com\// },
  { name: 'disneyplus', re: /^https?:\/\/(www\.)?disneyplus\.com\// },
  { name: 'primevideo', re: /^https?:\/\/(www\.)?primevideo\.com\// },
  { name: 'max',        re: /^https?:\/\/(play\.|www\.)?(max|hbomax)\.com\// },
  { name: 'globoplay',  re: /^https?:\/\/globoplay\.globo\.com\// },
  { name: 'crunchyroll',re: /^https?:\/\/(www\.|beta\.)?crunchyroll\.com\// },
];
function detectPlatform(url) {
  if (!url) return null;
  for (const p of PLATFORM_PATTERNS) {
    if (p.re.test(url)) return p.name;
  }
  return null;
}
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg, excludeId = null) {
  const data = JSON.stringify(msg);
  room.clients.forEach(({ ws }, cid) => {
    if (cid !== excludeId && ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}
function getParticipantsList(room) {
  const list = [];
  room.clients.forEach(({ name, status, avatar, nameColor }, id) => {
    list.push({
      id, name,
      avatar: avatar || '😎',
      nameColor: nameColor || '#f0f0f5',
      isHost: id === room.hostId,
      status: status || 'active',
      muted: room.mutedUsers.has(id),
    });
  });
  return list;
}
function broadcastParticipants(room) {
  broadcast(room, { type: 'participants_update', participants: getParticipantsList(room) });
}
function getReadinessList(room) {
  const notReady = [];
  room.clients.forEach((client, id) => {
    if (id === room.hostId) return;
    const r = room.readiness.get(id);
    if (!r || r.status === 'ready') return;
    notReady.push({
      id, name: client.name,
      status: r.status, reason: r.reason || null,
      since: r.since,
    });
  });
  return notReady;
}
function broadcastReadiness(room) {
  broadcast(room, { type: 'readiness_update', notReady: getReadinessList(room), total: room.clients.size });
}
function isMigrating(room) {
  return !!(room && room.migrationUntil && Date.now() < room.migrationUntil);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  // 🆕 v26.4.1 — /ping: endpoint leve pra o cliente detectar se o servidor
  // está acordado. No Render free tier o servidor hiberna após 15min
  // ociosos; o primeiro request pode levar 30-60s pra acordar. O sidepanel
  // faz um fetch silencioso quando abre pra dar feedback visual nesse caso.
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const roomMatch = req.url.match(/^\/room\/([a-f0-9]{6,12})$/);
  if (req.method === 'GET' && roomMatch) {
    const room = rooms.get(roomMatch[1]);
    if (!room) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sala não encontrada.' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ contentUrl: room.contentUrl || null }));
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    name: 'Cineminha Server', status: 'online', version: '0.4.3-beta',
    rooms: rooms.size,
    clients: Array.from(rooms.values()).reduce((a, r) => a + r.clients.size, 0),
  }));
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const ip = getClientIp(req);
  const existing = ipConnections.get(ip) || 0;
  if (existing >= MAX_CONNECTIONS_PER_IP) {
    try {
      sendTo(ws, { type: 'error', message: 'Muitas conexões simultâneas deste endereço.' });
      ws.close(1008, 'too_many_connections');
    } catch {}
    return;
  }
  ipConnections.set(ip, existing + 1);

  const bucket = { tokens: MSG_RATE_BURST, lastRefill: Date.now() };
  function tryConsume() {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(MSG_RATE_BURST, bucket.tokens + elapsed * MSG_RATE_REFILL_PER_SEC);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  const clientId = uuidv4();
  let currentRoomId = null;
  let clientName = 'Anônimo';

  ws.on('message', (rawData) => {
    if (!tryConsume()) {
      // 🆕 v-next — C1: Avisa o cliente só pra tipos de usuário (chat, reaction).
      // Tipos internos de sync/typing não precisam de feedback — dropam silenciosamente
      // pra não congestionar ainda mais quando o cliente está spammando.
      try {
        const msg = JSON.parse(rawData);
        if (msg && (msg.type === 'chat' || msg.type === 'reaction')) {
          sendTo(ws, { type: 'rate_limited', originalType: msg.type });
        }
      } catch {}
      return;
    }
    let msg;
    try { msg = JSON.parse(rawData); } catch { return; }
    if (!msg || !msg.type) return;
    handleMessage(msg);
  });

  ws.on('close', () => {
    const cur = ipConnections.get(ip) || 0;
    if (cur <= 1) ipConnections.delete(ip);
    else ipConnections.set(ip, cur - 1);
    handleDisconnect();
  });
  ws.on('error', () => {});

  function handleMessage(msg) {
    switch (msg.type) {
      case 'create_room': {
        if (currentRoomId) leaveCurrentRoom();
        const roomId = generateRoomId();
        const hostToken = generateHostToken();
        clientName = sanitizeName(msg.name);
        const initialUrl = sanitizeText(msg.contentUrl, 500) || null;
        const initialPlatform = detectPlatform(initialUrl);
        // 🆕 v26.3.0.0 — Modo da sala: 'cinema' (streamings sync) ou 'broadcast'
        // (compartilhamento de tela). Default: cinema.
        const initialMode = (msg.mode === 'broadcast') ? 'broadcast' : 'cinema';
        rooms.set(roomId, {
          id: roomId, hostId: clientId, hostToken,
          clients: new Map([[clientId, { ws, name: clientName, avatar: msg.avatar || '😎', nameColor: sanitizeColor(msg.nameColor), status: 'active', joinedAt: Date.now() }]]),
          state: { currentTime: 0, playing: false, updatedAt: Date.now() },
          createdAt: Date.now(),
          contentUrl: initialUrl,
          contentTitle: null,
          platform: initialPlatform,
          mode: initialMode,
          locked: false, mutedUsers: new Set(),
          readiness: new Map(),
          hostOrphanedAt: null, hostOrphanTimer: null,
          screenShareActive: false,
          screenShareStartedAt: null,
          screenShareHasAudio: false,
        });
        currentRoomId = roomId;
        sendTo(ws, {
          type: 'room_created',
          roomId, clientId, hostToken,
          platform: initialPlatform,
          mode: initialMode,
          participants: getParticipantsList(rooms.get(roomId)),
        });
        break;
      }
      case 'join_room': {
        const room = rooms.get(msg.roomId);
        if (!room) { sendTo(ws, { type: 'error', message: 'Sala não encontrada. Verifique o código.' }); return; }
        if (room.locked) { sendTo(ws, { type: 'error', message: 'Esta sala está trancada pelo host.' }); return; }
        if (currentRoomId) leaveCurrentRoom();
        clientName = sanitizeName(msg.name);
        currentRoomId = msg.roomId;
        room.clients.set(clientId, { ws, name: clientName, avatar: msg.avatar || '😎', nameColor: sanitizeColor(msg.nameColor), status: 'active', joinedAt: Date.now() });
        // 🆕 v26.2.0.0 — Se há transmissão ativa, inclui nome do host e hasAudio
        // para que o guest consiga montar a UI certa e auto-conectar.
        const ssHostClient = room.screenShareActive ? room.clients.get(room.hostId) : null;
        sendTo(ws, {
          type: 'room_joined', roomId: msg.roomId, clientId,
          state: room.state,
          participants: getParticipantsList(room),
          isHost: room.hostId === clientId,
          locked: room.locked,
          contentUrl: room.contentUrl,
          contentTitle: room.contentTitle || null,
          platform: room.platform,
          mode: room.mode || 'cinema',
          notReady: getReadinessList(room),
          screenShareActive: !!room.screenShareActive, // 🆕 v26.2.0.0
          screenShareHostName: ssHostClient ? ssHostClient.name : null,
          screenShareHasAudio: !!room.screenShareHasAudio,
        });
        if (isMigrating(room)) {
          broadcastParticipants(room);
        } else {
          broadcast(room, {
            type: 'user_joined', clientId, name: clientName,
            participants: getParticipantsList(room),
          }, clientId);
          // 🆕 v26.3.1 — Quando um guest entra, pede ao host pra enviar
          // o estado atual do player (currentTime, playing). Antes, o guest
          // recebia room.state que só atualiza quando o host faz play/pause/seek;
          // se o host já estava assistindo antes de criar a sala (ex: na metade
          // de um filme), o guest via currentTime=0 e tentava começar do zero.
          const hostClient = room.hostId ? room.clients.get(room.hostId) : null;
          if (hostClient && hostClient.ws && hostClient.ws.readyState === 1) {
            sendTo(hostClient.ws, { type: 'request_host_state' });
          }
        }
        break;
      }
      case 'rejoin_host': {
        const room = rooms.get(msg.roomId);
        if (!room) { sendTo(ws, { type: 'error', message: 'Sala não encontrada.' }); return; }
        if (!msg.hostToken || msg.hostToken !== room.hostToken) {
          sendTo(ws, { type: 'error', message: 'Token inválido para retomar como host.' });
          return;
        }
        if (room.hostOrphanTimer) {
          clearTimeout(room.hostOrphanTimer);
          room.hostOrphanTimer = null;
          room.hostOrphanedAt = null;
        }
        currentRoomId = msg.roomId;
        clientName = sanitizeName(msg.name);
        room.clients.set(clientId, { ws, name: clientName, avatar: msg.avatar || '😎', nameColor: sanitizeColor(msg.nameColor), status: 'active', joinedAt: Date.now() });
        room.hostId = clientId;
        sendTo(ws, {
          type: 'room_joined', roomId: msg.roomId, clientId,
          hostToken: room.hostToken,
          state: room.state, isHost: true,
          participants: getParticipantsList(room),
          locked: room.locked,
          contentUrl: room.contentUrl,
          contentTitle: room.contentTitle || null,
          platform: room.platform,
          mode: room.mode || 'cinema',
          notReady: getReadinessList(room),
        });
        broadcast(room, { type: 'new_host', clientId, name: clientName }, clientId);
        broadcastParticipants(room);
        break;
      }
      case 'leave_room': { leaveCurrentRoom(); break; }
      case 'close_room': {
        // 🆕 v0.5: host fechou aba do vídeo — encerra sala para todos
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        broadcast(room, { type: 'room_closed', reason: msg.reason || 'Host encerrou a sala.' });
        if (room.hostOrphanTimer) clearTimeout(room.hostOrphanTimer);
        if (room.activePauseVote?.timer) clearTimeout(room.activePauseVote.timer);
        rooms.delete(currentRoomId);
        currentRoomId = null;
        break;
      }
      case 'play': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        if (room.mode === 'broadcast') return; // 🆕 v26.3.0.0 — sync off
        room.state.currentTime = msg.currentTime || 0;
        room.state.playing = true;
        room.state.updatedAt = Date.now();
        // 🆕 v26.3.1 — Inclui hostName pro guest saber quem fez a ação
        // na notificação "Host retomou em X".
        broadcast(room, { type: 'play', currentTime: msg.currentTime || 0, timestamp: Date.now(), hostName: clientName }, clientId);
        break;
      }
      case 'pause': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        if (room.mode === 'broadcast') return; // 🆕 v26.3.0.0 — sync off
        room.state.currentTime = msg.currentTime || 0;
        room.state.playing = false;
        room.state.updatedAt = Date.now();
        broadcast(room, { type: 'pause', currentTime: msg.currentTime || 0, hostName: clientName }, clientId);
        break;
      }
      case 'seek': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        if (room.mode === 'broadcast') return; // 🆕 v26.3.0.0 — sync off
        room.state.currentTime = msg.currentTime || 0;
        room.state.updatedAt = Date.now();
        broadcast(room, { type: 'seek', currentTime: msg.currentTime || 0, hostName: clientName }, clientId);
        break;
      }
      // 🆕 v26.3.1 — Guest (não-host) fez play/pause/seek. Re-broadcasta
      // como notificação pros outros (incluindo host). NÃO atualiza
      // room.state — só o host é fonte de verdade.
      case 'guest_event': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        if (room.hostId === clientId) return; // host usa video_event normal
        if (room.mode === 'broadcast') return;
        const action = msg.action;
        if (action !== 'play' && action !== 'pause' && action !== 'seek') return;
        broadcast(room, {
          type: 'guest_event',
          action,
          currentTime: msg.currentTime || 0,
          userName: clientName,
        }, clientId);
        break;
      }
      case 'host_state': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        const hostTime = typeof msg.currentTime === 'number' ? msg.currentTime : room.state.currentTime;
        const hostPlaying = typeof msg.playing === 'boolean' ? msg.playing : room.state.playing;
        room.state.currentTime = hostTime;
        room.state.playing = hostPlaying;
        room.state.updatedAt = Date.now();
        broadcast(room, { type: 'host_state', currentTime: hostTime, playing: hostPlaying, timestamp: Date.now() }, clientId);
        break;
      }
      // 🆕 v26.4.1 — G1: Sistema de votação pra pausar.
      // Regras:
      //   - Solicitante conta automaticamente como "sim"
      //   - Com 2 pessoas: threshold=1 (o outro usuário precisa aprovar)
      //   - Com 3+: threshold=1 (maioria simples: solicitante + ≥1)
      //   - Timeout de 15s; se não atingir quorum, expira silenciosamente
      //   - Rate-limit: 1 pedido a cada 10s por cliente
      //   - Se só tem 1 pessoa na sala, pedido não é aceito (deve pausar sozinho)
      case 'pause_request': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        if (room.mode === 'broadcast') return;
        if (room.clients.size < 2) return;
        // 🔧 v26.4.1 — Bug fix: usava `clients.get(ws)` referenciando um
        // mapa global inexistente (TypeError silencioso matava a votação).
        // Agora pega o registro do próprio cliente via `room.clients.get(clientId)`.
        const client = room.clients.get(clientId);
        if (!client) return;
        const now = Date.now();
        if (client.lastPauseReqAt && now - client.lastPauseReqAt < 10000) return;
        if (room.activePauseVote) return; // já tem votação rolando
        client.lastPauseReqAt = now;

        const voteId = `v_${now}_${Math.random().toString(36).slice(2, 8)}`;
        const othersCount = room.clients.size - 1;
        // Threshold: +1 pessoa além do solicitante.
        // (Funciona igual pra 2p ou 3+: precisa que o solicitante convença
        // pelo menos 1 outro. Com 2p, essa 1 outra pessoa é a única.)
        const threshold = 1;
        const vote = {
          id: voteId,
          requesterId: clientId,
          requesterName: clientName,
          ayes: new Set([clientId]),
          nays: new Set(),
          threshold,
          expiresAt: now + 15000,
          timer: null,
        };
        room.activePauseVote = vote;

        // Timer de expiração (15s)
        vote.timer = setTimeout(() => {
          if (room.activePauseVote && room.activePauseVote.id === voteId) {
            broadcast(room, { type: 'pause_result', voteId, approved: false, reason: 'timeout' });
            room.activePauseVote = null;
          }
        }, 15000);

        broadcast(room, {
          type: 'pause_request',
          voteId,
          userName: clientName,
          requesterId: clientId,
          totalOthers: othersCount,
          threshold,
          expiresAt: vote.expiresAt,
        });
        break;
      }
      // 🆕 v26.4.1 — G1: Voto (aye=aprovar, nay=recusar)
      case 'pause_vote': {
        const room = rooms.get(currentRoomId);
        if (!room || !room.activePauseVote) return;
        const vote = room.activePauseVote;
        if (msg.voteId && msg.voteId !== vote.id) return;
        if (clientId === vote.requesterId) return; // solicitante não vota de novo
        if (vote.ayes.has(clientId) || vote.nays.has(clientId)) return;

        if (msg.approve) vote.ayes.add(clientId);
        else vote.nays.add(clientId);

        // Broadcast progresso atual
        broadcast(room, {
          type: 'pause_vote_progress',
          voteId: vote.id,
          ayes: vote.ayes.size,
          nays: vote.nays.size,
          totalOthers: room.clients.size - 1,
          threshold: vote.threshold,
        });

        // Aprovou? Precisa de solicitante + threshold "ayes" dos outros
        // vote.ayes inclui o solicitante; outros = ayes.size - 1
        const othersAyes = vote.ayes.size - 1;
        if (othersAyes >= vote.threshold) {
          clearTimeout(vote.timer);
          broadcast(room, { type: 'pause_result', voteId: vote.id, approved: true });
          room.activePauseVote = null;
        }
        // Recusado por maioria? Se todos os outros recusaram, cancela
        else if (vote.nays.size >= (room.clients.size - 1)) {
          clearTimeout(vote.timer);
          broadcast(room, { type: 'pause_result', voteId: vote.id, approved: false, reason: 'rejected' });
          room.activePauseVote = null;
        }
        break;
      }
      // 🆕 v26.4.1 — G1: Solicitante cancela antes do fim
      case 'pause_cancel': {
        const room = rooms.get(currentRoomId);
        if (!room || !room.activePauseVote) return;
        const vote = room.activePauseVote;
        if (clientId !== vote.requesterId) return;
        clearTimeout(vote.timer);
        broadcast(room, { type: 'pause_result', voteId: vote.id, approved: false, reason: 'cancelled' });
        room.activePauseVote = null;
        break;
      }
      case 'chat': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        if (room.mutedUsers.has(clientId)) {
          sendTo(ws, { type: 'error', message: 'Você está silenciado pelo host.' });
          return;
        }
        const text = sanitizeText(msg.message);
        if (!text) return;
        const sender = room.clients.get(clientId);
        // 🆕 v26.3.1.0 — Suporte a reply: valida e sanitiza o replyTo
        let replyTo = null;
        if (msg.replyTo && typeof msg.replyTo === 'object') {
          const rName = typeof msg.replyTo.name === 'string' ? msg.replyTo.name.slice(0, 40) : '';
          const rText = typeof msg.replyTo.text === 'string' ? msg.replyTo.text.slice(0, 200) : '';
          if (rName && rText) replyTo = { name: rName, text: rText };
        }
        // 🆕 v-next — Menções: array de strings (nomes de participantes)
        // ou o literal "__all__" para @todos. Limite de 20 menções/mensagem
        // e cada nome cap 40 chars pra evitar abuso.
        let mentions = null;
        if (Array.isArray(msg.mentions)) {
          const cleaned = msg.mentions
            .filter(m => typeof m === 'string')
            .map(m => m.slice(0, 40))
            .slice(0, 20);
          if (cleaned.length) mentions = cleaned;
        }
        // 🆕 v-next — msgId: identifica mensagem pra reações (C3) e edição/exclusão (C5).
        // 12 chars é suficiente pra evitar colisão em salas de chat.
        const msgId = crypto.randomBytes(6).toString('hex');
        // Guarda metadados mínimos da mensagem na sala pra validar ops subsequentes.
        // TTL implícito: sala toda some quando esvazia. Limitamos a 500 mensagens
        // pra evitar crescimento infinito em salas de longa duração.
        if (!room.messages) room.messages = new Map();
        room.messages.set(msgId, {
          clientId, text, ts: Date.now(), reactions: new Map(), // Map<emoji, Set<clientId>>
          edited: false, deleted: false,
        });
        if (room.messages.size > 500) {
          const oldestKey = room.messages.keys().next().value;
          room.messages.delete(oldestKey);
        }
        broadcast(room, {
          type: 'chat', clientId, name: clientName,
          avatar: sender?.avatar || '😎',
          nameColor: sender?.nameColor || '#f0f0f5',
          message: text, ts: Date.now(), msgId,
          ...(replyTo ? { replyTo } : {}),
          ...(mentions ? { mentions } : {}),
        });
        break;
      }
      case 'reaction': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const allowed = ['❤️', '😂', '😮', '😢', '🔥', '👏', '🍿', '👀'];
        if (!allowed.includes(msg.emoji)) return;
        broadcast(room, { type: 'reaction', name: clientName, emoji: msg.emoji, senderId: clientId });
        break;
      }
      // 🆕 v-next — Indicador "está digitando". Broadcast efêmero,
      // sem persistência. Clientes expiram localmente após ~3s sem update.
      // 🆕 v-next — Inclui avatar pro C2 (stack visual de avatares)
      case 'typing': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        if (room.mutedUsers && room.mutedUsers.has(clientId)) return;
        const sender = room.clients.get(clientId);
        broadcast(room, {
          type: 'typing', name: clientName, senderId: clientId,
          avatar: sender?.avatar || '😎',
          active: !!msg.active,
        }, clientId);
        break;
      }

      // 🆕 v-next — C3: Reação a mensagem específica (toggle).
      // Cliente manda { type: 'msg_react', msgId, emoji }. Server
      // broadcasta estado completo das reações daquela mensagem.
      case 'msg_react': {
        const room = rooms.get(currentRoomId);
        if (!room || !room.messages) return;
        if (room.mutedUsers.has(clientId)) return;
        const allowed = ['❤️', '😂', '😮', '😢', '🔥', '👏', '🍿', '👀'];
        if (!allowed.includes(msg.emoji)) return;
        const m = room.messages.get(msg.msgId);
        if (!m || m.deleted) return;
        let set = m.reactions.get(msg.emoji);
        if (!set) { set = new Set(); m.reactions.set(msg.emoji, set); }
        if (set.has(clientId)) set.delete(clientId);
        else set.add(clientId);
        if (set.size === 0) m.reactions.delete(msg.emoji);
        // Monta snapshot serializável: { emoji: [clientId, ...], ... }
        const snapshot = {};
        m.reactions.forEach((s, emo) => { snapshot[emo] = Array.from(s); });
        broadcast(room, { type: 'msg_react_update', msgId: msg.msgId, reactions: snapshot });
        break;
      }

      // 🆕 v-next — C5: Edição (janela de 30s, só autor).
      case 'msg_edit': {
        const room = rooms.get(currentRoomId);
        if (!room || !room.messages) return;
        if (room.mutedUsers.has(clientId)) return;
        const m = room.messages.get(msg.msgId);
        if (!m || m.deleted) return;
        if (m.clientId !== clientId) return; // só autor
        if (Date.now() - m.ts > 30000) return; // fora da janela
        const newText = sanitizeText(msg.message);
        if (!newText) return;
        m.text = newText;
        m.edited = true;
        broadcast(room, { type: 'msg_edit_update', msgId: msg.msgId, message: newText });
        break;
      }

      // 🆕 v-next — C5: Exclusão (janela de 30s, autor OU host).
      case 'msg_delete': {
        const room = rooms.get(currentRoomId);
        if (!room || !room.messages) return;
        const m = room.messages.get(msg.msgId);
        if (!m || m.deleted) return;
        const isAuthor = m.clientId === clientId;
        const isHost = room.hostId === clientId;
        if (!isAuthor && !isHost) return;
        // Autor tem janela de 30s; host pode a qualquer tempo
        if (isAuthor && !isHost && Date.now() - m.ts > 30000) return;
        m.deleted = true;
        m.text = '';
        m.reactions.clear();
        broadcast(room, { type: 'msg_delete_update', msgId: msg.msgId });
        break;
      }

      // 🆕 v-next — D3: Poll (enquete inline no chat).
      // Cliente (qualquer) cria poll; todos votam; fechamento automático em 30s.
      case 'poll_create': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        if (room.mutedUsers.has(clientId)) return;
        const question = sanitizeText(msg.question);
        if (!question) return;
        if (!Array.isArray(msg.options)) return;
        const options = msg.options.slice(0, 4).map(o => sanitizeText(o)).filter(Boolean);
        if (options.length < 2) return;
        if (!room.polls) room.polls = new Map();
        // Só 1 poll ativo por vez — se existir, rejeita silenciosamente
        if (Array.from(room.polls.values()).some(p => !p.closed)) return;
        const pollId = crypto.randomBytes(6).toString('hex');
        const poll = {
          pollId, question, options,
          votes: new Map(), // Map<clientId, optionIdx>
          creatorId: clientId,
          creatorName: clientName,
          startedAt: Date.now(),
          durationMs: 30000,
          closed: false,
        };
        room.polls.set(pollId, poll);
        broadcast(room, {
          type: 'poll_open', pollId, question, options,
          creatorName: clientName, durationMs: poll.durationMs,
        });
        // Fechamento automático
        setTimeout(() => {
          const p = room.polls.get(pollId);
          if (!p || p.closed) return;
          p.closed = true;
          const tally = p.options.map(() => 0);
          p.votes.forEach(idx => { if (idx >= 0 && idx < tally.length) tally[idx]++; });
          broadcast(room, { type: 'poll_close', pollId, tally });
        }, poll.durationMs);
        break;
      }

      // 🆕 v-next — D3: Voto em poll ativa.
      case 'poll_vote': {
        const room = rooms.get(currentRoomId);
        if (!room || !room.polls) return;
        const p = room.polls.get(msg.pollId);
        if (!p || p.closed) return;
        const idx = Number(msg.optionIdx);
        if (!Number.isInteger(idx) || idx < 0 || idx >= p.options.length) return;
        p.votes.set(clientId, idx);
        // Broadcast tally parcial pra todos verem em tempo real
        const tally = p.options.map(() => 0);
        p.votes.forEach(v => { if (v >= 0 && v < tally.length) tally[v]++; });
        broadcast(room, { type: 'poll_update', pollId: msg.pollId, tally });
        break;
      }
      case 'kick_user': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        const tid = msg.targetId;
        if (tid === clientId) return;
        const target = room.clients.get(tid);
        if (!target) return;
        const targetName = target.name;
        sendTo(target.ws, { type: 'kicked', message: 'Você foi removido da sala pelo host.' });
        setTimeout(() => { try { target.ws.close(1000, 'kicked'); } catch {} }, 200);
        room.clients.delete(tid);
        room.mutedUsers.delete(tid);
        room.readiness.delete(tid);
        broadcast(room, { type: 'user_left', name: targetName, clientId: tid, kicked: true, participants: getParticipantsList(room) });
        broadcastReadiness(room);
        break;
      }
      case 'mute_user': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        const tid = msg.targetId;
        if (tid === clientId) return;
        const target = room.clients.get(tid);
        if (!target) return;
        const wasMuted = room.mutedUsers.has(tid);
        if (wasMuted) room.mutedUsers.delete(tid); else room.mutedUsers.add(tid);
        broadcast(room, { type: 'user_muted', targetId: tid, targetName: target.name, muted: !wasMuted });
        broadcastParticipants(room);
        break;
      }
      case 'lock_room': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        room.locked = !room.locked;
        broadcast(room, { type: 'room_locked', locked: room.locked });
        break;
      }
      // 🆕 v26.3.0.0 — Troca de modo (só host)
      // cinema → broadcast: mantém sala ativa, apenas para de sincronizar vídeo
      //                     nas páginas dos participantes
      // broadcast → cinema: se havia transmissão ativa, ela é encerrada
      case 'set_mode': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        const newMode = (msg.mode === 'broadcast') ? 'broadcast' : 'cinema';
        if (room.mode === newMode) return;
        const wasBroadcast = room.mode === 'broadcast';
        room.mode = newMode;
        if (wasBroadcast && newMode !== 'broadcast' && room.screenShareActive) {
          room.screenShareActive = false;
          room.screenShareStartedAt = null;
          room.screenShareHasAudio = false;
          broadcast(room, { type: 'screenshare_stopped', hostId: room.hostId });
        }
        broadcast(room, { type: 'mode_changed', mode: newMode, by: clientName });
        break;
      }
      case 'host_navigate': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        if (room.mode === 'broadcast') return; // 🆕 v26.3.0.0 — sem redirect em broadcast
        const newUrl = sanitizeText(msg.contentUrl, 500);
        if (!newUrl) return;
        if (newUrl === room.contentUrl) return;
        const newPlatform = detectPlatform(newUrl);
        if (!newPlatform) {
          sendTo(ws, { type: 'error', message: 'URL não é de uma plataforma suportada.' });
          return;
        }
        // 🆕 v26.1.1.0 — Sala agora PODE mudar de plataforma!
        // Debounce: mínimo 5s entre mudanças (evita ping-pong).
        const isPlatformChange = !!room.platform && room.platform !== newPlatform;
        if (isPlatformChange) {
          const now = Date.now();
          const lastChange = room.lastPlatformChangeAt || 0;
          if (now - lastChange < PLATFORM_CHANGE_DEBOUNCE_MS) {
            const waitSec = Math.ceil((PLATFORM_CHANGE_DEBOUNCE_MS - (now - lastChange)) / 1000);
            sendTo(ws, {
              type: 'platform_change_throttled',
              waitSec,
              message: `Aguarde ${waitSec} segundo${waitSec !== 1 ? 's' : ''} antes de trocar de plataforma novamente.`,
            });
            return;
          }
          room.lastPlatformChangeAt = now;
        }
        const oldPlatform = room.platform;
        if (!room.platform || isPlatformChange) {
          room.platform = newPlatform;
          broadcast(room, { type: 'platform_set', platform: newPlatform });
        }
        room.contentUrl = newUrl;
        room.state.currentTime = 0;
        room.state.playing = false;
        room.state.updatedAt = Date.now();
        room.migrationUntil = Date.now() + MIGRATION_WINDOW_MS;
        room.readiness.clear();
        broadcast(room, {
          type: 'host_navigate',
          contentUrl: newUrl,
          platform: newPlatform,
          platformChanged: isPlatformChange,
          previousPlatform: oldPlatform || null,
        });
        broadcastReadiness(room);
        break;
      }
      case 'readiness': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        // 🆕 v0.5: removido 'ad' — guests em ad não bloqueiam mais a sala
        const validStatuses = ['ready', 'blocked', 'buffering'];
        if (!validStatuses.includes(msg.status)) return;
        const prev = room.readiness.get(clientId);
        const reason = typeof msg.reason === 'string' ? msg.reason.substring(0, 40) : null;
        const next = { status: msg.status, reason, since: Date.now() };
        room.readiness.set(clientId, next);
        if (!prev || prev.status !== next.status || prev.reason !== next.reason) {
          broadcastReadiness(room);
        }
        break;
      }
      case 'presence': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const client = room.clients.get(clientId);
        if (!client) return;
        client.status = msg.status === 'away' ? 'away' : 'active';
        broadcastParticipants(room);
        break;
      }
      // 🆕 v0.11 — Título do vídeo (só host pode setar). Faz broadcast pros guests.
      case 'content_title': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        if (room.hostId !== clientId) return; // só host pode setar
        const title = sanitizeText(msg.title, 200);
        if (!title) return;
        if (room.contentTitle === title) return; // sem mudança, não rebroadcast
        room.contentTitle = title;
        broadcast(room, { type: 'content_title', title, platform: sanitizeText(msg.platform, 40) || null });
        break;
      }
      // ============================================================
      // 🆕 v26.2.0.0 — Screen sharing (WebRTC signaling relay)
      // ============================================================
      // O servidor NÃO trafega mídia: apenas faz relay de mensagens de
      // sinalização entre host (broadcaster) e guests (viewers).
      // Topologia: mesh P2P (host envia 1 PeerConnection por guest).
      case 'screenshare_start': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        // 🆕 v26.3.0.0 — Só disponível em modo Transmissão
        if (room.mode !== 'broadcast') {
          sendTo(ws, { type: 'error', message: 'A transmissão só funciona em salas no modo Transmissão.' });
          return;
        }
        room.screenShareActive = true;
        room.screenShareStartedAt = Date.now();
        room.screenShareHasAudio = !!msg.hasAudio;
        broadcast(room, {
          type: 'screenshare_started',
          hostId: clientId,
          hostName: clientName,
          hasAudio: !!msg.hasAudio,
        });
        break;
      }
      case 'screenshare_stop': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        room.screenShareActive = false;
        room.screenShareStartedAt = null;
        room.screenShareHasAudio = false;
        broadcast(room, { type: 'screenshare_stopped', hostId: clientId });
        break;
      }
      // Guest pede pra entrar no stream atual do host
      case 'screenshare_request': {
        const room = rooms.get(currentRoomId);
        if (!room || !room.screenShareActive) return;
        if (clientId === room.hostId) return; // host não pede pra si mesmo
        const host = room.clients.get(room.hostId);
        if (!host) return;
        sendTo(host.ws, {
          type: 'screenshare_request',
          viewerId: clientId,
          viewerName: clientName,
        });
        break;
      }
      // Sinalização WebRTC: offer/answer/ice — relay direcionado
      case 'rtc_signal': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const targetId = msg.targetId;
        if (!targetId || typeof targetId !== 'string') return;
        const target = room.clients.get(targetId);
        if (!target) return;
        // Só permite sinalização entre host e guests (não guest↔guest)
        if (clientId !== room.hostId && targetId !== room.hostId) return;
        const payload = msg.payload;
        if (!payload || typeof payload !== 'object') return;
        // Limite de tamanho básico (SDP pode ser grande, ~20KB é seguro)
        try {
          const size = JSON.stringify(payload).length;
          if (size > 32_000) return;
        } catch { return; }
        sendTo(target.ws, {
          type: 'rtc_signal',
          fromId: clientId,
          fromName: clientName,
          payload,
        });
        break;
      }
      case 'ping': { sendTo(ws, { type: 'pong' }); break; }
      default: break;
    }
  }

  function handleDisconnect() {
    if (currentRoomId) leaveCurrentRoom();
  }

  function leaveCurrentRoom() {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) { currentRoomId = null; return; }
    room.clients.delete(clientId);
    room.mutedUsers.delete(clientId);
    room.readiness.delete(clientId);
    if (room.hostId === clientId) {
      // 🆕 v26.2.0.0 — Screen share do host cai junto com o host
      if (room.screenShareActive) {
        room.screenShareActive = false;
        room.screenShareStartedAt = null;
        room.screenShareHasAudio = false;
        broadcast(room, { type: 'screenshare_stopped', hostId: clientId, reason: 'host_left' });
      }
      if (room.clients.size === 0) {
        rooms.delete(currentRoomId);
      } else {
        room.hostOrphanedAt = Date.now();
        if (room.hostOrphanTimer) clearTimeout(room.hostOrphanTimer);
        room.hostOrphanTimer = setTimeout(() => {
          if (!rooms.has(room.id)) return;
          if (room.clients.size === 0) { rooms.delete(room.id); return; }
          let newHostId = null;
          let oldest = Infinity;
          room.clients.forEach((c, id) => {
            if (c.joinedAt < oldest) { oldest = c.joinedAt; newHostId = id; }
          });
          if (!newHostId) { rooms.delete(room.id); return; }
          const newHost = room.clients.get(newHostId);
          room.hostId = newHostId;
          room.hostToken = generateHostToken();
          room.hostOrphanedAt = null;
          room.hostOrphanTimer = null;
          room.readiness.delete(newHostId);
          sendTo(newHost.ws, { type: 'host_promoted', hostToken: room.hostToken });
          // 🆕 v26.1.1.0 — Exclui o novo host do broadcast (ele já recebeu host_promoted,
          // que aciona o mesmo toast localmente. Antes duplicava).
          broadcast(room, { type: 'new_host', clientId: newHostId, name: newHost.name }, newHostId);
          broadcastParticipants(room);
          broadcastReadiness(room);
        }, HOST_ORPHAN_GRACE_MS);
        broadcast(room, { type: 'host_orphaned', graceMs: HOST_ORPHAN_GRACE_MS });
      }
    } else if (room.clients.size === 0) {
      if (room.hostOrphanTimer) { clearTimeout(room.hostOrphanTimer); room.hostOrphanTimer = null; }
      room.emptyAt = Date.now();
    } else if (isMigrating(room)) {
      broadcastParticipants(room);
      broadcastReadiness(room);
    } else {
      // 🆕 v26.2.0.0 — Se screen share ativo, avisa o host pra fechar a PC do viewer que saiu
      if (room.screenShareActive) {
        const host = room.clients.get(room.hostId);
        if (host) sendTo(host.ws, { type: 'screenshare_viewer_left', viewerId: clientId });
      }
      broadcast(room, {
        type: 'user_left', clientId, name: clientName,
        participants: getParticipantsList(room),
      });
      broadcastReadiness(room);
    }
    currentRoomId = null;
  }
});

setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, id) => {
    if (room.clients.size === 0 && room.emptyAt && now - room.emptyAt > 5 * 60 * 1000) {
      if (room.hostOrphanTimer) clearTimeout(room.hostOrphanTimer);
      rooms.delete(id);
    }
  });
}, 60_000);

// 🆕 v26.3.1 — Broadcast periódico de host_state pros guests.
// Mantém a referência de tempo do host atualizada no HUD mesmo sem
// ações (play/pause/seek). Frequência: 5s.
// Só dispara se:
//   - sala em modo cinema (broadcast screen-share não usa sync)
//   - sala tem host online (hostOrphanedAt null)
//   - sala tem mais de 1 participante (só faz sentido com guests)
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.mode !== 'cinema') continue;
    if (room.hostOrphanedAt) continue;
    if (!room.hostId) continue;
    if (room.clients.size < 2) continue;
    const hostClient = room.clients.get(room.hostId);
    if (!hostClient || !hostClient.ws || hostClient.ws.readyState !== 1) continue;
    // Pede ao host pra enviar state atual.
    // O host responderá com 'host_state' que chega pelos canais normais.
    try { hostClient.ws.send(JSON.stringify({ type: 'request_host_state' })); } catch {}
  }
}, 5_000);

server.listen(PORT, () => {
  console.log(`\n🎬 Cineminha Server v26.4.1 rodando na porta ${PORT}`);
  console.log(`   HTTP: http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}\n`);
});
