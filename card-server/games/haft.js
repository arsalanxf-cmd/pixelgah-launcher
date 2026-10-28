'use strict';
/* Haft Khabis on the server: Iranian crazy eights for 2–4 players */
const { SUITS, newDeck, shuffle, ids } = require('./common');
const kPen = c => c.r === 11 ? 20 : c.r === 12 || c.r === 13 ? 10 : c.r === 14 ? 11 : c.r;

function logic(K) {
  const kTop = () => K.pile[K.pile.length - 1];
  const kNext = (p, steps = 1) => (((p + K.dir * steps) % K.n) + K.n) % K.n;
  function kLegal(p) {
    const h = K.hands[p];
    if (K.pending > 0) return h.filter(c => c.r === 7);
    const t = kTop(); return h.filter(c => c.r === 11 || c.s === K.suit || c.r === t.r);
  }
  function kAI(p) {
    const h = K.hands[p], L = kLegal(p); if (!L.length) return null;
    const nxCnt = K.hands[kNext(p)].length, minOpp = Math.min(...K.hands.map((x, i) => i === p ? 99 : x.length));
    const suitCnt = s => h.filter(c => c.s === s && c.r !== 11).length;
    let best = null, bv = -1e9;
    for (const c of L) {
      let v = kPen(c) * .5 + suitCnt(c.s) * 1.4 + Math.random() * .6;
      if (c.r === 11) v = -20 + (h.length <= 2 ? 60 : 0);
      if (c.r === 8) { const rest = h.filter(x => x !== c); v += rest.some(x => x.r === 11 || x.s === c.s || x.r === 8) ? 9 : (rest.length ? -12 : -30); }
      if (c.r === 7) v += 5 + (nxCnt <= 2 ? 12 : 0);
      if (c.r === 14) v += 4 + (nxCnt <= 2 ? 10 : 0);
      if (c.r === 2) v += 3 + (minOpp <= 2 ? 8 : 0);
      if (c.r === 10) v += 2;
      if (v > bv) { bv = v; best = c; }
    }
    return best;
  }
  function kSuitChoice(p) {
    const h = K.hands[p].filter(c => c.r !== 11); if (!h.length) return SUITS[Math.floor(Math.random() * 4)];
    const sc = s => h.filter(c => c.s === s).reduce((t, c) => t + 1 + kPen(c) / 40, 0);
    return SUITS.slice().sort((a, b) => sc(b) - sc(a))[0];
  }
  function kTarget(p) { return [...Array(K.n).keys()].filter(i => i !== p).sort((a, b) => K.hands[a].length - K.hands[b].length)[0]; }
  return { kTop, kNext, kLegal, kAI, kSuitChoice, kTarget };
}

