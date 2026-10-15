'use strict';
// Small seeded PRNG (mulberry32) so a bot run can be replayed from its seed.

function makeRng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.seed = seed;
  /** Integer in [0, n). */
  rng.int = (n) => Math.floor(rng() * n);
  /** Integer in [lo, hi] inclusive. */
  rng.between = (lo, hi) => lo + rng.int(hi - lo + 1);
  rng.pick = (list) => list[rng.int(list.length)];
  rng.chance = (p) => rng() < p;
  /** A shuffled copy. */
  rng.shuffle = (list) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return rng;
}

module.exports = { makeRng };
