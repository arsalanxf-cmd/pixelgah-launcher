'use strict';
/* Pasur on the server: 2 players, or 4 in teams; capture cards that add up to eleven */
const { ALL52, newDeck, shuffle, ids } = require('./common');
const TARGET = 62;
const pVal = c => c.r === 14 ? 1 : c.r;
const pNum = c => c.r === 14 || c.r <= 10;
const pPts = c => (c.r === 14 ? 1 : 0) + (c.r === 11 ? 1 : 0) + (c.id === 'C2' ? 2 : 0) + (c.id === 'D10' ? 3 : 0);

function logic(P) {
  const pSide = i => P.teams ? i % 2 : i;
  function pOptions(card, table) {
    if (card.r === 11) { const t = table.filter(c => c.r !== 12 && c.r !== 13); return t.length ? [t] : []; }
    if (card.r === 12 || card.r === 13) { const m = table.filter(c => c.r === card.r); return m.map(x => [x]); }
    const nums = table.filter(pNum), need = 11 - pVal(card), out = [];
    const rec = (k, sum, acc) => {
      if (sum === need && acc.length) out.push(acc.slice());
      if (sum >= need || k >= nums.length) return;
      for (let j = k; j < nums.length; j++) { acc.push(nums[j]); rec(j + 1, sum + pVal(nums[j]), acc); acc.pop(); }
    };
    rec(0, 0, []); return out;
  }
  const pWorth = cards => cards.reduce((t, c) => t + pPts(c) + (c.s === 'C' ? .42 : 0) + .07, 0);
  const pIsSur = (card, opt, table) => card.r !== 11 && opt.length === table.length && !P.lastDeal;
  const pSurAllowed = side => P.scores[side] < 50;
  function pBest(card, table, side) {
    const opts = pOptions(card, table); if (!opts.length) return null;
    let best = null, bv = -1e9;
    for (const o of opts) { const v = pWorth(o.concat([card])) + (pIsSur(card, o, table) && pSurAllowed(side) ? 5 : 0); if (v > bv) { bv = v; best = o; } }
    return { opt: best, v: bv };
  }
  function pUnseen(p) { const seen = new Set([...P.hands[p], ...P.table, ...P.gone].map(c => c.id)); return ALL52.filter(c => !seen.has(c.id)); }
  function pRisk(table, p) {
    if (!table.length) return 0;
    const un = pUnseen(p), seenR = new Set(); let worst = 0;
    for (const c of un) {
      if (seenR.has(c.r)) continue; seenR.add(c.r);
      const opts = pOptions(c, table); if (!opts.length) continue;
      let v = 0; for (const o of opts) v = Math.max(v, pWorth(o.concat([c])) + (pIsSur(c, o, table) ? 5 : 0));
      const freq = un.filter(u => u.r === c.r).length / Math.max(1, un.length);
      worst = Math.max(worst, v * Math.min(1, .35 + freq * 6));
    }
    return worst;
  }
  function pAI(p) {
    const side = pSide(p); let best = null, bs = -1e9;
    for (const c of P.hands[p]) {
      const b = pBest(c, P.table, side); let gain, after;
      if (b) { gain = b.v; after = P.table.filter(x => !b.opt.includes(x)); }
      else { gain = -(pPts(c) * 1.2 + (c.s === 'C' ? .3 : 0) + (c.r === 11 ? 2.5 : 0)); after = P.table.concat([c]); }
      const sc = gain - .72 * pRisk(after, p) + (c.r === 11 && b && b.opt.length < 3 ? -1.5 : 0);
      if (sc > bs) { bs = sc; best = { card: c, opt: b ? b.opt : null }; }
    }
    return best;
  }
  function pTally(side) {
    const cards = P.cap[side], clubs = cards.filter(c => c.s === 'C').length, other = P.cap[1 - side].filter(c => c.s === 'C').length;
    const pts = cards.reduce((t, c) => t + pPts(c), 0) + (clubs >= 7 || (clubs > other && clubs + other === 13) ? 7 : 0) + P.surs[side] * 5;
    return { clubs, pts, aces: cards.filter(c => c.r === 14).length, jacks: cards.filter(c => c.r === 11).length, c2: cards.some(c => c.id === 'C2'), d10: cards.some(c => c.id === 'D10'), surs: P.surs[side], count: cards.length };
  }
  return { pSide, pOptions, pWorth, pIsSur, pSurAllowed, pBest, pAI, pTally };
}

