import type { GameData, Move } from '../data';

/** Deterministic 32-bit PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** UTC calendar date -> YYYYMMDD. Same everywhere on Earth for a given UTC day. */
export function seedFromDate(d: Date): number {
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// National Dex legendaries and mythicals, Gen 1-4 (game knowledge; not stored in the ROM).
export const LEGENDARY = new Set([
  144, 145, 146, 150, 151, 243, 244, 245, 249, 250, 251, 377, 378, 379, 380, 381, 382, 383, 384, 385, 386,
  480, 481, 482, 483, 484, 485, 486, 487, 488, 489, 490, 491, 492, 493,
]);

// Moves that fail or do nothing on their own in a level-76 single battle with no items:
// Sketch, Snore/Sleep Talk/Nightmare/Dream Eater (need sleep), Fling/Natural Gift (need an item),
// Spit Up/Swallow (need Stockpile), Teleport (fails vs trainers), Splash, Struggle.
export const BANNED_MOVES = new Set([166, 173, 214, 171, 138, 374, 363, 255, 256, 100, 150, 165]);
// Damaging category but not a dependable attack: Counter, Mirror Coat, Metal Burst, Bide.
const REACTIVE = new Set([68, 243, 368, 117]);

export const isDamaging = (m: Move) => m.category !== 'Status' && !REACTIVE.has(m.id);

export interface GenOptions {
  level: number;
  minDamagingMoves: number;
  evs: number; // per stat
}
// 85 EVs per stat = the Gen 4 cap of 510 spread evenly: a "trained" level-76 team. With 0 EVs the greedy bot
// won 5% of battles vs. 18% with 85 (scripts/tune.ts, 40 seeds), so most days needed rerolls.
export const DEFAULT_OPTIONS: GenOptions = { level: 76, minDamagingMoves: 2, evs: 85 };

export interface GenMon {
  species: number; // national dex = ROM id
  level: number;
  ability: string;
  moves: number[]; // ROM move ids
  gender: 'M' | 'F' | 'N';
  nature: 'Hardy';
  ivs: number;
  evs: number;
}

/** Pre-evolution chain (self first) using ROM evolution data. */
export function chain(data: GameData, species: number): number[] {
  const out = [species];
  for (let cur = species; ;) {
    const pre = data.evolutions.findIndex((evos, i) => i <= 493 && evos.some(e => e.target === cur));
    if (pre <= 0) return out;
    out.push(pre);
    cur = pre;
  }
}

/** Fully evolved (no evolution into a Gen 1-4 species), non-legendary, National Dex 1-493. */
export function buildPool(data: GameData): number[] {
  const pool: number[] = [];
  for (let s = 1; s <= 493; s++) {
    if (LEGENDARY.has(s)) continue;
    if (data.evolutions[s].some(e => e.target >= 1 && e.target <= 493)) continue;
    pool.push(s);
  }
  return pool;
}

/** Moves the species can legally know at `level` in Diamond: own + pre-evolution level-up (<= level),
 * TM/HM compatibility along the chain, and egg moves of the base form. */
export function legalMoves(data: GameData, species: number, level: number): number[] {
  const set = new Set<number>();
  const ch = chain(data, species);
  for (const s of ch) {
    for (const [lv, m] of data.learnsets[s].levelUp) if (lv <= level) set.add(m);
    for (const m of data.learnsets[s].tm) set.add(m);
  }
  for (const m of data.learnsets[ch[ch.length - 1]].egg) set.add(m);
  for (const m of BANNED_MOVES) set.delete(m);
  set.delete(0);
  return [...set].sort((a, b) => a - b);
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Returns null if the species cannot satisfy the move constraints. */
export function generateMon(data: GameData, species: number, rng: () => number, opts: GenOptions): GenMon | null {
  const legal = legalMoves(data, species, opts.level);
  const dmg = legal.filter(m => isDamaging(data.moves[m]));
  if (dmg.length < Math.min(opts.minDamagingMoves, 1) || legal.length < 1) return null;
  const moves: number[] = [];
  const take = (from: number[]) => {
    const left = from.filter(m => !moves.includes(m));
    if (left.length) moves.push(pick(rng, left));
  };
  for (let i = 0; i < Math.min(opts.minDamagingMoves, dmg.length); i++) take(dmg);
  while (moves.length < Math.min(4, legal.length)) take(legal);
  const sp = data.species[species];
  const g = sp.genderRatio;
  const gender = g === 255 ? 'N' : g === 254 ? 'F' : g === 0 ? 'M' : rng() * 254 < g ? 'F' : 'M';
  return { species, level: opts.level, ability: pick(rng, sp.abilities), moves, gender, nature: 'Hardy', ivs: 31, evs: opts.evs };
}

/** Six distinct species for the given seed. Deterministic: same seed + same ROM data -> same team. */
export function generateTeam(data: GameData, seed: number, opts: GenOptions = DEFAULT_OPTIONS): GenMon[] {
  const rng = mulberry32(seed);
  const pool = buildPool(data);
  const team: GenMon[] = [];
  while (team.length < 6) {
    const s = pick(rng, pool);
    if (team.some(t => t.species === s)) continue;
    const mon = generateMon(data, s, rng, opts);
    if (mon) team.push(mon);
  }
  return team;
}
