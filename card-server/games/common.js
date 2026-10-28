'use strict';
/* card helpers shared by every game on the server */
const crypto = require('crypto');
const SUITS = ['S', 'H', 'C', 'D'];
const ALL52 = [];
for (const s of SUITS) for (let r = 2; r <= 14; r++) ALL52.push({ s, r, id: s + r });
const byId = Object.fromEntries(ALL52.map(c => [c.id, c]));
/* a fair shuffle with the OS random source */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const newDeck = f => shuffle(ALL52.filter(c => !f || f(c)).map(c => ({ ...c })));
const ids = cs => cs.map(c => c.id);
const rnd = () => crypto.randomInt(1e9) / 1e9;
module.exports = { SUITS, ALL52, byId, shuffle, newDeck, ids, rnd };
