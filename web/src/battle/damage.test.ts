import { beforeAll, describe, expect, it } from 'vitest';
import { Battle, type Pokemon, type PokemonSet } from '@pkmn/sim';
import { type GameData, loadGameDataFromDisk } from '../data';
import { generateTeam } from '../generator/generate';
import { romDamageRolls, type RomMon, romStat } from './romdamage';
import { applyRomOverrides, applyRomTypeOrder, cynthiaSets, playerSet, psMove } from './showdown';

let data: GameData;
beforeAll(async () => { data = await loadGameDataFromDisk(); applyRomOverrides(data); });

const STATS = ['atk', 'def', 'spa', 'spd'] as const;
// Variable power (callbacks / ROM power 1) and typeless delayed hits are outside the plain formula.
const SKIP = new Set([248, 353]); // Future Sight, Doom Desire

function asRom(p: Pokemon): RomMon {
  const st = p.storedStats;
  return {
    species: p.species.num, level: p.level, ability: p.getAbility().name, gender: (p.gender || 'N') as RomMon['gender'],
    stats: { atk: st.atk, def: st.def, spa: st.spa, spd: st.spd }, types: p.getTypes(),
  };
}

/** Every Showdown roll for one hit: randomizer pinned to each of the 16 values, crit forced on/off. */
function showdownRolls(b: Battle, att: Pokemon, def: Pokemon, moveId: number, crit: boolean): number[] | null {
  const out: number[] = [];
  for (let r = 0; r < 16; r++) {
    (b as any).randomizer = (d: number) => Math.trunc(Math.trunc(d * (100 - r)) / 100);
    let move = b.dex.getActiveMove(psMove(moveId));
    // as in BattleActions.useMove: Normalize, Sniper etc. hook these
    b.singleEvent('ModifyType', move, null, att, def, move, move);
    b.singleEvent('ModifyMove', move, null, att, def, move, move);
    move = b.runEvent('ModifyType', att, def, move, move);
    move = b.runEvent('ModifyMove', att, def, move, move);
    move.willCrit = crit;
    Object.assign(b, { activeMove: move, activePokemon: att, activeTarget: def }); // Mold Breaker checks these
    const d = b.actions.getDamage(att, def, move, true);
    if (typeof d !== 'number') return null;
    out.push(d);
  }
  return out;
}

/** Compares all rolls of every damaging move of a vs b and b vs a; records the first mismatch per move. */
function compareDuel(a: PokemonSet, c: PokemonSet, mismatches: Map<string, string>): number {
  const b = new Battle({ formatid: 'gen4customgame' as any, seed: '5,6,7,8' });
  applyRomTypeOrder(b, data);
  b.setPlayer('p1', { name: 'P', team: [a] });
  b.setPlayer('p2', { name: 'C', team: [c] });
  const [p, q] = [b.p1.active[0], b.p2.active[0]];
  p.clearBoosts(); q.clearBoosts(); // Intimidate on entry
  b.field.clearWeather(); // Sand Stream / Drizzle / Snow Warning on entry
  let n = 0;
  for (const [att, def] of [[p, q], [q, p]]) {
    for (const slot of att.moveSlots) {
      const mv = b.dex.moves.get(slot.id);
      if (SKIP.has(mv.num) || mv.basePowerCallback) continue;
      for (const crit of [false, true]) {
        const want = romDamageRolls(data, mv.num, asRom(att), asRom(def), crit ? 2 : 1);
        const got = want && showdownRolls(b, att, def, mv.num, crit);
        if (!want || !got) continue;
        n++;
        if (want.join() !== got.join()) {
          const key = `${mv.name}${crit ? ' (crit)' : ''} ${att.getAbility().name}/${def.getAbility().name}`;
          if (!mismatches.has(key)) mismatches.set(key, `${att.name} -> ${def.name} ROM ${want.join(',')} | PS ${got.join(',')}`);
        }
      }
    }
  }
  return n;
}

describe('damage: Showdown vs the Gen 4 ROM formula', () => {
  it('stats match the ROM stat formula (player sets and Cynthia)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const b = new Battle({ formatid: 'gen4customgame' as any, seed: '1,2,3,4' });
      b.setPlayer('p1', { name: 'P', team: generateTeam(data, seed).map(playerSet) });
      b.setPlayer('p2', { name: 'C', team: cynthiaSets(data, 76) });
      for (const p of [...b.p1.pokemon, ...b.p2.pokemon]) {
        const sp = data.species[p.species.num], set = p.set;
        expect(p.maxhp, `${p.name} hp`).toBe(romStat(sp, 'hp', p.level, set.ivs.hp, set.evs.hp, set.nature));
        for (const s of [...STATS, 'spe'] as const)
          expect(p.storedStats[s], `${p.name} ${s}`).toBe(romStat(sp, s, p.level, set.ivs[s], set.evs[s], set.nature));
      }
    }
  });

  it("Cynthia's genders come from her ROM PIDs (Garchomp is female, Lucario male)", () => {
    expect(cynthiaSets(data, 76).map(s => s.gender)).toEqual(['F', 'F', 'F', 'M', 'F', 'F']);
  });

  it('every roll matches for daily teams vs Cynthia, both directions, crit and non-crit', () => {
    const mismatches = new Map<string, string>();
    let compared = 0;
    const cyn = cynthiaSets(data, 76);
    for (let seed = 1; seed <= 80; seed++) {
      const team = generateTeam(data, seed * 7919).map(playerSet);
      for (let i = 0; i < 6; i++) compared += compareDuel(team[i], cyn[(seed + i) % 6], mismatches);
    }
    expect(compared).toBeGreaterThan(3000);
    expect(Object.fromEntries(mismatches)).toEqual({});
  });

  it('every roll matches with each damage-affecting ability forced on the attacker and the defender', () => {
    const ABILITIES = ['Technician', 'Huge Power', 'Pure Power', 'Hustle', 'Iron Fist', 'Rivalry', 'Adaptability',
      'Tinted Lens', 'Sniper', 'Normalize', 'Scrappy', 'Mold Breaker', 'Thick Fat', 'Heatproof', 'Dry Skin', 'Filter',
      'Solid Rock', 'Battle Armor'];
    const mismatches = new Map<string, string>();
    const cyn = cynthiaSets(data, 76);
    const allMoves = data.moves.filter(m => m.category !== 'Status' && m.power > 1 && !SKIP.has(m.id)).map(m => psMove(m.id));
    let compared = 0;
    for (const [k, ability] of ABILITIES.entries()) {
      for (let seed = 1; seed <= 6; seed++) {
        const team = generateTeam(data, seed * 104729 + k).map(playerSet);
        for (let i = 0; i < 6; i++) {
          // four random damaging moves so every type/category gets exercised
          const moves = [0, 1, 2, 3].map(j => allMoves[(seed * 31 + i * 7 + j * 101 + k * 13) % allMoves.length]);
          const mine = { ...team[i], ability, moves, gender: (['M', 'F'] as const)[(i + seed) % 2] };
          const foe = cyn[(seed + i) % 6];
          compared += compareDuel(mine, foe, mismatches);                  // forced on the attacker side
          compared += compareDuel({ ...team[i], moves }, { ...foe, ability }, mismatches); // forced on the defender
        }
      }
    }
    expect(compared).toBeGreaterThan(3000);
    expect(Object.fromEntries(mismatches)).toEqual({});
  });
});
