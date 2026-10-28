'use strict';
/* rooms: seats, bots, the game director's ask/emit/sleep, reconnect replay and quick match */
const crypto = require('crypto');
const store = require('./store');

const CLOSED = { closed: true };
const GAMES = {
  hokm: { players: [2, 3, 4], teamsAt: 4, run: require('../games/hokm') },
  shelem: { players: [4], teamsAt: 4, run: require('../games/shelem') },
  pasur: { players: [2, 4], teamsAt: 4, run: require('../games/pasur') },
  hearts: { players: [4], teamsAt: 0, run: require('../games/hearts') },
  haft: { players: [2, 3, 4], teamsAt: 0, run: require('../games/haft') },
  rummy: { players: [2, 3, 4], teamsAt: 0, run: require('../games/rummy') },
};
const BOT_NAMES = [['امید', 'سینا', 'پویا'], ['آرش', 'بهرام', 'رستم'], ['سیمین', 'نگار', 'شیرین', 'مهسا'], ['کاوه', 'سهراب', 'بابک']];
const QWAIT = +(process.env.QUICK_WAIT || 25000);
const ASK_SCALE = +(process.env.ASK_SCALE || 1);
const rooms = new Map();
const CODE_CH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do c = Array.from({ length: 5 }, () => CODE_CH[crypto.randomInt(CODE_CH.length)]).join(''); while (rooms.has(c));
  return c;
}

