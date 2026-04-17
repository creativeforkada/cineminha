// ============================================================
// Cineminha — Servidor WebSocket v26.2.0.0
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
        const initialUrl = sanitizeText(msg.contentUrl, 500) || null;
        const initialPlatform = detectPlatform(initialUrl);
        // 🆕 v26.2.1.0 — Modo da sala ('cinema' = sync de plataforma; 'screen' = transmissão de tela)
        const initialMode = (msg.mode === 'screen' || msg.mode === 'cinema') ? msg.mode : 'cinema';
        rooms.set(roomId, {
          id: roomId, hostId: clientId, hostToken,
          clients: new Map([[clientId, { ws, name: clientName, avatar: msg.avatar || '😎', nameColor: sanitizeColor(msg.nameColor), status: 'active', joinedAt: Date.now() }]]),
          state: { currentTime: 0, playing: false, updatedAt: Date.now() },
          createdAt: Date.now(),
          contentUrl: initialMode === 'screen' ? null : initialUrl,
          contentTitle: null,
          platform: initialMode === 'screen' ? null : initialPlatform,
          locked: false, mutedUsers: new Set(),
          readiness: new Map(),
          hostOrphanedAt: null, hostOrphanTimer: null,
          screenShareActive: false,
          screenShareStartedAt: null,
          screenShareHasAudio: false,
          mode: initialMode,
        });
        currentRoomId = roomId;
        sendTo(ws, {
          type: 'room_created',
          roomId, clientId, hostToken,
          platform: initialMode === 'screen' ? null : initialPlatform,
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
          notReady: getReadinessList(room),
          screenShareActive: !!room.screenShareActive,
          screenShareHostName: ssHostClient ? ssHostClient.name : null,
          screenShareHasAudio: !!room.screenShareHasAudio,
          mode: room.mode || 'cinema', // 🆕 v26.2.1.0
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
          notReady: getReadinessList(room),
          mode: room.mode || 'cinema', // 🆕 v26.2.1.0
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
        rooms.delete(currentRoomId);
        currentRoomId = null;
        break;
      }
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
        const hostTime = typeof msg.currentTime === 'number' ? msg.currentTime : room.state.currentTime;
        const hostPlaying = typeof msg.playing === 'boolean' ? msg.playing : room.state.playing;
        room.state.currentTime = hostTime;
        room.state.playing = hostPlaying;
        room.state.updatedAt = Date.now();
        broadcast(room, { type: 'host_state', currentTime: hostTime, playing: hostPlaying, timestamp: Date.now() }, clientId);
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
        const allowed = ['❤️', '😂', '😮', '😢', '🔥', '👏', '🍿', '👀'];
        if (!allowed.includes(msg.emoji)) return;
        broadcast(room, { type: 'reaction', name: clientName, emoji: msg.emoji, senderId: clientId });
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
      case 'change_mode': {
        // 🆕 v26.2.1.0 — Só o host pode trocar o modo
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        const newMode = (msg.mode === 'screen' || msg.mode === 'cinema') ? msg.mode : null;
        if (!newMode || newMode === room.mode) return;
        room.mode = newMode;
        // Mudou pra 'screen': zera conteúdo/plataforma sincronizados
        if (newMode === 'screen') {
          room.contentUrl = null;
          room.contentTitle = null;
          room.platform = null;
          room.readiness.clear();
        }
        broadcast(room, { type: 'mode_changed', mode: newMode, changedBy: clientName });
        if (newMode === 'cinema') broadcastReadiness(room);
        break;
      }
      case 'host_navigate': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;
        if (room.mode === 'screen') return; // 🆕 v26.2.1.0 — nav desabilitada em modo tela
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
        if (room.hostId !== clientId) return;
        if (room.mode === 'screen') return; // 🆕 v26.2.1.0 — sem sync de conteúdo em modo tela
        const title = sanitizeText(msg.title, 200);
        if (!title) return;
        if (room.contentTitle === title) return;
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

server.listen(PORT, () => {
  console.log(`\n🎬 Cineminha Server v26.2.0 rodando na porta ${PORT}`);
  console.log(`   HTTP: http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}\n`);
});
