'use strict';
/* a small JSON store: profiles, login tokens, per-game stats and the daily solitaire table */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');
let db = { profiles: {}, tokens: {}, stats: {}, daily: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* first run */ }

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, FILE);
    } catch (e) { console.error('store: save failed', e.message); }
  }, 1500);
}
function flush() { if (timer) { clearTimeout(timer); timer = null; } try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { } }

const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const cleanName = n => String(n || '').replace(/[\u0000-\u001f<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);

/* returns { profile, token } — a new profile when the token is unknown */
function login(token, name, av) {
  let pid = token && db.tokens[hash(token)];
  let prof = pid && db.profiles[pid];
  if (!prof) {
    token = crypto.randomBytes(24).toString('base64url');
    pid = crypto.randomBytes(6).toString('hex');
    prof = db.profiles[pid] = { pid, name: cleanName(name) || 'مهمان ' + pid.slice(0, 3), av: 0, created: Date.now() };
    db.tokens[hash(token)] = pid;
  }
  const nm = cleanName(name);
  if (nm) prof.name = nm;
  if (Number.isInteger(av) && av >= 0 && av < 8) prof.av = av;
  prof.seen = Date.now();
  save();
  return { profile: prof, token };
}
function setProfile(pid, name, av) {
  const p = db.profiles[pid]; if (!p) return null;
  const nm = cleanName(name); if (nm) p.name = nm;
  if (Number.isInteger(av) && av >= 0 && av < 8) p.av = av;
  save(); return p;
}
const profile = pid => db.profiles[pid];

function statOf(game, pid) {
  const g = db.stats[game] || (db.stats[game] = {});
  return g[pid] || (g[pid] = { p: 0, w: 0, r: 1000 });
}
/* records one finished game: humans = [{pid, won, side}] */
function record(game, humans) {
  for (const h of humans) { const s = statOf(game, h.pid); s.p++; if (h.won) s.w++; }
  // rating only moves when people played against people
  const winners = humans.filter(h => h.won), losers = humans.filter(h => !h.won);
  if (winners.length && losers.length) {
    const avg = a => a.reduce((t, h) => t + statOf(game, h.pid).r, 0) / a.length;
    const rw = avg(winners), rl = avg(losers), exp = 1 / (1 + Math.pow(10, (rl - rw) / 400)), K = 28;
    const d = Math.round(K * (1 - exp));
    for (const h of winners) statOf(game, h.pid).r += d;
    for (const h of losers) statOf(game, h.pid).r = Math.max(100, statOf(game, h.pid).r - d);
  }
  save();
}
function leaderboard(game, limit = 25) {
  const g = db.stats[game] || {};
  return Object.entries(g).filter(([pid, s]) => s.p > 0 && db.profiles[pid])
    .sort((a, b) => b[1].r - a[1].r || b[1].w - a[1].w || a[1].p - b[1].p).slice(0, limit)
    .map(([pid, s]) => ({ pid, name: db.profiles[pid].name, av: db.profiles[pid].av, r: s.r, w: s.w, p: s.p }));
}
function myStats(pid) {
  const out = {};
  for (const [game, g] of Object.entries(db.stats)) if (g[pid]) out[game] = g[pid];
  return out;
}
/* daily solitaire: best score per player per day */
function dailySubmit(day, pid, score, secs, moves) {
  const d = db.daily[day] || (db.daily[day] = {});
  const cur = d[pid];
  if (!cur || score > cur.score || (score === cur.score && secs < cur.secs)) { d[pid] = { score, secs, moves, at: Date.now() }; save(); return true; }
  return false;
}
function dailyBoard(day, limit = 25) {
  const d = db.daily[day] || {};
  // keep only the last two weeks of daily tables
  const days = Object.keys(db.daily).sort(); while (days.length > 14) { delete db.daily[days.shift()]; save(); }
  return Object.entries(d).filter(([pid]) => db.profiles[pid]).sort((a, b) => b[1].score - a[1].score || a[1].secs - b[1].secs).slice(0, limit)
    .map(([pid, s]) => ({ pid, name: db.profiles[pid].name, av: db.profiles[pid].av, score: s.score, secs: s.secs }));
}
module.exports = { login, setProfile, profile, record, leaderboard, myStats, dailySubmit, dailyBoard, flush, cleanName };
