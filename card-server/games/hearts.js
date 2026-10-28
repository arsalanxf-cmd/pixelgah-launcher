'use strict';
/* Hearts (del) on the server: pass three, avoid hearts and the queen of spades */
const { ALL52, newDeck, ids } = require('./common');
const QS = 'S12';
const dPts = c => c.s === 'H' ? 1 : (c.id === QS ? 13 : 0);
const dPassTo = (i, dir) => dir === 0 ? (i + 3) % 4 : dir === 1 ? (i + 1) % 4 : (i + 2) % 4;

function logic(D) {
  function dLegal(p) {
    const h = D.hands[p], first = D.tricksPlayed === 0;
    if (!D.trick.length) {
      if (first) return h.filter(c => c.id === 'C2');
      if (!D.broken) { const nh = h.filter(c => c.s !== 'H'); if (nh.length) return nh; }
      return h.slice();
    }
    const lead = D.trick[0].card.s, f = h.filter(c => c.s === lead);
    if (f.length) return f;
    if (first) { const safe = h.filter(c => dPts(c) === 0); if (safe.length) return safe; }
    return h.slice();
  }
  function dWinner(tr) { const lead = tr[0].card.s; let b = tr[0]; for (const t of tr) if (t.card.s === lead && t.card.r > b.card.r) b = t; return b; }
  function dUnseen(p) { const mine = new Set(D.hands[p].map(c => c.id)); return ALL52.filter(c => !D.gone.has(c.id) && !mine.has(c.id)); }
  function dPassPick(p) {
    const h = D.hands[p], len = s => h.filter(c => c.s === s).length, spades = len('S');
    const danger = c => c.id === QS ? 100 : (c.s === 'S' && c.r > 12 ? (spades < 4 ? 60 : 8) : c.s === 'H' ? (c.r >= 10 ? 30 + c.r : c.r) : c.r + (5 - len(c.s)) * 3);
    return h.slice().sort((a, b) => danger(b) - danger(a)).slice(0, 3);
  }
  function dAI(p) {
    const L = dLegal(p); if (L.length === 1) return L[0];
    const desc = a => a.slice().sort((x, y) => y.r - x.r);
    const qsOut = !D.gone.has(QS) && !D.hands[p].some(c => c.id === QS);
    if (!D.trick.length) {
      let c = L.filter(x => x.id !== QS && !(x.s === 'S' && x.r > 12 && qsOut)); if (!c.length) c = L;
      if (qsOut) { const lowS = c.filter(x => x.s === 'S' && x.r < 12); if (lowS.length) return desc(lowS)[0]; }
      const un = dUnseen(p), safety = s => un.filter(u => u.s === s).length;
      return c.slice().sort((a, b) => (a.r - b.r) - (safety(a.s) - safety(b.s)) * .6)[0];
    }
    const lead = D.trick[0].card.s, cur = dWinner(D.trick), last = D.trick.length === 3, pts = D.trick.reduce((t, x) => t + dPts(x.card), 0);
    if (L[0].s === lead) {
      const under = L.filter(c => c.r < cur.card.r);
      if (lead === 'S' && L.some(c => c.id === QS) && cur.card.r > 12) return L.find(c => c.id === QS);
      if (under.length) return desc(under.filter(c => c.id !== QS).length ? under.filter(c => c.id !== QS) : under)[0];
      if (last && pts === 0) return desc(L.filter(c => c.id !== QS).length ? L.filter(c => c.id !== QS) : L)[0];
      const nq = L.filter(c => c.id !== QS); return (nq.length ? desc(nq) : L)[0];
    }
    const q = L.find(c => c.id === QS); if (q) return q;
    if (qsOut) { const hs = L.filter(c => c.s === 'S' && c.r > 12); if (hs.length) return hs[0]; }
    const hearts = L.filter(c => c.s === 'H'); if (hearts.length) return desc(hearts)[0];
    return desc(L)[0];
  }
  return { dLegal, dWinner, dPassPick, dAI };
}

