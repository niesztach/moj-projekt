// server.js
const WebSocket = require('ws');
const url = require('url');
const { v4: uuid } = require('uuid');

const PORT = 8081;
const server = new WebSocket.Server({ port: PORT });
console.log(`WebSocket server running on port ${PORT}`);

// Przechowuje wszystkie pokoje: roomId → { players: Map<playerId, { id, name, ws }>, state, locked }
const games = new Map();

// Tworzy początkowy stan gry dla podanych playerId
function createInitialState(playerIds) {
  const state = {
    whoseTurn: playerIds[0],
    phase: 'rolling',
    dice: [0, 0, 0, 0, 0],
    locked: [false, false, false, false, false],
    rollsLeft: 3,
    scorecard: {}
  };
  playerIds.forEach(id => {
    state.scorecard[id] = {};
  });
  return state;
}


// Wysyła listę graczy (id + name) do wszystkich w lobby
function broadcastLobby(roomId) {
  const room = games.get(roomId);
  if (!room) return;
  const playersArray = Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name }));
  const msg = JSON.stringify({ type: 'lobbyUpdate', players: playersArray });
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  });
}

// Wysyła aktualny stan gry do wszystkich w pokoju
function broadcastState(roomId) {
  const room = games.get(roomId);
  if (!room || !room.state) return;
  const msg = JSON.stringify({ type: 'stateUpdate', state: room.state });
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  });
}

server.on('connection', (ws, req) => {
  const roomId = url.parse(req.url, true).query.room || 'default';
  if (!games.has(roomId)) {
    games.set(roomId, { players: new Map(), state: null, locked: false });
  }
  const room = games.get(roomId);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload } = msg;

    if (type === 'join') {
      // Nauka dołączenia
      if (room.locked) {
        return ws.send(JSON.stringify({ type: 'error', msg: 'Gra już się rozpoczęła.' }));
      }
      const name = payload.name?.trim();
      if (!name) return ws.send(JSON.stringify({ type: 'error', msg: 'Nieprawidłowa nazwa gracza.' }));
      const playerId = uuid();
      ws.playerId = playerId;
      room.players.set(playerId, { id: playerId, name, ws });
      ws.send(JSON.stringify({ type: 'joined', playerId }));
      broadcastLobby(roomId);
    }
    else if (type === 'reconnect') {
      const { playerId } = payload;
      if (room.players.has(playerId)) {
        const rec = room.players.get(playerId);
        rec.ws = ws;
        ws.playerId = playerId;
        broadcastLobby(roomId);
        if (room.state) {
          ws.send(JSON.stringify({ type: 'stateUpdate', state: room.state }));
        }
      } else {
        ws.send(JSON.stringify({ type: 'error', msg: 'Nie znaleziono gracza w pokoju.' }));
      }
    }
    else if (type === 'start') {
      const ids = Array.from(room.players.keys());
      if (room.locked || ids.length < 2) return;
      if (ws.playerId !== ids[0]) return;
      room.locked = true;
      room.state  = createInitialState(ids);
      const startMsg = JSON.stringify({ type: 'gameStart', state: room.state });
      room.players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(startMsg);
      });
    }
    else if (['roll','lock','score'].includes(type)) {
      if (!room.locked || !room.state) return;
      const stateObj = room.state;
      const me       = ws.playerId;
    
      // === Rzut kostkami ===
      if (type === 'roll') {
        if (stateObj.whoseTurn === me && stateObj.phase === 'rolling' && stateObj.rollsLeft > 0) {
          stateObj.dice = stateObj.dice.map((d, i) =>
            stateObj.locked[i] ? d : Math.floor(Math.random() * 6) + 1
          );
          stateObj.rollsLeft--;
          if (stateObj.rollsLeft === 0) stateObj.phase = 'scoring';
          broadcastState(roomId);
        }
      }
      
    
      // === Zablokowanie / odblokowanie kostki ===
      else if (type === 'lock') {
        const idx = payload.index;
        if (stateObj.whoseTurn === me &&
            stateObj.phase === 'rolling' &&
            idx >= 0 && idx < 5) {
              stateObj.locked[idx] = !stateObj.locked[idx];
          broadcastState(roomId);
        }
      }
    
      // === Zapisanie punktów ===
      else if (type === 'score') {
        const { category, compute } = payload;
        if (stateObj.whoseTurn === me && stateObj.scorecard[me][category] == null) {
          stateObj.scorecard[me][category] = compute;
      
          // Reset tury
          const keys = Array.from(room.players.keys());
          const idx = keys.indexOf(me);
          const next = keys[(idx + 1) % keys.length];
      
          stateObj.whoseTurn = next;
          stateObj.phase = 'rolling';
          stateObj.dice = [0, 0, 0, 0, 0];
          stateObj.locked = [false, false, false, false, false];
          stateObj.rollsLeft = 3;
      
          broadcastState(roomId);
        }
      }
      
    }
    
  });

  // Pozwól na reconnect
  ws.on('close', () => {
    console.log(`Socket zamknięty: ${ws.playerId}`);
    // bez natychmiastowego usuwania — klient może się ponownie połączyć
  });
});
