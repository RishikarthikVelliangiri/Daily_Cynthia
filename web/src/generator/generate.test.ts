import { beforeAll, describe, expect, it } from 'vitest';
import { type GameData, loadGameDataFromDisk } from '../data';
import { buildPool, chain, generateTeam, isDamaging, LEGENDARY, legalMoves, seedFromDate, BANNED_MOVES } from './generate';

let data: GameData;
beforeAll(async () => { data = await loadGameDataFromDisk(); });

const byName = (n: string) => data.species.findIndex(s => s.name === n);
const moveId = (n: string) => data.moves.findIndex(m => m.name === n);

describe('generator', () => {
  it('seeds from the UTC date', () => {
    expect(seedFromDate(new Date('2026-10-16T23:59:59Z'))).toBe(20261016);
    expect(seedFromDate(new Date('2026-10-16T23:59:59-05:00'))).toBe(20261017); // already the 17th in UTC
  });

  it('pool: fully evolved, non-legendary, Gen 1-4', () => {
    const pool = buildPool(data);
    expect(pool).toContain(byName('Garchomp'));
    expect(pool).toContain(byName('Tauros')); // single-stage counts as fully evolved
    expect(pool).not.toContain(byName('Gabite'));
    expect(pool).not.toContain(byName('Lickitung')); // evolves in Gen 4
    expect(pool.some(s => LEGENDARY.has(s))).toBe(false);
    expect(Math.max(...pool)).toBeLessThanOrEqual(493);
  });

  it('legal moves include chain level-up, TMs and base-form egg moves', () => {
    const g = byName('Garchomp');
    expect(chain(data, g)).toEqual([445, 444, 443]);
    const lm = legalMoves(data, g, 76);
    for (const n of ['Dragon Claw', 'Earthquake', 'Outrage', 'Dragon Rush']) expect(lm).toContain(moveId(n));
    expect(lm).not.toContain(moveId('Thunderbolt'));
  });

  it('is deterministic per date and differs across dates', () => {
    const a = generateTeam(data, 20261016), b = generateTeam(data, 20261016), c = generateTeam(data, 20261017);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('every team over 1000 seeds satisfies the fairness constraints', () => {
    const pool = new Set(buildPool(data));
    for (let i = 0; i < 1000; i++) {
      const team = generateTeam(data, 20260000 + i);
      expect(team).toHaveLength(6);
      expect(new Set(team.map(t => t.species)).size).toBe(6);
      for (const mon of team) {
        expect(pool.has(mon.species)).toBe(true);
        expect(mon.level).toBe(76);
        expect(new Set(mon.moves).size).toBe(mon.moves.length);
        expect(mon.moves.filter(m => isDamaging(data.moves[m])).length).toBeGreaterThanOrEqual(1);
        const legal = new Set(legalMoves(data, mon.species, 76));
        for (const m of mon.moves) {
          expect(legal.has(m)).toBe(true);
          expect(BANNED_MOVES.has(m)).toBe(false);
        }
        expect(data.species[mon.species].abilities).toContain(mon.ability);
      }
    }
  });
});
