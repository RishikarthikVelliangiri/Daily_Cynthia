import { beforeAll, describe, expect, it } from 'vitest';
import { Battle, toID } from '@pkmn/sim';
import { type GameData, loadGameDataFromDisk } from '../data';
import { applyRomOverrides, cynthiaSets, dex, romShowdownDiffs } from './showdown';

let data: GameData;
beforeAll(async () => { data = await loadGameDataFromDisk(); });

describe('ROM vs Showdown', () => {
  it('only known differences exist, and overrides remove them', () => {
    expect(romShowdownDiffs(data)).toEqual([
      'move Hypnosis: acc 70/60 (ROM/Showdown)',
      'move Endure: priority 3/4 (ROM/Showdown)',
    ]);
    applyRomOverrides(data);
    expect(romShowdownDiffs(data)).toEqual([]);
    expect(dex.moves.get('hypnosis').accuracy).toBe(70);
  });

  it("Cynthia's sets are her ROM team at the configured level", () => {
    const sets = cynthiaSets(data, 76);
    expect(sets.map(s => s.species)).toEqual(['Spiritomb', 'Roserade', 'Gastrodon', 'Lucario', 'Milotic', 'Garchomp']);
    expect(sets.every(s => s.level === 76)).toBe(true);
    expect(sets[5].item).toBe('sitrusberry');
    expect(sets[5].moves).toEqual(['dragonrush', 'earthquake', 'brickbreak', 'gigaimpact']);
    expect(cynthiaSets(data, null).map(s => s.level)).toEqual([61, 60, 60, 63, 63, 66]);
    for (const s of sets) expect(dex.abilities.get(s.ability).exists).toBe(true);
  });
});

describe('Gen 4 mechanics via Showdown', () => {
  const mk = (species: string, moves: string[], ability: string, level = 50) => ({
    name: species, species, level, moves, ability: toID(ability), item: '', nature: 'Hardy', gender: '',
    evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  });
  const duel = (a: any, b: any, seed = [1, 2, 3, 4]) => {
    const btl = new Battle({ formatid: 'gen4customgame' as any, seed: seed as any });
    btl.setPlayer('p1', { name: 'A', team: [a] });
    btl.setPlayer('p2', { name: 'B', team: [b] });
    return btl;
  };

  it('Levitate makes Ground moves miss; type immunities hold', () => {
    const b = duel(mk('Garchomp', ['earthquake'], 'Sand Veil'), mk('Gengar', ['shadowball'], 'Levitate'));
    b.choose('p1', 'move 1'); b.choose('p2', 'move 1');
    expect(b.log.join('\n')).toMatch(/-immune\|p2a: Gengar/);
    expect(b.p2.active[0].hp).toBe(b.p2.active[0].maxhp);
  });

  it('damage calc matches the Gen 4 formula range (Lv50 Garchomp Dragon Claw vs Lv50 Blissey)', () => {
    // Garchomp Atk = floor((2*130+31)*50/100)+5 = 150; Blissey Def = floor((2*10+31)*50/100)+5 = 30.
    // base = floor(floor(22*80*150/30)/50) + 2 = 178; random 85..100 -> 151..178; STAB x1.5 -> [226, 267]
    const seen = new Set<number>();
    for (let s = 1; s <= 40; s++) {
      const b = duel(mk('Garchomp', ['dragonclaw'], 'Sand Veil'), mk('Blissey', ['softboiled'], 'Natural Cure'), [s, s + 1, s + 2, s + 3]);
      b.choose('p1', 'move 1'); b.choose('p2', 'move 1');
      const line = b.log.find(l => l.startsWith('|-crit|'));
      const dmgLine = b.log.find(l => l.startsWith('|-damage|p2a: Blissey'));
      if (line || !dmgLine) continue;
      const hp = b.p2.active[0];
      const dealt = hp.maxhp - Number(dmgLine.split('|')[3].split('/')[0]);
      seen.add(dealt);
    }
    for (const d of seen) { expect(d).toBeGreaterThanOrEqual(226); expect(d).toBeLessThanOrEqual(267); }
    expect(seen.size).toBeGreaterThan(3);
  });
});