/* mirrored step by step by the client's online Pasur */
module.exports = async function run(room) {
  const n = room.n;
  const P = { n, teams: n === 4, scores: [0, 0], dealer: Math.floor(Math.random() * n) };
  const L = logic(P);
  for (;;) {
    Object.assign(P, { deck: newDeck(), hands: Array.from({ length: n }, () => []), table: [], gone: [], cap: [[], []], surs: [0, 0], last: -1, deal: 0, lastDeal: false });
    P.deals = n === 2 ? 6 : 3;
    room.newLog();
    room.emit({ t: 'round', dealer: P.dealer, scores: P.scores.slice() });
    const deal = async first => {
      const seq = [], got = Array.from({ length: n }, () => []);
      for (let k = 1; k <= n; k++) for (let j = 0; j < 4; j++) seq.push((P.dealer + k) % n);
      for (const p of seq) { const c = P.deck.shift(); P.hands[p].push(c); got[p].push(c.id); }
      P.deal++;
      if (!P.deck.length) P.lastDeal = true;
      let four = null;
      if (first) {
        // four face-up cards; a lone jack goes back into the pack, more than one jack or two queens or kings means a reshuffle
        for (;;) {
          const f = P.deck.slice(0, 4), j = f.filter(c => c.r === 11).length, q = f.filter(c => c.r === 12).length, k = f.filter(c => c.r === 13).length;
          if (j > 1 || q > 2 || k > 2) { shuffle(P.deck); continue; }
          P.deck.splice(0, 4);
          if (j === 1) { const jk = f.find(c => c.r === 11); f.splice(f.indexOf(jk), 1, P.deck.shift()); P.deck.splice(4 + Math.floor(Math.random() * (P.deck.length - 4)), 0, jk); }
          four = f; P.table.push(...f); break;
        }
      }
      room.emit(i => ({ t: 'deal', cards: got[i], table: four ? ids(four) : null, last: P.lastDeal, deal: P.deal }));
      await room.sleep(seq.length * 70 + 1800 + (first ? 2600 : 0));
    };
    await deal(true);
    let p = (P.dealer + 1) % n;
    for (;;) {
      if (P.hands.every(h => !h.length)) {
        if (!P.deck.length) break;
        await room.sleep(300);
        await deal(false);
      }
      const m = L.pAI(p), hand = P.hands[p];
      const id = await room.ask(p, { kind: 'card', legal: ids(hand) }, () => m.card.id, v => hand.some(c => c.id === v));
      const card = hand.find(c => c.id === id);
      const opts = L.pOptions(card, P.table);
      let opt = null;
      if (!room.seats[p].bot && opts.length > 1 && card.r !== 11) {
        const side = L.pSide(p);
        const ranked = opts.map(o => ({ o, v: L.pWorth(o) + (L.pIsSur(card, o, P.table) && L.pSurAllowed(side) ? 5 : 0) })).sort((a, b) => b.v - a.v).slice(0, 4);
        const k = await room.ask(p, { kind: 'cap', opts: ranked.map(r => ids(r.o)) }, () => 0, v => Number.isInteger(v) && v >= 0 && v < ranked.length, { turn: false, ms: 20000 });
        opt = ranked[k].o;
      } else if (opts.length) {
        opt = room.seats[p].bot && m.card.id === id && m.opt ? m.opt : (L.pBest(card, P.table, L.pSide(p)) || { opt: opts[0] }).opt;
      }
      P.hands[p] = hand.filter(c => c.id !== id);
      let sur = false;
      if (!opt) {
        P.table.push(card);
      } else {
        const side = L.pSide(p);
        sur = L.pIsSur(card, opt, P.table) && L.pSurAllowed(side);
        P.table = P.table.filter(c => !opt.includes(c)); P.gone.push(card, ...opt); P.cap[side].push(card, ...opt); P.last = p;
        if (sur) { const other = 1 - side; if (P.surs[other] > 0) P.surs[other]--; else P.surs[side]++; }
      }
      room.emit({ t: 'play', seat: p, card: id, cap: opt ? ids(opt) : null, sur });
      await room.sleep(opt ? (sur ? 3400 : 2700) : 1200);
      p = (p + 1) % n;
    }
    if (P.table.length && P.last >= 0) {
      const side = L.pSide(P.last);
      P.cap[side].push(...P.table); P.gone.push(...P.table); P.table = [];
      room.emit({ t: 'sweep', seat: P.last });
      await room.sleep(2200);
    }
    const t = [L.pTally(0), L.pTally(1)];
    for (const s of [0, 1]) P.scores[s] += t[s].pts;
    const over = P.scores[0] !== P.scores[1] && (Math.max(...P.scores) >= TARGET || !!process.env.SHORT_GAMES);
    room.emit({ t: 'rend', tallies: t, scores: P.scores.slice(), over });
    await room.sleep(8500);
    if (over) {
      const w = P.scores[0] > P.scores[1] ? 0 : 1;
      room.emit({ t: 'over', w, scores: P.scores.slice() });
      await room.sleep(500);
      return { winners: [...Array(n).keys()].filter(i => L.pSide(i) === w) };
    }
    P.dealer = (P.dealer + 1) % n;
  }
};