/* mirrored step by step by the client's online Hearts */
module.exports = async function run(room) {
  const D = { scores: [0, 0, 0, 0], round: 0 };
  const L = logic(D);
  for (;;) {
    D.round++; const dir = (D.round - 1) % 4;
    Object.assign(D, { hands: [[], [], [], []], trick: [], taken: [[], [], [], []], broken: false, gone: new Set(), tricksPlayed: 0 });
    room.newLog();
    room.emit({ t: 'round', round: D.round, scores: D.scores.slice() });
    const deck = newDeck(), dealer = (D.round + 3) % 4, seq = [], got = [[], [], [], []];
    for (const k of [4, 4, 5]) for (let j = 1; j <= 4; j++) for (let x = 0; x < k; x++) seq.push((dealer + j) % 4);
    for (const p of seq) { const c = deck.shift(); D.hands[p].push(c); got[p].push(c.id); }
    room.emit(i => ({ t: 'deal', cards: got[i] }));
    await room.sleep(seq.length * 75 + 2600);
    if (dir < 3) {
      // everyone picks three cards at the same time
      const outs = await Promise.all([0, 1, 2, 3].map(i => room.ask(i, { kind: 'select', count: 3, dir }, () => ids(L.dPassPick(i)),
        v => Array.isArray(v) && v.length === 3 && new Set(v).size === 3 && v.every(id => D.hands[i].some(c => c.id === id)), { turn: false, ms: 40000, think: 900 })));
      const cards = outs.map((o, i) => D.hands[i].filter(c => o.includes(c.id)));
      for (let i = 0; i < 4; i++) D.hands[i] = D.hands[i].filter(c => !outs[i].includes(c.id));
      for (let i = 0; i < 4; i++) D.hands[dPassTo(i, dir)].push(...cards[i]);
      room.emit(i => { const from = [0, 1, 2, 3].find(x => dPassTo(x, dir) === i); return { t: 'pass', dir, out: outs[i], got: ids(cards[from]), from }; });
      await room.sleep(4200);
    }
    let leader = D.hands.findIndex(h => h.some(c => c.id === 'C2'));
    for (let t = 0; t < 13; t++) {
      D.trick = [];
      for (let k = 0; k < 4; k++) {
        const p = (leader + k) % 4, legal = L.dLegal(p);
        const id = await room.ask(p, { kind: 'card', legal: ids(legal) }, () => L.dAI(p).id, v => legal.some(c => c.id === v));
        const card = D.hands[p].find(c => c.id === id);
        if (card.s === 'H') D.broken = true;
        D.trick.push({ seat: p, card }); D.gone.add(id); D.hands[p] = D.hands[p].filter(c => c.id !== id);
        room.emit({ t: 'play', seat: p, card: id });
        await room.sleep(k < 3 ? 420 : 300);
      }
      const w = L.dWinner(D.trick), pts = D.trick.reduce((s, x) => s + dPts(x.card), 0);
      D.taken[w.seat].push(...D.trick.map(x => x.card)); D.tricksPlayed++;
      room.emit({ t: 'trick', w: w.seat, pts });
      await room.sleep(3300);
      leader = w.seat;
    }
    const pts = D.taken.map(t => t.reduce((s, c) => s + dPts(c), 0)), moon = pts.findIndex(x => x === 26);
    if (moon >= 0) { for (let i = 0; i < 4; i++) D.scores[i] += i === moon ? 0 : 26; } else for (let i = 0; i < 4; i++) D.scores[i] += pts[i];
    const low = Math.min(...D.scores), over = (Math.max(...D.scores) >= 100 || !!process.env.SHORT_GAMES) && D.scores.filter(x => x === low).length === 1;
    room.emit({ t: 'rend', pts, moon, scores: D.scores.slice(), over });
    await room.sleep(moon >= 0 ? 9500 : 7500);
    if (over) {
      const w = D.scores.indexOf(low);
      room.emit({ t: 'over', w, scores: D.scores.slice() });
      await room.sleep(500);
      return { winners: [w] };
    }
  }
};
