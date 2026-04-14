// ============================================================
// Cineminha — Servidor WebSocket v3.0
// Funcionalidades: sync, chat, reações, enquetes, timestamps,
// countdown, presença, kick/mute/lock, host avançado
// ============================================================
'use strict';

const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;

// ── Estrutura de dados ──────────────────────────────────────
const rooms = new Map();

// ── Utilitários ─────────────────────────────────────────────
function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(id) ? generateRoomId() : id;
}

function sanitizeName(n) {
  return String(n || '').trim().substring(0, 30) || 'Anônimo';
}

function sanitizeText(t, max = 500) {
  return String(t || '').trim().substring(0, max);
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
      id,
      name,
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

// ── Servidor HTTP (health check + room info) ────────────────
const server = http.createServer((req, res) => {
  // CORS headers para permitir fetch do side panel
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  // GET /room/:roomId — retorna URL do conteúdo para auto-redirect
  const roomMatch = req.url.match(/^\/room\/([a-z0-9]{4,8})$/);
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

  // GET / — health check
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    name: 'Cineminha Server',
    status: 'online',
    version: '3.1.0',
    rooms: rooms.size,
    clients: Array.from(rooms.values()).reduce((a, r) => a + r.clients.size, 0),
  }));
});

// ── WebSocket ───────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  let currentRoomId = null;
  let clientName = 'Anônimo';

  ws.on('message', (rawData) => {
    let msg;
    try { msg = JSON.parse(rawData); } catch { return; }
    if (!msg || !msg.type) return;
    handleMessage(msg);
  });

  ws.on('close', () => handleDisconnect());
  ws.on('error', () => {});

  // ── Roteador de mensagens ───────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {

      // ─── CRIAR SALA ─────────────────────────────────────
      case 'create_room': {
        if (currentRoomId) leaveCurrentRoom();
        const roomId = generateRoomId();
        clientName = sanitizeName(msg.name);

        rooms.set(roomId, {
          id: roomId,
          hostId: clientId,
          clients: new Map([[clientId, { ws, name: clientName, avatar: msg.avatar || '😎', nameColor: msg.nameColor || '#f0f0f5', status: 'active', joinedAt: Date.now() }]]),
          state: { currentTime: 0, playing: false, updatedAt: Date.now() },
          createdAt: Date.now(),
          contentUrl: sanitizeText(msg.contentUrl, 2000) || null,
          locked: false,
          mutedUsers: new Set(),
          polls: [],
          timestamps: [],
        });

        currentRoomId = roomId;
        sendTo(ws, {
          type: 'room_created',
          roomId,
          clientId,
          participants: getParticipantsList(rooms.get(roomId)),
        });
        break;
      }

      // ─── ENTRAR NA SALA ─────────────────────────────────
      case 'join_room': {
        const room = rooms.get(msg.roomId);
        if (!room) { sendTo(ws, { type: 'error', message: 'Sala não encontrada. Verifique o código.' }); return; }
        if (room.locked) { sendTo(ws, { type: 'error', message: 'Esta sala está trancada pelo host.' }); return; }
        if (currentRoomId) leaveCurrentRoom();

        clientName = sanitizeName(msg.name);
        currentRoomId = msg.roomId;
        room.clients.set(clientId, { ws, name: clientName, avatar: msg.avatar || '😎', nameColor: msg.nameColor || '#f0f0f5', status: 'active', joinedAt: Date.now() });

        sendTo(ws, {
          type: 'room_joined',
          roomId: msg.roomId,
          clientId,
          state: room.state,
          participants: getParticipantsList(room),
          isHost: room.hostId === clientId,
          polls: room.polls.filter(p => !p.ended),
          timestamps: room.timestamps,
          locked: room.locked,
        });

        broadcast(room, {
          type: 'user_joined',
          clientId,
          name: clientName,
          participants: getParticipantsList(room),
        }, clientId);
        break;
      }

      // ─── REJOIN HOST ────────────────────────────────────
      case 'rejoin_host': {
        const room = rooms.get(msg.roomId);
        if (!room) return;
        currentRoomId = msg.roomId;
        clientName = sanitizeName(msg.name);
        room.clients.set(clientId, { ws, name: clientName, avatar: msg.avatar || '😎', nameColor: msg.nameColor || '#f0f0f5', status: 'active', joinedAt: Date.now() });
        room.hostId = clientId;

        sendTo(ws, {
          type: 'room_joined',
          roomId: msg.roomId,
          clientId,
          state: room.state,
          isHost: true,
          participants: getParticipantsList(room),
          polls: room.polls.filter(p => !p.ended),
          timestamps: room.timestamps,
          locked: room.locked,
        });

        broadcast(room, { type: 'new_host', clientId, name: clientName }, clientId);
        broadcastParticipants(room);
        break;
      }

      // ─── SAIR DA SALA ───────────────────────────────────
      case 'leave_room': {
        leaveCurrentRoom();
        break;
      }

      // ─── PLAYBACK ───────────────────────────────────────
      case 'play': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        room.state.currentTime = msg.currentTime || 0;
        room.state.playing = true;
        room.state.updatedAt = Date.now();
        broadcast(room, { type: 'play', currentTime: msg.currentTime || 0, timestamp: Date.now() }, clientId);
        break;
      }

      case 'pause': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        room.state.currentTime = msg.currentTime || 0;
        room.state.playing = false;
        room.state.updatedAt = Date.now();
        broadcast(room, { type: 'pause', currentTime: msg.currentTime || 0 }, clientId);
        break;
      }

      case 'seek': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        room.state.currentTime = msg.currentTime || 0;
        room.state.updatedAt = Date.now();
        broadcast(room, { type: 'seek', currentTime: msg.currentTime || 0 }, clientId);
        break;
      }

      case 'host_state': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        room.state.currentTime = msg.currentTime;
        room.state.playing = msg.playing;
        room.state.updatedAt = Date.now();
        broadcast(room, {
          type: 'host_state',
          currentTime: msg.currentTime,
          playing: msg.playing,
          timestamp: Date.now(),
        }, clientId);
        break;
      }

      // ─── CHAT ───────────────────────────────────────────
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
        broadcast(room, {
          type: 'chat',
          clientId,
          name: clientName,
          avatar: sender?.avatar || '😎',
          nameColor: sender?.nameColor || '#f0f0f5',
          message: text,
          ts: Date.now(),
        });
        break;
      }

      // ─── REAÇÕES ────────────────────────────────────────
      case 'reaction': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const allowed = ['❤️', '😂', '😮', '😢', '🔥', '👏'];
        if (!allowed.includes(msg.emoji)) return;
        // Broadcast para todos (incluindo remetente) — sem sendTo extra
        broadcast(room, { type: 'reaction', name: clientName, emoji: msg.emoji, senderId: clientId });
        break;
      }

      // ─── ENQUETES ───────────────────────────────────────
      case 'poll_create': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        const question = sanitizeText(msg.question, 150);
        const options = (msg.options || []).slice(0, 4).map(o => sanitizeText(o, 80)).filter(Boolean);
        if (!question || options.length < 2) return;

        const poll = {
          id: uuidv4().substring(0, 8),
          question,
          options,
          votes: new Array(options.length).fill(0),
          voters: {},
          voterNames: {},
          ended: false,
          createdAt: Date.now(),
        };
        room.polls.push(poll);

        const pollData = {
          type: 'poll_created',
          poll: { id: poll.id, question: poll.question, options: poll.options, votes: poll.votes, voterNames: poll.voterNames, ended: false },
        };
        broadcast(room, pollData);
        break;
      }

      case 'poll_vote': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const poll = room.polls.find(p => p.id === msg.pollId && !p.ended);
        if (!poll) return;
        const idx = msg.optionIndex;
        if (idx < 0 || idx >= poll.options.length) return;
        for (const voters of Object.values(poll.voters)) {
          if (voters.includes(clientId)) return;
        }
        poll.votes[idx]++;
        if (!poll.voters[idx]) poll.voters[idx] = [];
        if (!poll.voterNames[idx]) poll.voterNames[idx] = [];
        poll.voters[idx].push(clientId);
        poll.voterNames[idx].push(clientName);

        const updateMsg = { type: 'poll_updated', pollId: poll.id, votes: poll.votes, voterNames: poll.voterNames };
        broadcast(room, updateMsg);
        break;
      }

      case 'poll_end': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        const poll = room.polls.find(p => p.id === msg.pollId && !p.ended);
        if (!poll) return;
        poll.ended = true;
        const endMsg = { type: 'poll_ended', pollId: poll.id, votes: poll.votes, voterNames: poll.voterNames };
        broadcast(room, endMsg);
        break;
      }

      // ─── TIMESTAMPS ─────────────────────────────────────
      case 'timestamp_mark': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const label = sanitizeText(msg.label, 100) || 'Momento marcado';
        const time = parseFloat(msg.time) || 0;
        const ts = {
          id: uuidv4().substring(0, 8),
          time,
          label,
          name: clientName,
          createdAt: Date.now(),
        };
        room.timestamps.push(ts);
        const tsMsg = { type: 'timestamp_marked', timestamp: ts };
        broadcast(room, tsMsg);
        break;
      }

      // ─── COUNTDOWN (Modo Cinema) ────────────────────────
      case 'countdown_start': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;

        // Apenas envia a contagem. O auto-play é tratado pelo content script
        // do host ao receber seconds=0, evitando feedback loop.
        [3, 2, 1, 0].forEach((sec, i) => {
          setTimeout(() => {
            broadcast(room, { type: 'countdown', seconds: sec });
          }, i * 1100);
        });
        break;
      }

      // ─── CONTROLES DO HOST ──────────────────────────────
      case 'kick_user': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        const tid = msg.targetId;
        if (tid === clientId) return;
        const target = room.clients.get(tid);
        if (!target) return;
        const targetName = target.name;
        sendTo(target.ws, { type: 'kicked', message: 'Você foi removido da sala pelo host.' });
        target.ws.close();
        room.clients.delete(tid);
        room.mutedUsers.delete(tid);
        broadcast(room, { type: 'user_left', name: targetName, clientId: tid, kicked: true, participants: getParticipantsList(room) });
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
        const muteMsg = { type: 'user_muted', targetId: tid, targetName: target.name, muted: !wasMuted };
        broadcast(room, muteMsg);
        broadcastParticipants(room);
        break;
      }

      case 'lock_room': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        room.locked = !room.locked;
        const lockMsg = { type: 'room_locked', locked: room.locked };
        broadcast(room, lockMsg);
        break;
      }

      // ─── HOST NAVEGOU PARA OUTRO VÍDEO ──────────────────
      case 'host_navigate': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        const newUrl = sanitizeText(msg.contentUrl, 2000);
        if (!newUrl) return;
        room.contentUrl = newUrl;
        broadcast(room, { type: 'host_navigate', contentUrl: newUrl }, clientId);
        break;
      }

      // ─── PRESENÇA ───────────────────────────────────────
      case 'presence': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const client = room.clients.get(clientId);
        if (!client) return;
        client.status = msg.status === 'away' ? 'away' : 'active';
        broadcastParticipants(room);
        break;
      }

      // ─── SCREEN SHARE (WebRTC signaling) ────────────────
      case 'screen_share_start': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        room.screenShare = true;
        broadcast(room, { type: 'screen_share_started', hostId: clientId }, clientId);
        break;
      }

      case 'screen_share_stop': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        room.screenShare = false;
        broadcast(room, { type: 'screen_share_stopped' }, clientId);
        break;
      }

      case 'rtc_ready': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        // Encaminha para o host
        const host = room.clients.get(room.hostId);
        if (host) sendTo(host.ws, { type: 'rtc_ready', senderId: clientId });
        break;
      }

      case 'rtc_offer': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const target = room.clients.get(msg.targetId);
        if (target) sendTo(target.ws, { type: 'rtc_offer', senderId: clientId, sdp: msg.sdp });
        break;
      }

      case 'rtc_answer': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const target = room.clients.get(msg.targetId);
        if (target) sendTo(target.ws, { type: 'rtc_answer', senderId: clientId, sdp: msg.sdp });
        break;
      }

      case 'rtc_ice': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const target = room.clients.get(msg.targetId);
        if (target) sendTo(target.ws, { type: 'rtc_ice', senderId: clientId, candidate: msg.candidate });
        break;
      }

      // ─── KEEPALIVE ──────────────────────────────────────
      case 'ping': {
        sendTo(ws, { type: 'pong' });
        break;
      }

      default: break;
    }
  }

  // ── Desconexão ──────────────────────────────────────────
  function handleDisconnect() {
    if (currentRoomId) leaveCurrentRoom();
  }

  function leaveCurrentRoom() {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) { currentRoomId = null; return; }

    room.clients.delete(clientId);
    room.mutedUsers.delete(clientId);

    if (room.hostId === clientId) {
      // HOST saiu → fechar sala para todos
      broadcast(room, { type: 'room_closed', reason: 'O host encerrou a sala.' });
      // Desconectar todos os clientes restantes
      room.clients.forEach(({ ws: clientWs }) => {
        try { clientWs.close(); } catch {}
      });
      rooms.delete(currentRoomId);
    } else if (room.clients.size === 0) {
      room.emptyAt = Date.now();
    } else {
      // Participante normal saiu — apenas notificar
      broadcast(room, {
        type: 'user_left',
        clientId,
        name: clientName,
        participants: getParticipantsList(room),
      });
    }

    currentRoomId = null;
  }
});

// ── Limpeza de salas inativas ────────────────────────────────
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, id) => {
    if (room.clients.size === 0 && room.emptyAt && now - room.emptyAt > 5 * 60 * 1000) {
      rooms.delete(id);
    }
  });
}, 60_000);

// ── Iniciar ─────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎬 Cineminha Server v3.0 rodando na porta ${PORT}`);
  console.log(`   Acesse: http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}\n`);
});