/* the client's online Haft Khabis reads these events one by one */
module.exports = async function run(room) {
  const n = room.n;
  const K = { n, scores: Array(n).fill(0), round: 0, dealer: Math.floor(Math.random() * n) };
  const L = logic(K);
  const bot = p => room.seats[p].bot;
  async function draw(p, cnt) {
    let got = 0;
    for (let k = 0; k < cnt; k++) {
      if (!K.stock.length) {
        if (K.pile.length < 2) break;
        const top = K.pile.pop(); K.stock = shuffle(K.pile); K.pile = [top];
        room.emit({ t: 'refill', n: K.stock.length });
        await room.sleep(2200);
      }
      const c = K.stock.shift(); K.hands[p].push(c); got++;
      room.emit(i => ({ t: 'draw', seat: p, card: i === p ? c.id : null }));
      await room.sleep(480);
    }
    return got;
  }
  async function play(p, id) {
    const card = K.hands[p].find(c => c.id === id);
    K.hands[p] = K.hands[p].filter(c => c.id !== id); K.pile.push(card);
    room.emit({ t: 'play', seat: p, card: id });
    await room.sleep(950);
    const res = {}, left = K.hands[p].length;
    if (card.r === 11) {
      const s = await room.ask(p, { kind: 'suit' }, () => L.kSuitChoice(p), v => SUITS.includes(v), { turn: false, think: 600, ms: 15000 });
      K.suit = s; room.emit({ t: 'suit', s }); await room.sleep(600);
    } else K.suit = card.s;
    if (card.r === 7) K.pending += 2;
    if (card.r === 8) res.again = true;
    if (card.r === 14) res.skip = 1;
    if (card.r === 10) { if (n === 2) res.skip = 1; else K.dir *= -1; }
    if (card.r === 2) {
      const others = [...Array(n).keys()].filter(i => i !== p);
      const t = await room.ask(p, { kind: 'target', opts: others, counts: K.hands.map(h => h.length) }, () => L.kTarget(p), v => others.includes(v), { turn: false, think: 500, ms: 15000 });
      room.emit({ t: 'give', seat: p, to: t });
      await room.sleep(500);
      await draw(t, 1);
    }
    if (left === 0 && card.r !== 8) res.win = true;
    await room.sleep(card.r === 7 || card.r === 11 ? 500 : 250);
    return res;
  }
  async function turn(p) {
    const hand = () => K.hands[p];
    if (K.pending > 0) {
      const sevens = hand().filter(c => c.r === 7);
      let id = null;
      if (sevens.length) id = await room.ask(p, { kind: 'card', legal: ids(sevens), alt: 'draw', n: K.pending }, () => sevens[0].id, v => v === 'draw' || sevens.some(c => c.id === v));
      else { room.emit({ t: 'turn', seat: p }); await room.sleep(bot(p) ? 850 : 1000); }
      if (!id || id === 'draw') {
        const cnt = K.pending; K.pending = 0;
        room.emit({ t: 'penalty', seat: p, n: cnt });
        await room.sleep(500);
        await draw(p, cnt);
        return {};
      }
      return play(p, id);
    }
    const Lg = L.kLegal(p);
    if (Lg.length) {
      const id = await room.ask(p, { kind: 'card', legal: ids(Lg) }, () => L.kAI(p).id, v => Lg.some(c => c.id === v));
      return play(p, id);
    }
    room.emit({ t: 'turn', seat: p });
    await room.sleep(bot(p) ? 850 : 900);
    const got = await draw(p, 1);
    if (!got) { room.emit({ t: 'stall', seat: p }); await room.sleep(500); return { stall: true }; }
    const c = hand()[hand().length - 1];
    if (L.kLegal(p).some(x => x.id === c.id)) {
      const id = await room.ask(p, { kind: 'card', legal: [c.id], alt: 'keep' }, () => c.id, v => v === 'keep' || v === c.id, { turn: false, think: 400, ms: 15000 });
      if (id !== 'keep') return play(p, id);
    }
    room.emit({ t: 'keep', seat: p });
    await room.sleep(400);
    return {};
  }
  for (;;) {
    K.round++;
    Object.assign(K, { hands: Array.from({ length: n }, () => []), pile: [], stock: [], suit: null, dir: 1, pending: 0, stall: 0 });
    room.newLog();
    room.emit({ t: 'round', round: K.round, dealer: K.dealer, scores: K.scores.slice() });
    const deck = newDeck(), seq = [], got = Array.from({ length: n }, () => []);
    for (const k of [3, 4]) for (let j = 1; j <= n; j++) for (let x = 0; x < k; x++) seq.push((K.dealer + j) % n);
    for (const p of seq) { const c = deck.shift(); K.hands[p].push(c); got[p].push(c.id); }
    K.stock = deck;
    let first;
    for (;;) { first = K.stock.shift(); if ([3, 4, 5, 6, 9, 12, 13].includes(first.r)) break; K.stock.splice(5 + Math.floor(Math.random() * (K.stock.length - 5)), 0, first); }
    K.pile.push(first); K.suit = first.s;
    room.emit(i => ({ t: 'deal', cards: got[i], first: first.id }));
    await room.sleep(seq.length * 75 + 3400);
    let p = L.kNext(K.dealer), w = -1;
    for (;;) {
      const r = await turn(p);
      if (r.win) { w = p; break; }
      K.stall = r.stall ? K.stall + 1 : 0;
      if (K.stall > n * 2) { const pens = K.hands.map(h => h.reduce((t, c) => t + kPen(c), 0)); w = pens.indexOf(Math.min(...pens)); break; }
      if (r.again) continue;
      p = L.kNext(p, 1 + (r.skip || 0));
    }
    const pens = K.hands.map(h => h.reduce((t, c) => t + kPen(c), 0));
    for (let i = 0; i < n; i++) K.scores[i] += pens[i];
    const low = Math.min(...K.scores), over = (Math.max(...K.scores) >= 100 || !!process.env.SHORT_GAMES) && K.scores.filter(x => x === low).length === 1;
    room.emit({ t: 'rend', w, pens, hands: K.hands.map(h => ids(h)), scores: K.scores.slice(), over });
    await room.sleep(8000);
    if (over) {
      const g = K.scores.indexOf(low);
      room.emit({ t: 'over', w: g, scores: K.scores.slice() });
      await room.sleep(500);
      return { winners: [g] };
    }
    K.dealer = (K.dealer + 1) % n;
  }
};
