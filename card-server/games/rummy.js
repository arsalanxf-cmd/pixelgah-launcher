'use strict';
/* Rummy on the server: draw, meld sets and runs, lay off, discard; first to empty their hand */
const { SUITS, newDeck, shuffle, ids } = require('./common');
const rv = c => c.r === 14 ? 1 : c.r;
const rPts = c => c.r === 14 ? 1 : c.r > 10 ? 10 : c.r;
const rIsSet = cs => cs.length >= 3 && cs.length <= 4 && cs.every(c => c.r === cs[0].r);
function rIsRun(cs) { if (cs.length < 3 || !cs.every(c => c.s === cs[0].s)) return false; const v = cs.map(rv).sort((a, b) => a - b); return v.every((x, i) => x === v[0] + i); }
function rCanLay(c, m) {
  if (m.type === 'set') return m.cards.length < 4 && c.r === m.cards[0].r;
  if (c.s !== m.cards[0].s) return false;
  const v = m.cards.map(rv), lo = Math.min(...v), hi = Math.max(...v);
  return rv(c) === lo - 1 || rv(c) === hi + 1;
}

function logic(R) {
  function rCands(h) {
    const out = [], byR = {};
    h.forEach(c => (byR[c.r] = byR[c.r] || []).push(c));
    for (const g of Object.values(byR)) if (g.length >= 3) { out.push(g.slice()); if (g.length === 4) for (let i = 0; i < 4; i++) out.push(g.filter((_, j) => j !== i)); }
    for (const s of SUITS) {
      const cs = h.filter(c => c.s === s).sort((a, b) => rv(a) - rv(b));
      for (let i = 0; i < cs.length; i++) { const run = [cs[i]]; for (let j = i + 1; j < cs.length; j++) { if (rv(cs[j]) !== rv(run[run.length - 1]) + 1) break; run.push(cs[j]); if (run.length >= 3) out.push(run.slice()); } }
    }
    return out;
  }
  function rBestMelds(h) {
    const C = rCands(h); let best = { v: 0, set: [] };
    const dfs = (k, used, chosen, v) => {
      if (v > best.v) best = { v, set: chosen.slice() };
      for (let i = k; i < C.length; i++) {
        if (C[i].some(c => used.has(c.id))) continue;
        C[i].forEach(c => used.add(c.id)); chosen.push(C[i]);
        dfs(i + 1, used, chosen, v + C[i].reduce((t, c) => t + rPts(c) + 1, 0));
        chosen.pop(); C[i].forEach(c => used.delete(c.id));
      }
    };
    dfs(0, new Set(), [], 0); return best.set;
  }
  function rKeep(c, h) {
    let v = -rPts(c) * .6;
    for (const x of h) { if (x === c) continue; if (x.r === c.r) v += 7; if (x.s === c.s) { const d = Math.abs(rv(x) - rv(c)); if (d === 1) v += 6; else if (d === 2) v += 3; } }
    if (R.melds.some(m => rCanLay(c, m))) v += 25;
    return v;
  }
  function rAiDraw(p) {
    const top = R.pile[R.pile.length - 1]; if (!top) return 'stock';
    const h = R.hands[p];
    if (rBestMelds(h.concat([top])).some(m => m.includes(top))) return 'disc';
    if (R.melds.some(m => rCanLay(top, m))) return 'disc';
    if (rKeep(top, h.concat([top])) >= 6 && rPts(top) <= 7) return 'disc';
    return R.stock.length || R.pile.length > 1 ? 'stock' : 'disc';
  }
  function rAiDiscard(p, takenId) {
    const h = R.hands[p]; let pool = h.filter(c => c.id !== takenId); if (!pool.length) pool = h.slice();
    return pool.slice().sort((a, b) => rKeep(a, h) - rKeep(b, h))[0];
  }
  function rAiAction(p, takenId) {
    const h = R.hands[p];
    const best = rBestMelds(h);
    if (best.length) return { a: 'meld', cards: ids(best[0]) };
    for (const c of h) { const mi = R.melds.findIndex(m => rCanLay(c, m)); if (mi >= 0) return { a: 'lay', card: c.id, meld: mi }; }
    return { a: 'discard', card: rAiDiscard(p, takenId).id };
  }
  return { rAiDraw, rAiAction };
}

