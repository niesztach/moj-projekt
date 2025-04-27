// server.js
const WebSocket = require('ws');
const url = require('url');
const { v4: uuid } = require('uuid');

const PORT = 8081;
const server = new WebSocket.Server({ port: PORT });
console.log(`WebSocket server running on port ${PORT}`);

// Przechowuje wszystkie pokoje: roomId → { players: Map<playerId, {name, ws}>, state, locked }
const games = new Map();

// Tworzy początkowy, dynamiczny stan Yathzee dla podanych graczy
function createInitialState(playerIds) {
  const state = {
    whoseTurn: playerIds[0],
    phase: 'rolling',
    dice: {},
    locked: {},
    rollsLeft: {},
    scorecard: {}
  };
  playerIds.forEach(id => {
    state.dice[id] = Array.from({ length: 5 }, () => Math.floor(Math.random() * 6) + 1);
    state.locked[id]    = [false, false, false, false, false];
    state.rollsLeft[id] = 2;
    state.scorecard[id] = {};
  });
  return state;
}

// Wysyła do wszystkich w pokoju aktualny stan gry
function broadcastState(room) {
  const msg = JSON.stringify({ type: 'stateUpdate', state: room.state });
  for (const { ws } of room.players.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// Wysyła do wszystkich listę graczy w lobby
function broadcastLobby(roomId) {
  const room = games.get(roomId);
  const list = Array.from(room.players.values()).map(p => p.name);
  const msg  = JSON.stringify({ type: 'lobbyUpdate', players: list });
  for (const { ws } of room.players.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

server.on('connection', (ws, req) => {
  const roomId = url.parse(req.url, true).query.room || 'default';
  if (!games.has(roomId)) {
    games.set(roomId, { players: new Map(), state: null, locked: false });
  }
  const room = games.get(roomId);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    const { type, payload } = msg;

    // 1) dołączanie do lobby
    if (type === 'join') {
      // walidacja nazwy
      if (!payload || typeof payload.name !== 'string' || !payload.name.trim()) {
        return ws.send(JSON.stringify({ type: 'error', msg: 'Nieprawidłowa nazwa gracza.' }));
      }
      if (room.locked) {
        return ws.send(JSON.stringify({ type: 'error', msg: 'Gra już się rozpoczęła.' }));
      }
      const name = payload.name.trim();
      const playerId = uuid();
      ws.playerId = playerId;
      room.players.set(playerId, { name, ws });
      // potwierdzenie
      ws.send(JSON.stringify({ type: 'joined', playerId }));
      broadcastLobby(roomId);
    }

    // 2) start gry (tylko pierwszy dołączył może)
    else if (type === 'start') {
      // musimy mieć co najmniej 2 graczy
      const ids = Array.from(room.players.keys());
      if (room.locked || ids.length < 2) return;
      // tylko inicjator (pierwszy) może start
      const initiator = ids[0];
      if (ws.playerId !== initiator) return;
      room.locked = true;
      room.state = createInitialState(ids);
      // wyślij stan startowy
      const msgStart = JSON.stringify({ type: 'gameStart', state: room.state });
      for (const { ws:client } of room.players.values()) {
        if (client.readyState === WebSocket.OPEN) client.send(msgStart);
      }
    }

    // 3) ruchy w trakcie gry
    else if (type === 'roll' || type === 'lock' || type === 'score') {
      if (!room.locked || !room.state) return;
      const state = room.state;
      const me = ws.playerId;
      // roll
      if (type === 'roll') {
        if (me === state.whoseTurn && state.phase === 'rolling' && state.rollsLeft[me] > 0) {
          state.dice[me] = state.dice[me].map((d,i) => state.locked[me][i] ? d : (Math.floor(Math.random()*6)+1));
          state.rollsLeft[me]--;
          if (state.rollsLeft[me] === 0) state.phase = 'scoring';
          broadcastState(room);
        }
      }
      // lock/unlock kostki
      else if (type === 'lock') {
        const i = payload && payload.index;
        if (me === state.whoseTurn && state.phase === 'rolling' && i>=0 && i<5) {
          state.locked[me][i] = !state.locked[me][i];
          broadcastState(room);
        }
      }
      // scoring
      else if (type === 'score') {
        const { category, compute } = payload || {};
        if (me === state.whoseTurn && state.phase === 'scoring' && state.scorecard[me][category] == null) {
          state.scorecard[me][category] = compute;
          // przygotuj następnego gracza
          state.phase = 'rolling';
          state.rollsLeft[me] = 2;
          state.locked[me] = [false,false,false,false,false];
          const players = Object.keys(state.dice);
          const idx = players.indexOf(me);
          state.whoseTurn = players[(idx+1) % players.length];
          broadcastState(room);
        }
      }
    }
  });

  ws.on('close', () => {
    // usuń z pokoju
    if (ws.playerId && room.players.has(ws.playerId)) {
      room.players.delete(ws.playerId);
      broadcastLobby(roomId);
    }
    // jeśli pusty, usuń pokój
    if (room.players.size === 0) {
      games.delete(roomId);
    }
  });
});

console.log(`WebSocket Yahtzee server running on port ${PORT}`);
