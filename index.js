// ============================================================
// Cineminha - Servidor WebSocket (server/index.js)
//
// Este servidor gerencia as salas de assistir junto.
// Ele NÃO transmite vídeo — apenas coordena quem faz o quê:
// play, pause, seek, chat.
//
// Deploy gratuito no Render.com, Railway, Fly.io, etc.
// ============================================================

const WebSocket = require('ws');
const http      = require('http');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;

// ── Servidor HTTP básico (necessário para o Render.com) ───────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    name:    'Cineminha Server',
    status:  'online',
    rooms:   rooms.size,
    clients: Array.from(rooms.values()).reduce((acc, r) => acc + r.clients.size, 0),
  }));
});

// ── Servidor WebSocket ────────────────────────────────────────
const wss = new WebSocket.Server({ server });

// ── Estrutura de dados das salas ──────────────────────────────
// rooms: Map<roomId, RoomObject>
// RoomObject: {
//   id:        string,
//   hostId:    string,
//   clients:   Map<clientId, { ws, name }>,
//   state:     { currentTime, playing, updatedAt }
// }
const rooms = new Map();

// ============================================================
//  UTILITÁRIOS
// ============================================================

// Gera um ID de sala curto e legível (8 caracteres alfanuméricos)
function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  // Garante unicidade
  return rooms.has(id) ? generateRoomId() : id;
}