/* the client's online Rummy reads these events one by one */
module.exports = async function run(room) {
  const n = room.n;
  const R = { n, scores: Array(n).fill(0), round: 0, dealer: Math.floor(Math.random() * n) };
  const L = logic(R);
  for (;;) {
    R.round++; R.deal = n === 2 ? 10 : 7;
    Object.assign(R, { hands: Array.from({ length: n }, () => []), pile: [], stock: [], melds: [] });
    room.newLog();
    room.emit({ t: 'round', round: R.round, dealer: R.dealer, scores: R.scores.slice() });
    const deck = newDeck(), seq = [], got = Array.from({ length: n }, () => []);
    for (let r = 0; r < R.deal; r++) for (let j = 1; j <= n; j++) seq.push((R.dealer + j) % n);
    for (const p of seq) { const c = deck.shift(); R.hands[p].push(c); got[p].push(c.id); }
    R.stock = deck; const first = R.stock.shift(); R.pile.push(first);
    room.emit(i => ({ t: 'deal', cards: got[i], first: first.id }));
    await room.sleep(seq.length * 75 + 3400);
    let p = (R.dealer + 1) % n, w = -1, turns = 0;
    round: for (;;) {
      if (++turns > n * 60) break;
      const src = await room.ask(p, { kind: 'draw' }, () => L.rAiDraw(p), v => v === 'stock' || v === 'disc', { ms: 25000 });
      let card, taken = null;
      if (src === 'disc' && R.pile.length) {
        card = R.pile.pop(); taken = card.id;
        room.emit({ t: 'take', seat: p, card: card.id });
      } else {
        if (!R.stock.length) {
          if (R.pile.length < 2) break round;
          const top = R.pile.pop(); R.stock = shuffle(R.pile); R.pile = [top];
          room.emit({ t: 'refill', n: R.stock.length });
          await room.sleep(2200);
        }
        card = R.stock.shift();
        room.emit(i => ({ t: 'draw', seat: p, card: i === p ? card.id : null }));
      }
      R.hands[p].push(card);
      await room.sleep(900);
      for (;;) {
        const hand = R.hands[p];
        const a = await room.ask(p, { kind: 'act', taken }, () => L.rAiAction(p, taken), v => {
          if (!v || typeof v !== 'object') return false;
          if (v.a === 'meld') { if (!Array.isArray(v.cards) || new Set(v.cards).size !== v.cards.length) return false; const cs = v.cards.map(id => hand.find(c => c.id === id)); return cs.every(Boolean) && (rIsSet(cs) || rIsRun(cs)); }
          if (v.a === 'lay') { const c = hand.find(x => x.id === v.card), m = R.melds[v.meld]; return !!c && !!m && rCanLay(c, m); }
          if (v.a === 'discard') return hand.some(c => c.id === v.card) && (v.card !== taken || hand.length === 1);
          return false;
        }, { turn: false, ms: 45000, think: 640 });
        if (a.a === 'meld') {
          const cs = a.cards.map(id => hand.find(c => c.id === id));
          R.hands[p] = hand.filter(c => !a.cards.includes(c.id));
          R.melds.push({ type: rIsSet(cs) ? 'set' : 'run', cards: cs, owner: p });
          room.emit({ t: 'meld', seat: p, cards: a.cards });
          await room.sleep(cs.length * 120 + 900);
        } else if (a.a === 'lay') {
          const c = hand.find(x => x.id === a.card);
          R.hands[p] = hand.filter(x => x.id !== a.card); R.melds[a.meld].cards.push(c);
          room.emit({ t: 'lay', seat: p, card: a.card, meld: a.meld });
          await room.sleep(900);
        } else {
          const c = hand.find(x => x.id === a.card);
          R.hands[p] = hand.filter(x => x.id !== a.card); R.pile.push(c);
          room.emit({ t: 'discard', seat: p, card: a.card });
          await room.sleep(900);
          break;
        }
        if (!R.hands[p].length) break;
      }
      if (!R.hands[p].length) { w = p; break; }
      p = (p + 1) % n;
    }
    const pens = R.hands.map(h => h.reduce((t, c) => t + rPts(c), 0)), gain = w >= 0 ? pens.reduce((t, x, i) => i === w ? t : t + x, 0) : 0;
    if (w >= 0) R.scores[w] += gain;
    const hi = Math.max(...R.scores), over = (hi >= 100 || !!process.env.SHORT_GAMES) && R.scores.filter(x => x === hi).length === 1;
    room.emit({ t: 'rend', w, pens, gain, hands: R.hands.map(h => ids(h)), scores: R.scores.slice(), over });
    await room.sleep(8000);
    if (over) {
      const g = R.scores.indexOf(hi);
      room.emit({ t: 'over', w: g, scores: R.scores.slice() });
      await room.sleep(500);
      return { winners: [g] };
    }
    R.dealer = (R.dealer + 1) % n;
  }
};
