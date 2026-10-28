'use strict';
/* Hokm on the server: 4 players in teams, or 2 and 3 players head to head */
const { SUITS, ALL52, newDeck, ids } = require('./common');

/* the rules and the bot, taken from the offline game; H is the table state */
function logic(H) {
  const hSide = i => H.teams ? i % 2 : i;
  const sameSideH = (a, b) => hSide(a) === hSide(b);
  function hLegal(p) { const h = H.hands[p]; if (!H.trick.length) return h.slice(); const f = h.filter(c => c.s === H.trick[0].card.s); return f.length ? f : h.slice(); }
  function hBeats(a, b) { if (a.s === b.s) return a.r > b.r; return a.s === H.trump; }
  function hWinner(tr) { let b = tr[0]; for (const t of tr.slice(1)) if (hBeats(t.card, b.card)) b = t; return b; }
  function hUnseen(p) { const mine = new Set(H.hands[p].map(c => c.id)); return ALL52.filter(c => !H.gone.has(c.id) && !mine.has(c.id) && !H.known[p].has(c.id) && c.id !== H.removed); }
  const hMaster = (c, p) => !hUnseen(p).some(u => u.s === c.s && u.r > c.r);
  const hLow = cs => cs.slice().sort((a, b) => (a.s === H.trump) - (b.s === H.trump) || a.r - b.r)[0];
  function hAiTrump(p) { let best = 'S', bv = -1; for (const s of SUITS) { const cs = H.hands[p].filter(c => c.s === s); const v = cs.length * 4 + cs.reduce((t, c) => t + Math.max(0, c.r - 9), 0); if (v > bv) { bv = v; best = s; } } return best; }
  function hAI(p) {
    const L = hLegal(p), h = H.hands[p], Tr = H.trump, n = H.n, partner = n === 4 ? (p + 2) % 4 : -1;
    if (!H.trick.length) {
      const tr = h.filter(c => c.s === Tr), ut = hUnseen(p).filter(c => c.s === Tr).length;
      if (tr.length && ut > 0 && tr.length >= ut - 1) { const m = tr.filter(c => hMaster(c, p)); if (m.length) return m[0]; }
      const opps = [...Array(n).keys()].filter(x => !sameSideH(x, p));
      const ms = h.filter(c => c.s !== Tr && hMaster(c, p) && !opps.some(o => H.voids[o].has(c.s)));
      if (ms.length) return ms.sort((a, b) => b.r - a.r)[0];
      if (partner >= 0) { const pv = h.filter(c => c.s !== Tr && H.voids[partner].has(c.s) && !H.voids[partner].has(Tr)); if (pv.length) return hLow(pv); }
      const side = SUITS.filter(s => s !== Tr).map(s => h.filter(c => c.s === s)).filter(a => a.length).sort((a, b) => b.length - a.length);
      if (side.length) return side[0].slice().sort((a, b) => a.r - b.r)[0];
      return hLow(h);
    }
    const lead = H.trick[0].card.s, cur = hWinner(H.trick), last = H.trick.length === n - 1;
    const after = []; for (let k = 1; k <= n - 1 - H.trick.length; k++) after.push((p + k) % n);
    const oppAfter = after.filter(s => !sameSideH(s, p));
    const wins = L.filter(c => hBeats(c, cur.card));
    const byCost = a => a.slice().sort((x, y) => (x.s === Tr) - (y.s === Tr) || x.r - y.r);
    if (sameSideH(cur.seat, p)) {
      const safe = last || (hMaster(cur.card, p) && (cur.card.s === Tr || !oppAfter.some(o => H.voids[o].has(lead) && !H.voids[o].has(Tr))));
      if (safe) return hLow(L);
      const mw = wins.filter(c => hMaster(c, p) && c.s === lead); return mw.length ? byCost(mw)[0] : hLow(L);
    }
    if (wins.length) {
      if (last || !oppAfter.length) return byCost(wins)[0];
      const mw = wins.filter(c => hMaster(c, p)); if (mw.length) return byCost(mw)[0];
      if (wins[0].s !== lead) return byCost(wins)[0];
      if (H.trick.length >= n - 2) return wins.slice().sort((a, b) => b.r - a.r)[0];
      return hLow(L);
    }
    return hLow(L);
  }
  const hValue = c => (c.s === H.trump ? 10 : 0) + (c.r - 2);
  function hEnd(total) {
    const W = H.won, sides = H.teams ? [0, 1] : [...Array(H.n).keys()];
    if (H.n !== 3) { for (const s of sides) if (W[s] >= 7) return { w: s, kot: sides.every(x => x === s || W[x] === 0) }; return null; }
    if (H.seq.length === 7 && H.seq.every(x => x === H.seq[0])) return { w: H.seq[0], kot: true };
    const played = W.reduce((a, b) => a + b, 0), R = total - played, max = Math.max(...W), leaders = sides.filter(s => W[s] === max);
    if (leaders.length === 1 && sides.every(s => s === leaders[0] || W[s] + R < max)) return { w: leaders[0], kot: false };
    if (R === 0) { if (leaders.length === 1) return { w: leaders[0], kot: false }; const min = Math.min(...W); return { w: sides.find(s => W[s] === min), kot: false }; }
    return null;
  }
  return { hSide, hLegal, hWinner, hAI, hAiTrump, hValue, hEnd };
}