class Room {
  constructor(game, n, opts = {}) {
    this.code = newCode(); this.game = game; this.n = n; this.teams = GAMES[game].teamsAt === n;
    this.seats = Array(n).fill(null); this.state = 'wait'; this.host = null; this.quick = !!opts.quick;
    this.logs = []; this.asks = new Map(); this.askSeq = 0; this.sid = 0; this.timers = new Set(); this.closed = false;
    this.created = Date.now(); this.lastHuman = Date.now(); this.games = 0;
    rooms.set(this.code, this);
  }
  humans() { return this.seats.filter(s => s && !s.bot); }
  seatOf(pid) { return this.seats.findIndex(s => s && !s.bot && s.pid === pid); }
  botSeat() {
    // a bot's name matches its face
    const used = new Set(this.seats.filter(Boolean).map(s => s.name));
    const avs = this.seats.filter(Boolean).map(s => s.av);
    const av = [1, 2, 3, 0].sort((a, b) => avs.filter(x => x === a).length - avs.filter(x => x === b).length)[0];
    const name = BOT_NAMES[av].find(x => !used.has(x)) || BOT_NAMES.flat().find(x => !used.has(x)) || 'ربات';
    return { bot: true, name, av, online: true };
  }
  /* seats a player (or reconnects them); returns the seat index or an error string */
  join(client) {
    let i = this.seatOf(client.pid);
    if (i < 0) {
      if (this.state !== 'wait') return 'started';
      i = this.seats.findIndex(s => !s);
      if (i < 0) return 'full';
      this.seats[i] = { pid: client.pid, bot: false, client: null, online: false };
      if (!this.host) this.host = client.pid;
    }
    const s = this.seats[i];
    if (s.client && s.client !== client) { s.client.send({ t: 'kicked', why: 'other' }); s.client.room = null; }
    if (client.room && client.room !== this) client.room.leave(client);
    s.client = client; s.online = true; s.name = client.name; s.av = client.av; client.room = this; this.lastHuman = Date.now();
    this.info();
    if (this.state === 'play') this.replay(i);
    return i;
  }
  leave(client) {
    const i = this.seatOf(client.pid);
    if (client.room === this) client.room = null;
    if (i < 0) return;
    const s = this.seats[i];
    if (this.state === 'wait') {
      this.seats[i] = null;
    } else {
      // a bot takes over for the rest of this game
      this.seats[i] = { bot: true, name: s.name, av: s.av, online: true, left: true };
      for (const a of this.asks.values()) if (a.seat === i) a.auto();
      this.emit({ t: 'seat', seat: i, bot: true });
    }
    if (this.host === client.pid) { const h = this.humans()[0]; this.host = h ? h.pid : null; }
    if (!this.humans().length) this.close(); else this.info();
  }
  disconnect(client) {
    const i = this.seatOf(client.pid);
    if (i < 0) return;
    const s = this.seats[i];
    if (s.client !== client) return;
    s.client = null; s.online = false; s.offAt = Date.now();
    for (const a of this.asks.values()) if (a.seat === i) a.hurry();
    if (this.state === 'play') this.emit({ t: 'seat', seat: i, online: false });
    this.info();
  }
  addBot() { const i = this.seats.findIndex(s => !s); if (i < 0) return false; this.seats[i] = this.botSeat(); this.info(); return true; }
  kick(i) { const s = this.seats[i]; if (!s || this.state !== 'wait') return; if (!s.bot && s.client) { s.client.send({ t: 'kicked', why: 'host' }); s.client.room = null; } this.seats[i] = null; this.info(); }
  info() {
    const hostSeat = this.seatOf(this.host);
    this.seats.forEach((s, i) => {
      if (!s || s.bot || !s.client) return;
      s.client.send({
        t: 'room', code: this.code, game: this.game, n: this.n, teams: this.teams, state: this.state, quick: this.quick, me: i, host: hostSeat,
        seats: this.seats.map(x => x && { name: x.name, av: x.av, bot: !!x.bot, online: !!x.online }),
      });
    });
  }
  send(i, msg) { const s = this.seats[i]; if (s && !s.bot && s.client) s.client.send(msg); }
  broadcast(msg) { for (let i = 0; i < this.n; i++) this.send(i, msg); }
  /* game events: x is one event for everyone or a function seat => event (hidden cards) */
  emit(x) {
    for (let i = 0; i < this.n; i++) {
      const ev = typeof x === 'function' ? x(i) : x;
      if (!ev) continue;
      this.logs[i].push(ev);
      this.send(i, { t: 'ev', e: ev });
    }
  }
  newLog() { this.logs = Array.from({ length: this.n }, () => []); }
  startInfo(i) { return { game: this.game, n: this.n, teams: this.teams, me: i, code: this.code, seats: this.seats.map(s => ({ name: s.name, av: s.av, bot: !!s.bot, online: !!s.online })) }; }
  replay(i) {
    const pend = [...this.asks.values()].find(a => a.seat === i);
    this.send(i, { t: 'replay', start: this.startInfo(i), evs: this.logs[i], pending: pend ? pend.id : null });
  }
  /* asks one seat for a decision; bots (and timeouts) answer with ai() */
  ask(seat, req, ai, valid, o = {}) {
    if (this.closed) return Promise.reject(CLOSED);
    const s = this.seats[seat];
    if (o.turn !== false) this.emit({ t: 'turn', seat });
    if (s.bot) return this.sleep((o.think ?? 850) * (0.75 + Math.random() * 0.5)).then(() => ai());
    const id = ++this.askSeq, ms = Math.round((o.ms || 25000) * ASK_SCALE);
    const msg = { t: 'ask', id, ms, ...req };
    this.logs[seat].push(msg); this.send(seat, msg);
    return new Promise((res, rej) => {
      const a = { id, seat, done: false, rej };
      const finish = v => { if (a.done) return; a.done = true; clearTimeout(a.tm); this.asks.delete(id); res(v); };
      a.answer = v => { let ok = false; try { ok = valid ? !!valid(v) : true; } catch (e) { ok = false; } finish(ok ? v : ai()); };
      a.auto = () => { let v; try { v = ai(); } catch (e) { a.done = true; this.asks.delete(id); rej(e); return; } finish(v); };
      a.hurry = () => { clearTimeout(a.tm); a.tm = setTimeout(a.auto, 1500); };
      a.tm = setTimeout(a.auto, s.online ? ms + 2000 : 1500);
      this.asks.set(id, a);
    });
  }
  answer(client, id, v) {
    const a = this.asks.get(id); if (!a) return;
    if (this.seatOf(client.pid) !== a.seat) return;
    a.answer(v);
  }
  sleep(ms) {
    if (this.closed) return Promise.reject(CLOSED);
    return new Promise((res, rej) => {
      const t = { rej, h: setTimeout(() => { this.timers.delete(t); this.closed ? rej(CLOSED) : res(); }, ms) };
      this.timers.add(t);
    });
  }
  async start() {
    if (this.state !== 'wait' || this.closed) return;
    for (let i = 0; i < this.n; i++) if (!this.seats[i]) this.seats[i] = this.botSeat();
    this.state = 'play'; this.sid++; this.newLog(); this.games++;
    for (let i = 0; i < this.n; i++) this.send(i, { t: 'start', ...this.startInfo(i) });
    this.info();
    let res = null;
    try { res = await GAMES[this.game].run(this); }
    catch (e) { if (e !== CLOSED) console.error('game error', this.game, e); }
    if (this.closed) return;
    if (res && res.winners) {
      const humans = this.seats.map((s, i) => ({ s, i })).filter(x => !x.s.bot && x.s.pid)
        .map(x => ({ pid: x.s.pid, won: res.winners.includes(x.i) }));
      if (humans.length) store.record(this.game, humans);
    }
    this.asks.clear();
    // back to the waiting room: people who left go, bots stay for a quick rematch
    this.seats = this.seats.map(s => (!s || s.left || (!s.bot && !s.online)) ? null : s);
    this.state = 'wait';
    if (!this.humans().length) { this.close(); return; }
    if (this.seatOf(this.host) < 0) this.host = this.humans()[0].pid;
    this.info();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) { clearTimeout(t.h); try { t.rej(CLOSED); } catch (e) { } }
    this.timers.clear();
    for (const a of this.asks.values()) { clearTimeout(a.tm); try { a.rej(CLOSED); } catch (e) { } }
    this.asks.clear();
    for (const s of this.seats) if (s && !s.bot && s.client) { if (s.client.room === this) s.client.room = null; }
    rooms.delete(this.code);
  }
}

