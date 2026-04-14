// ============================================================
// Cineminha — Servidor WebSocket v4.1
// Rate limiting por IP + token bucket; timestamps removidos
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
const HOST_ORPHAN_GRACE_MS = 15_000;
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
    const r = room.readiness.get(id);
    if (!r || r.status === 'ready') return;
    notReady.push({ id, name: client.name, status: r.status, reason: r.reason || null, since: r.since });
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
    name: 'Cineminha Server', status: 'online', version: '4.1.0',
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
    if (!tryConsume()) return;
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
        rooms.set(roomId, {
          id: roomId, hostId: clientId, hostToken,
          clients: new Map([[clientId, { ws, name: clientName, avatar: msg.avatar || '😎', nameColor: msg.nameColor || '#f0f0f5', status: 'active', joinedAt: Date.now() }]]),
          state: { currentTime: 0, playing: false, updatedAt: Date.now() },
          createdAt: Date.now(),
          contentUrl: sanitizeText(msg.contentUrl, 500) || null,
          locked: false, mutedUsers: new Set(), polls: [],
          readiness: new Map(),
          hostOrphanedAt: null, hostOrphanTimer: null,
        });
        currentRoomId = roomId;
        sendTo(ws, {
          type: 'room_created',
          roomId, clientId, hostToken,
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
        room.clients.set(clientId, { ws, name: clientName, avatar: msg.avatar || '😎', nameColor: msg.nameColor || '#f0f0f5', status: 'active', joinedAt: Date.now() });
        sendTo(ws, {
          type: 'room_joined', roomId: msg.roomId, clientId,
          state: room.state,
          participants: getParticipantsList(room),
          isHost: room.hostId === clientId,
          polls: room.polls.filter(p => !p.ended),
          locked: room.locked,
          contentUrl: room.contentUrl,
          notReady: getReadinessList(room),
        });
        if (isMigrating(room)) {
          broadcastParticipants(room);
        } else {
          broadcast(room, {
            type: 'user_joined', clientId, name: clientName,
            participants: getParticipantsList(room),
          }, clientId);
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
        room.clients.set(clientId, { ws, name: clientName, avatar: msg.avatar || '😎', nameColor: msg.nameColor || '#f0f0f5', status: 'active', joinedAt: Date.now() });
        room.hostId = clientId;
        sendTo(ws, {
          type: 'room_joined', roomId: msg.roomId, clientId,
          hostToken: room.hostToken,
          state: room.state, isHost: true,
          participants: getParticipantsList(room),
          polls: room.polls.filter(p => !p.ended),
          locked: room.locked,
          contentUrl: room.contentUrl,
          notReady: getReadinessList(room),
        });
        broadcast(room, { type: 'new_host', clientId, name: clientName }, clientId);
        broadcastParticipants(room);
        break;
      }
      case 'leave_room': { leaveCurrentRoom(); break; }
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
        broadcast(room, { type: 'host_state', currentTime: msg.currentTime, playing: msg.playing, timestamp: Date.now() }, clientId);
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
        broadcast(room, {
          type: 'chat', clientId, name: clientName,
          avatar: sender?.avatar || '😎',
          nameColor: sender?.nameColor || '#f0f0f5',
          message: text, ts: Date.now(),
        });
        break;
      }
      case 'reaction': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const allowed = ['❤️', '😂', '😮', '😢', '🔥', '👏'];
        if (!allowed.includes(msg.emoji)) return;
        broadcast(room, { type: 'reaction', name: clientName, emoji: msg.emoji, senderId: clientId });
        break;
      }
      case 'poll_create': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        const question = sanitizeText(msg.question, 150);
        const options = (msg.options || []).slice(0, 4).map(o => sanitizeText(o, 80)).filter(Boolean);
        if (!question || options.length < 2) return;
        const poll = {
          id: uuidv4().substring(0, 8),
          question, options,
          votes: new Array(options.length).fill(0),
          voters: {}, voterNames: {},
          ended: false, createdAt: Date.now(),
        };
        room.polls.push(poll);
        broadcast(room, {
          type: 'poll_created',
          poll: { id: poll.id, question: poll.question, options: poll.options, votes: poll.votes, voterNames: poll.voterNames, ended: false },
        });
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
        broadcast(room, { type: 'poll_updated', pollId: poll.id, votes: poll.votes, voterNames: poll.voterNames });
        break;
      }
      case 'poll_end': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        const poll = room.polls.find(p => p.id === msg.pollId && !p.ended);
        if (!poll) return;
        poll.ended = true;
        broadcast(room, { type: 'poll_ended', pollId: poll.id, votes: poll.votes, voterNames: poll.voterNames });
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
      case 'host_navigate': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        const newUrl = sanitizeText(msg.contentUrl, 500);
        if (!newUrl) return;
        if (newUrl === room.contentUrl) return;
        room.contentUrl = newUrl;
        room.state.currentTime = 0;
        room.state.playing = false;
        room.state.updatedAt = Date.now();
        room.migrationUntil = Date.now() + MIGRATION_WINDOW_MS;
        room.readiness.clear();
        broadcast(room, { type: 'host_navigate', contentUrl: newUrl });
        broadcastReadiness(room);
        break;
      }
      case 'readiness': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const validStatuses = ['ready', 'ad', 'blocked', 'buffering'];
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
          sendTo(newHost.ws, { type: 'host_promoted', hostToken: room.hostToken });
          broadcast(room, { type: 'new_host', clientId: newHostId, name: newHost.name });
          broadcastParticipants(room);
        }, HOST_ORPHAN_GRACE_MS);
        broadcast(room, { type: 'host_orphaned', graceMs: HOST_ORPHAN_GRACE_MS });
      }
    } else if (room.clients.size === 0) {
      room.emptyAt = Date.now();
    } else if (isMigrating(room)) {
      broadcastParticipants(room);
      broadcastReadiness(room);
    } else {
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

server.listen(PORT, () => {
  console.log(`\n🎬 Cineminha Server v4.1 rodando na porta ${PORT}`);
  console.log(`   HTTP: http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}\n`);
});