/* the event order here is mirrored by the client's online Hokm, step by step */
module.exports = async function run(room) {
  const n = room.n;
  const H = { n, teams: n === 4, scores: n === 4 ? [0, 0] : Array(n).fill(0), hakem: 0, round: 0 };
  const L = logic(H);
  const sideSeats = s => [...Array(n).keys()].filter(i => L.hSide(i) === s);
  // the first ace dealt picks the hakem
  {
    const d = newDeck(), dealt = Array.from({ length: n }, () => []); let i = 0, h = 0;
    for (const c of d) { dealt[i % n].push(c); if (c.r === 14) { h = i % n; break; } i++; }
    H.hakem = h;
    room.emit({ t: 'hakem', h, shown: dealt.map(cs => cs.length ? cs[cs.length - 1].id : null) });
    await room.sleep(4200);
  }
  for (;;) {
    H.round++;
    H.removed = n === 3 ? 'C2' : null;
    const deck = newDeck(n === 3 ? (c => c.id !== 'C2') : null);
    Object.assign(H, { hands: Array.from({ length: n }, () => []), trick: [], won: Array(H.teams ? 2 : n).fill(0), seq: [], gone: new Set(), voids: Array.from({ length: n }, () => new Set()), trump: null, known: Array.from({ length: n }, () => new Set()) });
    room.newLog();
    room.emit({ t: 'round', round: H.round, hakem: H.hakem, scores: H.scores.slice() });
    const five = deck.splice(0, 5); H.hands[H.hakem] = five.slice();
    room.emit(i => ({ t: 'five', cards: i === H.hakem ? ids(five) : null }));
    await room.sleep(2600);
    H.trump = await room.ask(H.hakem, { kind: 'suit' }, () => L.hAiTrump(H.hakem), v => SUITS.includes(v), { think: 1400, ms: 20000 });
    room.emit({ t: 'trump', s: H.trump });
    await room.sleep(2400);
    if (n === 2) {
      const dealer = 1 - H.hakem;
      for (let j = 0; j < 5; j++) H.hands[dealer].push(deck.shift());
      room.emit(i => ({ t: 'five2', cards: i === dealer ? ids(H.hands[dealer]) : null }));
      await room.sleep(1500);
      const lowest = (p, k) => H.hands[p].slice().sort((a, b) => L.hValue(a) - L.hValue(b)).slice(0, k);
      for (const [p, k] of [[H.hakem, 3], [dealer, 2]]) {
        const v = await room.ask(p, { kind: 'select', count: k }, () => ids(lowest(p, k)),
          v => Array.isArray(v) && v.length === k && new Set(v).size === k && v.every(id => H.hands[p].some(c => c.id === id)), { think: 700, ms: 30000 });
        H.hands[p] = H.hands[p].filter(c => !v.includes(c.id)); v.forEach(id => H.known[p].add(id));
        room.emit(i => ({ t: 'discard', seat: p, k, cards: i === p ? v : null }));
        await room.sleep(k * 430 + 300);
      }
      let p = H.hakem;
      while (deck.length >= 2) {
        const top = deck.shift(), nxt = deck.shift();
        const keep = await room.ask(p, { kind: 'keep', card: top.id }, () => L.hValue(top) >= 8, v => typeof v === 'boolean', { think: 520, ms: 15000 });
        const got = keep ? top : nxt;
        H.hands[p].push(got); H.known[p].add(keep ? nxt.id : top.id);
        room.emit(i => ({ t: 'draw2', seat: p, keep, card: i === p ? got.id : null, top: i === p ? top.id : null }));
        await room.sleep(1250);
        p = 1 - p;
      }
    } else {
      const target = n === 4 ? 13 : 17, seq = [];
      for (let k = 1; k < n; k++) for (let j = 0; j < 5; j++) seq.push((H.hakem + k) % n);
      while (seq.length < n * target - 5) for (let k = 0; k < n; k++) for (let j = 0; j < 4; j++) seq.push((H.hakem + k) % n);
      const got = Array.from({ length: n }, () => []);
      for (const p of seq) { const c = deck.shift(); H.hands[p].push(c); got[p].push(c.id); }
      room.emit(i => ({ t: 'deal', cards: got[i] }));
      await room.sleep(seq.length * 75 + 2600);
    }
    await room.sleep(300);
    let leader = H.hakem, end = null;
    const total = n === 3 ? 17 : 13;
    while (!end) {
      H.trick = [];
      for (let k = 0; k < n; k++) {
        const p = (leader + k) % n, legal = L.hLegal(p);
        const id = await room.ask(p, { kind: 'card', legal: ids(legal) }, () => L.hAI(p).id, v => legal.some(c => c.id === v));
        const card = H.hands[p].find(c => c.id === id);
        if (H.trick.length && card.s !== H.trick[0].card.s) H.voids[p].add(H.trick[0].card.s);
        H.trick.push({ seat: p, card }); H.gone.add(card.id); H.hands[p] = H.hands[p].filter(c => c.id !== id);
        room.emit({ t: 'play', seat: p, card: id });
        await room.sleep(k < n - 1 ? 420 : 300);
      }
      const w = L.hWinner(H.trick), ws = L.hSide(w.seat);
      H.won[ws]++; H.seq.push(ws);
      room.emit({ t: 'trick', w: w.seat });
      await room.sleep(3300);
      end = L.hEnd(total);
      leader = w.seat;
    }
    // scoring: kot is 2, kot of the hakem's side 3
    const ws = end.w, hs = L.hSide(H.hakem), pts = end.kot ? (ws === hs ? 2 : 3) : 1;
    H.scores[ws] += pts;
    const done = H.scores[ws] >= 7 || !!process.env.SHORT_GAMES;
    if (!done && ws !== hs) H.hakem = n === 2 ? 1 - H.hakem : (H.hakem + 1) % n;
    room.emit({ t: 'rend', w: ws, kot: end.kot, pts, scores: H.scores.slice(), won: H.won.slice(), hakem: H.hakem, done });
    await room.sleep(end.kot ? 9500 : 7000);
    if (done) {
      room.emit({ t: 'over', w: ws, scores: H.scores.slice() });
      await room.sleep(500);
      return { winners: sideSeats(ws) };
    }
  }
};
module.exports.logic = logic;