/* ---- quick match: a queue per game and table size ---- */
const queues = new Map();
function queueKey(game, n) { return game + ':' + n; }
function leaveQueue(client) {
  if (!client.queue) return;
  const q = queues.get(client.queue);
  if (q) { const i = q.findIndex(e => e.client === client); if (i >= 0) q.splice(i, 1); queueStatus(client.queue); }
  client.queue = null;
}
function queueStatus(key) {
  const q = queues.get(key) || [];
  const [game, n] = key.split(':');
  for (const e of q) e.client.send({ t: 'queue', game, n: +n, count: q.length, left: Math.max(0, Math.ceil((QWAIT - (Date.now() - q[0].at)) / 1000)) });
}
function quick(client, game, n) {
  leaveQueue(client);
  if (client.room) client.room.leave(client);
  const key = queueKey(game, n), q = queues.get(key) || [];
  q.push({ client, at: Date.now() }); queues.set(key, q); client.queue = key;
  matchQueue(key, false);
}
function matchQueue(key, force) {
  const q = queues.get(key); if (!q || !q.length) return;
  const [game, ns] = key.split(':'), n = +ns;
  while (q.length >= n || (force && q.length)) {
    const group = q.splice(0, n);
    const room = new Room(game, n, { quick: true });
    for (const e of group) { e.client.queue = null; room.join(e.client); }
    room.start();
    force = false;
  }
  queueStatus(key);
}
function quickNow(client) { if (!client.queue) return; const key = client.queue, q = queues.get(key); const i = q.findIndex(e => e.client === client); if (i > 0) { const [e] = q.splice(i, 1); q.unshift(e); } matchQueue(key, true); }

setInterval(() => {
  const now = Date.now();
  for (const [key, q] of queues) {
    if (q.length && now - q[0].at > QWAIT) matchQueue(key, true);
    else if (q.length) queueStatus(key);
  }
  for (const r of rooms.values()) {
    const online = r.humans().some(s => s.online);
    if (online) r.lastHuman = now;
    if (r.state === 'wait') {
      // seats of people who went away while waiting
      r.seats.forEach((s, i) => { if (s && !s.bot && !s.online && now - (s.offAt || 0) > 90000) { r.seats[i] = null; if (r.host === s.pid) { const h = r.humans().find(x => x.online); r.host = h ? h.pid : null; } r.info(); } });
      if (!r.humans().length) r.close();
    }
    if (now - r.lastHuman > 180000) r.close();
  }
}, 5000).unref();

module.exports = { Room, GAMES, rooms, quick, quickNow, leaveQueue, CLOSED };
