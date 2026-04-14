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
  room.clients.forEach(({ name, status }, id) => {
    list.push({
      id,
      name,
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

// ── Servidor HTTP (health check) ────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    name: 'Cineminha Server',
    status: 'online',
    version: '3.0.0',
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
          clients: new Map([[clientId, { ws, name: clientName, status: 'active', joinedAt: Date.now() }]]),
          state: { currentTime: 0, playing: false, updatedAt: Date.now() },
          createdAt: Date.now(),
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
        room.clients.set(clientId, { ws, name: clientName, status: 'active', joinedAt: Date.now() });

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
        room.clients.set(clientId, { ws, name: clientName, status: 'active', joinedAt: Date.now() });
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
        broadcast(room, {
          type: 'chat',
          clientId,
          name: clientName,
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
        const reactionMsg = { type: 'reaction', name: clientName, emoji: msg.emoji, senderId: clientId };
        broadcast(room, reactionMsg);
        sendTo(ws, reactionMsg);
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
        sendTo(ws, pollData);
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
        sendTo(ws, updateMsg);
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
        sendTo(ws, endMsg);
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
        sendTo(ws, tsMsg);
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
            const cdMsg = { type: 'countdown', seconds: sec };
            broadcast(room, cdMsg);
            sendTo(ws, cdMsg);
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
        sendTo(ws, muteMsg);
        broadcastParticipants(room);
        break;
      }

      case 'lock_room': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        room.locked = !room.locked;
        const lockMsg = { type: 'room_locked', locked: room.locked };
        broadcast(room, lockMsg);
        sendTo(ws, lockMsg);
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

    broadcast(room, {
      type: 'user_left',
      clientId,
      name: clientName,
      participants: getParticipantsList(room),
    });

    if (room.clients.size === 0) {
      room.emptyAt = Date.now();
    } else if (room.hostId === clientId) {
      const [newHostId, newHost] = room.clients.entries().next().value;
      room.hostId = newHostId;
      broadcast(room, { type: 'new_host', clientId: newHostId, name: newHost.name });
      sendTo(newHost.ws, { type: 'new_host', clientId: newHostId, name: newHost.name, isMe: true });
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