// Envia uma mensagem para um único cliente
function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Envia uma mensagem para todos os clientes de uma sala,
// opcionalmente excluindo um (o remetente)
function broadcast(room, msg, excludeId = null) {
  const data = JSON.stringify(msg);
  room.clients.forEach(({ ws }, clientId) => {
    if (clientId !== excludeId && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

// Retorna a lista de participantes de uma sala
function getParticipantsList(room) {
  return Array.from(room.clients.entries()).map(([id, { name }]) => ({ id, name }));
}

// Limpa salas inativas (sem clientes há mais de 5 minutos)
function cleanupRooms() {
  const now = Date.now();
  rooms.forEach((room, roomId) => {
    if (room.clients.size === 0 && (now - room.createdAt > 300000)) {
      rooms.delete(roomId);
      console.log(`[Sala] Sala ${roomId} removida por inatividade`);
    }
  });
}
setInterval(cleanupRooms, 60000); // Verifica a cada minuto

// ============================================================
//  CONEXÕES
// ============================================================
wss.on('connection', (ws) => {
  const clientId = uuidv4();
  let currentRoomId = null;
  let clientName    = 'Anônimo';

  console.log(`[Cliente] Novo cliente conectado: ${clientId}`);

  // ── Recebe mensagens do cliente ──────────────────────────
  ws.on('message', (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch {
      sendTo(ws, { type: 'error', message: 'Mensagem inválida' });
      return;
    }

    handleMessage(msg);
  });

  // ── Trata desconexão ─────────────────────────────────────
  ws.on('close', () => {
    console.log(`[Cliente] Cliente desconectado: ${clientId} (sala: ${currentRoomId})`);
    handleDisconnect();
  });

  ws.on('error', (err) => {
    console.error(`[Cliente] Erro no cliente ${clientId}:`, err.message);
  });

  // ============================================================
  //  ROTEADOR DE MENSAGENS
  // ============================================================
  function handleMessage(msg) {
    switch (msg.type) {

      // ─── CRIAR SALA ───────────────────────────────────────
      case 'create_room': {
        if (currentRoomId) {
          leaveCurrentRoom();
        }

        const roomId = generateRoomId();
        clientName   = sanitizeName(msg.name);

        rooms.set(roomId, {
          id:        roomId,
          hostId:    clientId,
          clients:   new Map([[clientId, { ws, name: clientName }]]),
          state:     { currentTime: 0, playing: false, updatedAt: Date.now() },
          createdAt: Date.now(),
        });

        currentRoomId = roomId;

        sendTo(ws, {
          type:     'room_created',
          roomId,
          clientId,
          participants: [{ id: clientId, name: clientName }],
        });

        console.log(`[Sala] Sala ${roomId} criada por "${clientName}" (${clientId})`);
        break;
      }

      // ─── ENTRAR NA SALA ───────────────────────────────────
      case 'join_room': {
        const room = rooms.get(msg.roomId);

        if (!room) {
          sendTo(ws, { type: 'error', message: `Sala "${msg.roomId}" não encontrada. Verifique o código.` });
          return;
        }

        if (currentRoomId) {
          leaveCurrentRoom();
        }

        // Se o cliente já estava na sala (reconexão), usa o mesmo clientId
        const rejoiningId = msg.clientId && room.clients.has(msg.clientId) ? msg.clientId : clientId;
        clientName = sanitizeName(msg.name);
        currentRoomId = msg.roomId;

        // Remove a entrada antiga se estiver reconectando
        if (rejoiningId !== clientId) {
          room.clients.delete(rejoiningId);
        }

        room.clients.set(clientId, { ws, name: clientName });

        sendTo(ws, {
          type:         'room_joined',
          roomId:       msg.roomId,
          clientId,
          state:        room.state,
          participants: getParticipantsList(room),
          isHost:       room.hostId === clientId,
        });

        // Avisa os outros que alguém entrou
        broadcast(room, {
          type:     'user_joined',
          clientId,
          name:     clientName,
        }, clientId);

        console.log(`[Sala] "${clientName}" (${clientId}) entrou na sala ${msg.roomId}`);
        break;
      }

      // ─── REJOIN COMO HOST (após reconexão) ───────────────
      case 'rejoin_host': {
        const room = rooms.get(msg.roomId);
        if (!room) return;

        currentRoomId = msg.roomId;
        clientName = sanitizeName(msg.name);
        room.clients.set(clientId, { ws, name: clientName });
        room.hostId = clientId; // Reassume o host

        sendTo(ws, {
          type:     'room_joined',
          roomId:   msg.roomId,
          clientId,
          state:    room.state,
          isHost:   true,
          participants: getParticipantsList(room),
        });

        broadcast(room, {
          type:   'new_host',
          clientId,
          name:   clientName,
        }, clientId);

        console.log(`[Sala] "${clientName}" reconectou como host em ${msg.roomId}`);
        break;
      }

      // ─── SAIR DA SALA ─────────────────────────────────────
      case 'leave_room': {
        leaveCurrentRoom();
        break;
      }

      // ─── PLAY ─────────────────────────────────────────────
      case 'play': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        if (room.hostId !== clientId) {
          sendTo(ws, { type: 'error', message: 'Apenas o host pode controlar a reprodução.' });
          return;
        }

        room.state.currentTime = msg.currentTime || 0;
        room.state.playing     = true;
        room.state.updatedAt   = Date.now();

        broadcast(room, {
          type:        'play',
          currentTime: msg.currentTime || 0,
          timestamp:   Date.now(),
        }, clientId);

        console.log(`[Sala ${currentRoomId}] PLAY @ ${msg.currentTime?.toFixed(1)}s`);
        break;
      }

      // ─── PAUSE ────────────────────────────────────────────
      case 'pause': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;

        room.state.currentTime = msg.currentTime || 0;
        room.state.playing     = false;
        room.state.updatedAt   = Date.now();

        broadcast(room, {
          type:        'pause',
          currentTime: msg.currentTime || 0,
        }, clientId);

        console.log(`[Sala ${currentRoomId}] PAUSE @ ${msg.currentTime?.toFixed(1)}s`);
        break;
      }

      // ─── SEEK ─────────────────────────────────────────────
      case 'seek': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;

        room.state.currentTime = msg.currentTime || 0;
        room.state.updatedAt   = Date.now();

        broadcast(room, {
          type:        'seek',
          currentTime: msg.currentTime || 0,
        }, clientId);

        console.log(`[Sala ${currentRoomId}] SEEK → ${msg.currentTime?.toFixed(1)}s`);
        break;
      }

      // ─── ESTADO DO HOST (para correção de drift) ──────────
      case 'host_state': {
        const room = rooms.get(currentRoomId);
        if (!room || room.hostId !== clientId) return;

        room.state.currentTime = msg.currentTime;
        room.state.playing     = msg.playing;
        room.state.updatedAt   = Date.now();

        // Envia o estado para todos os participantes corrigirem drift
        broadcast(room, {
          type:        'host_state',
          currentTime: msg.currentTime,
          playing:     msg.playing,
          timestamp:   Date.now(),
        }, clientId);
        break;
      }

      // ─── CHAT ─────────────────────────────────────────────
      case 'chat': {
        const room = rooms.get(currentRoomId);
        if (!room) return;

        const text = sanitizeMessage(msg.message);
        if (!text) return;

        // Envia para TODOS (incluindo o remetente, assim ele confirma que foi enviado)
        broadcast(room, {
          type:     'chat',
          clientId,
          name:     clientName,
          message:  text,
          ts:       Date.now(),
        });

        break;
      }

      // ─── PING (keepalive) ─────────────────────────────────
      case 'ping': {
        sendTo(ws, { type: 'pong' });
        break;
      }

      default:
        console.warn(`[Servidor] Tipo de mensagem desconhecido: "${msg.type}"`);
    }
  }

  // ============================================================
  //  DESCONEXÃO / SAÍDA
  // ============================================================
  function handleDisconnect() {
    if (!currentRoomId) return;
    leaveCurrentRoom();
  }

  function leaveCurrentRoom() {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) { currentRoomId = null; return; }

    room.clients.delete(clientId);

    // Avisa os outros que o participante saiu
    broadcast(room, {
      type:     'user_left',
      clientId,
      name:     clientName,
    });

    console.log(`[Sala ${currentRoomId}] "${clientName}" saiu. Restam ${room.clients.size} clientes.`);

    // Se a sala ficou vazia, não deleta imediatamente (aguarda cleanup)
    if (room.clients.size === 0) {
      console.log(`[Sala ${currentRoomId}] Sala vazia, será removida em breve.`);
    }
    // Se o host saiu e ainda há outros, promove um novo host
    else if (room.hostId === clientId) {
      const newHostEntry = room.clients.entries().next().value;
      if (newHostEntry) {
        const [newHostId, { name: newHostName }] = newHostEntry;
        room.hostId = newHostId;
        console.log(`[Sala ${currentRoomId}] Novo host: "${newHostName}" (${newHostId})`);
        broadcast(room, {
          type:     'new_host',
          clientId: newHostId,
          name:     newHostName,
        });
      }
    }

    currentRoomId = null;
  }
});

// ============================================================
//  SANITIZAÇÃO DE DADOS
// ============================================================
function sanitizeName(name) {
  if (!name || typeof name !== 'string') return 'Anônimo';
  return name.trim().substring(0, 30) || 'Anônimo';
}

function sanitizeMessage(msg) {
  if (!msg || typeof msg !== 'string') return '';
  return msg.trim().substring(0, 500);
}

// ============================================================
//  START
// ============================================================
server.listen(PORT, () => {
  console.log(`\n🎬 Cineminha Server rodando na porta ${PORT}`);
  console.log(`   Acesse: http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}\n`);
});
