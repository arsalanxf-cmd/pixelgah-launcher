'use strict';
/* میز ورق — online server: serves the game page and runs every online table over WebSocket */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const store = require('./lib/store');
const { Room, GAMES, rooms, quick, quickNow, leaveQueue } = require('./lib/room');

const PORT = +(process.env.PORT || 3000);
const PUB = path.join(__dirname, 'public');
const REACTS = ['👏', '😂', '😎', '🔥', '😩', '🤝', 'دمت گرم!', 'ایول!', 'بد شانسی 😅', 'زود باش 😄'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

/* the day used by the daily solitaire deal, in Tehran time */
function today() { return new Date(Date.now() + 3.5 * 3600e3).toISOString().slice(0, 10); }
function daySeed(day) { return crypto.createHash('sha256').update('mizevaragh:' + day).digest().readUInt32LE(0); }

/* ---- http: static files, health check and leaderboards ---- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(body); };
  if (url.pathname === '/health') return send(200, 'application/json', JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size }));
  if (url.pathname === '/api/leaderboard') {
    const g = url.searchParams.get('game');
    if (!GAMES[g]) return send(400, 'application/json', '{"error":"game"}');
    return send(200, 'application/json', JSON.stringify(store.leaderboard(g)), { 'Access-Control-Allow-Origin': '*' });
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) return send(403, 'text/plain', 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(404, 'text/plain', 'not found');
    const ext = path.extname(file);
    send(200, TYPES[ext] || 'application/octet-stream', data, { 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=604800' });
  });
});

/* ---- websocket ---- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const clients = new Set();

wss.on('connection', (ws, req) => {
  const client = {
    ws, pid: null, name: '', av: 0, room: null, queue: null, alive: true, bucket: 40, lastReact: 0,
    send(m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
  };
  clients.add(client);
  ws.on('pong', () => { client.alive = true; });
  ws.on('message', raw => {
    // a simple token bucket against floods
    if (client.bucket <= 0) return; client.bucket--;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(client, m); } catch (e) { console.error('handler error', m.t, e); }
  });
  ws.on('close', () => {
    clients.delete(client);
    leaveQueue(client);
    if (client.room) client.room.disconnect(client);
  });
});
setInterval(() => { for (const c of clients) c.bucket = Math.min(40, c.bucket + 20); }, 1000).unref();
setInterval(() => {
  for (const c of clients) { if (!c.alive) { try { c.ws.terminate(); } catch (e) { } continue; } c.alive = false; try { c.ws.ping(); } catch (e) { } }
}, 25000).unref();

function findSeated(pid) { for (const r of rooms.values()) if (r.seatOf(pid) >= 0) return r; return null; }
function validGame(game, n) { const g = GAMES[game]; return g && g.players.includes(n); }

function handle(c, m) {
  if (m.t === 'hello') {
    const { profile, token } = store.login(typeof m.token === 'string' ? m.token : '', m.name, Number.isInteger(m.av) ? m.av : undefined);
    Object.assign(c, { pid: profile.pid, name: profile.name, av: profile.av });
    c.send({ t: 'welcome', token, pid: profile.pid, name: profile.name, av: profile.av, stats: store.myStats(profile.pid), day: today() });
    const r = findSeated(c.pid);
    if (r) r.join(c);
    return;
  }
  if (!c.pid) return;
  const r = c.room, me = r ? r.seatOf(c.pid) : -1, isHost = r && r.host === c.pid;
  switch (m.t) {
    case 'ping': c.send({ t: 'pong', at: m.at }); break;
    case 'profile': {
      const p = store.setProfile(c.pid, m.name, Number.isInteger(m.av) ? m.av : undefined);
      if (p) { c.name = p.name; c.av = p.av; c.send({ t: 'me', name: p.name, av: p.av }); if (r && r.state === 'wait' && me >= 0) { r.seats[me].name = p.name; r.seats[me].av = p.av; r.info(); } }
      break;
    }
    case 'create': {
      const n = +m.n; if (!validGame(m.game, n)) return c.send({ t: 'err', code: 'game' });
      leaveQueue(c); if (r) r.leave(c);
      const room = new Room(m.game, n); room.join(c);
      break;
    }
    case 'join': {
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
      const room = rooms.get(code);
      if (!room) return c.send({ t: 'err', code: 'nf' });
      if (room === r) return room.info();
      leaveQueue(c);
      const res = room.join(c);
      if (typeof res === 'string') c.send({ t: 'err', code: res });
      break;
    }
    case 'leave': leaveQueue(c); if (r) r.leave(c); c.send({ t: 'left' }); break;
    case 'addbot': if (isHost && r.state === 'wait') r.addBot(); break;
    case 'kick': if (isHost && r.state === 'wait' && Number.isInteger(m.seat) && m.seat !== me) r.kick(m.seat); break;
    case 'start': if (isHost && r.state === 'wait') r.start(); break;
    case 'quick': { const n = +m.n; if (!validGame(m.game, n)) return c.send({ t: 'err', code: 'game' }); quick(c, m.game, n); break; }
    case 'quicknow': quickNow(c); break;
    case 'unqueue': leaveQueue(c); c.send({ t: 'left' }); break;
    case 'ans': if (r && Number.isInteger(m.id)) r.answer(c, m.id, m.v); break;
    case 'resync': if (r && me >= 0 && r.state === 'play') r.replay(me); break;
    case 'react': {
      if (!r || me < 0 || !REACTS.includes(m.x)) return;
      const now = Date.now(); if (now - c.lastReact < 1200) return; c.lastReact = now;
      r.broadcast({ t: 'react', seat: me, x: m.x });
      break;
    }
    case 'lb': if (GAMES[m.game]) c.send({ t: 'lb', game: m.game, rows: store.leaderboard(m.game), mine: store.myStats(c.pid)[m.game] || null }); break;
    case 'daily': { const day = today(); c.send({ t: 'daily', day, seed: daySeed(day), rows: store.dailyBoard(day) }); break; }
    case 'dailyScore': {
      const day = today();
      if (m.day !== day) return;
      const score = Math.max(0, Math.min(20000, Math.floor(+m.score || 0))), secs = Math.max(1, Math.floor(+m.secs || 0)), moves = Math.max(0, Math.floor(+m.moves || 0));
      if (secs < 25) return; // too fast to be a real game
      store.dailySubmit(day, c.pid, score, secs, moves);
      c.send({ t: 'daily', day, seed: daySeed(day), rows: store.dailyBoard(day) });
      break;
    }
  }
}

server.listen(PORT, () => console.log(`میز ورق: listening on :${PORT}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });
