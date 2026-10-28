'use strict';
/* Shelem on the server: bidding 100–165, the widow, point cards; tricks are played like Hokm */
const { SUITS, newDeck, ids } = require('./common');
const hokmLogic = require('./hokm').logic;
const TARGET = 505;
const sCardPts = c => c.r === 14 || c.r === 10 ? 10 : c.r === 5 ? 5 : 0;
const sSide = i => i % 2;

function logic(S) {
  function sStrength(p) {
    const h = S.hands[p]; let best = null, bestV = -1;
    for (const t of SUITS) {
      let tr = 0;
      for (const s of SUITS) {
        const cs = h.filter(c => c.s === s).sort((a, b) => b.r - a.r), len = cs.length;
        if (cs.some(c => c.r === 14)) tr += 1;
        if (cs.some(c => c.r === 13) && len >= 2) tr += .6;
        if (cs.some(c => c.r === 12) && len >= 3) tr += .3;
        if (s === t) tr += Math.max(0, len - 3) * .85 + (len >= 5 ? .5 : 0);
        else if (len <= 1 && h.filter(c => c.s === t).length >= 4) tr += .5;
      }
      if (tr > bestV) { bestV = tr; best = t; }
    }
    return { tricks: bestV, trump: best };
  }
  function sMaxBid(p) { const { tricks } = sStrength(p), est = (tricks + 2.6 + .8) * 12.7; return Math.min(165, Math.floor(est / 5) * 5); }
  function sAiBid(p) {
    const cur = S.bid || 95, next = cur + 5, max = sMaxBid(p), partnerHolds = S.bidder >= 0 && sSide(S.bidder) === sSide(p);
    if (next > 165) return 'pass';
    if (partnerHolds && max < cur + 20) return 'pass';
    return max >= Math.max(100, next) ? Math.max(100, next) : 'pass';
  }
  function sAiDiscard(p) {
    const h = S.hands[p], { trump } = sStrength(p), len = s => h.filter(c => c.s === s).length;
    const keep = c => (c.s === trump ? 50 : 0) + (c.r === 14 ? 40 : 0) + (c.r === 13 && len(c.s) >= 2 ? 20 : 0) + c.r + len(c.s) * 2;
    return h.slice().sort((a, b) => keep(a) - keep(b)).slice(0, 4);
  }
  return { sStrength, sAiBid, sAiDiscard };
}

/* mirrored step by step by the client's online Shelem */
module.exports = async function run(room) {
  const S = { n: 4, teams: true, scores: [0, 0], dealer: Math.floor(Math.random() * 4), round: 0 };
  const L = logic(S), HL = hokmLogic(S);
  for (;;) {
    S.round++;
    Object.assign(S, { hands: [[], [], [], []], trick: [], won: [0, 0], pts: [0, 0], gone: new Set(), voids: [0, 0, 0, 0].map(() => new Set()), known: [0, 0, 0, 0].map(() => new Set()), trump: null, bid: 0, bidder: -1, removed: null });
    room.newLog();
    room.emit({ t: 'round', round: S.round, dealer: S.dealer, scores: S.scores.slice() });
    const deck = newDeck(), seq = [], got = [[], [], [], []];
    for (let r = 0; r < 3; r++) for (let j = 1; j <= 4; j++) for (let x = 0; x < 4; x++) seq.push((S.dealer + j) % 4);
    for (const p of seq) { const c = deck.shift(); S.hands[p].push(c); got[p].push(c.id); }
    const widow = deck.splice(0, 4);
    room.emit(i => ({ t: 'deal', cards: got[i] }));
    await room.sleep(seq.length * 75 + 2600 + 1800);
    // bidding: whoever passes is out
    const passed = new Set(); let p = (S.dealer + 1) % 4;
    for (;;) {
      if (passed.size === 4) break;
      if (S.bidder >= 0 && passed.size === 3) break;
      if (passed.has(p)) { p = (p + 1) % 4; continue; }
      const cur = S.bid || 95;
      const b = await room.ask(p, { kind: 'bid', cur: S.bid, bidder: S.bidder }, () => L.sAiBid(p),
        v => v === 'pass' || (Number.isInteger(v) && v % 5 === 0 && v >= Math.max(100, cur + 5) && v <= 165), { think: 780, ms: 20000 });
      if (b === 'pass') passed.add(p); else { S.bid = b; S.bidder = p; }
      room.emit({ t: 'bid', seat: p, b });
      await room.sleep(450);
      p = (p + 1) % 4;
    }
    if (S.bidder < 0) {
      room.emit({ t: 'redeal' });
      await room.sleep(2200);
      S.dealer = (S.dealer + 1) % 4;
      continue;
    }
    const d = S.bidder, ds = sSide(d);
    room.emit({ t: 'declarer', seat: d, bid: S.bid });
    await room.sleep(1300);
    S.hands[d].push(...widow);
    room.emit(i => ({ t: 'widow', cards: i === d ? ids(widow) : null }));
    await room.sleep(4 * 560 + 300);
    const disc = await room.ask(d, { kind: 'select', count: 4 }, () => ids(L.sAiDiscard(d)),
      v => Array.isArray(v) && v.length === 4 && new Set(v).size === 4 && v.every(id => S.hands[d].some(c => c.id === id)), { think: 900, ms: 45000 });
    const dcards = S.hands[d].filter(c => disc.includes(c.id));
    S.hands[d] = S.hands[d].filter(c => !disc.includes(c.id)); disc.forEach(id => S.known[d].add(id));
    room.emit(i => ({ t: 'kitty', seat: d, cards: i === d ? disc : null }));
    await room.sleep(4 * 460 + 300);
    S.trump = await room.ask(d, { kind: 'suit' }, () => L.sStrength(d).trump, v => SUITS.includes(v), { think: 900, ms: 20000 });
    const dp = dcards.reduce((t, c) => t + sCardPts(c), 0) + 5;
    S.pts[ds] += dp;
    room.emit({ t: 'trump', s: S.trump, dp });
    await room.sleep(2600);
    // twelve tricks
    let leader = d;
    for (let t = 0; t < 12; t++) {
      S.trick = [];
      for (let k = 0; k < 4; k++) {
        const pl = (leader + k) % 4, legal = HL.hLegal(pl);
        const id = await room.ask(pl, { kind: 'card', legal: ids(legal) }, () => HL.hAI(pl).id, v => legal.some(c => c.id === v));
        const card = S.hands[pl].find(c => c.id === id);
        if (S.trick.length && card.s !== S.trick[0].card.s) S.voids[pl].add(S.trick[0].card.s);
        S.trick.push({ seat: pl, card }); S.gone.add(id); S.hands[pl] = S.hands[pl].filter(c => c.id !== id);
        room.emit({ t: 'play', seat: pl, card: id });
        await room.sleep(k < 3 ? 420 : 300);
      }
      const w = HL.hWinner(S.trick), ws = sSide(w.seat), tp = S.trick.reduce((a, x) => a + sCardPts(x.card), 0) + 5;
      S.won[ws]++; S.pts[ws] += tp;
      room.emit({ t: 'trick', w: w.seat, pts: tp });
      await room.sleep(3300);
      leader = w.seat;
    }
    // scoring
    const os = 1 - ds, made = S.pts[ds] >= S.bid, shelem = S.won[ds] === 12, delta = [0, 0];
    if (shelem) delta[ds] = 330; else if (made) delta[ds] = S.pts[ds]; else delta[ds] = S.pts[os] > S.pts[ds] ? -2 * S.bid : -S.bid;
    delta[os] = shelem ? 0 : S.pts[os];
    S.scores[0] += delta[0]; S.scores[1] += delta[1];
    const over = (Math.max(...S.scores) >= TARGET || !!process.env.SHORT_GAMES) && S.scores[0] !== S.scores[1];
    room.emit({ t: 'rend', d, bid: S.bid, pts: S.pts.slice(), won: S.won.slice(), delta, scores: S.scores.slice(), made, shelem, over });
    await room.sleep(shelem ? 9500 : 7500);
    if (over) {
      const w = S.scores[0] > S.scores[1] ? 0 : 1;
      room.emit({ t: 'over', w, scores: S.scores.slice() });
      await room.sleep(500);
      return { winners: w === 0 ? [0, 2] : [1, 3] };
    }
    S.dealer = (S.dealer + 1) % 4;
  }
};
