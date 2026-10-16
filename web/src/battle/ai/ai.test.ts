import { Battle, type PokemonSet } from '@pkmn/sim';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CYNTHIA_ID, type GameData, loadGameDataFromDisk } from '../../data';
import { cynthiaSets } from '../showdown';
import * as K from './constants';
import { type AIState, applyTrainerItem, chooseAction, chooseReplacement, createAIState } from './index';
import { aiWords } from './interpreter';

let data: GameData;
beforeAll(async () => { data = await loadGameDataFromDisk(); });
afterEach(() => vi.restoreAllMocks());

const stats = (v: number) => ({ hp: v, atk: v, def: v, spa: v, spd: v, spe: v });
const mon = (species: string, ability: string, moves: string[]): PokemonSet => ({
  name: species, species, level: 76, ability, item: '', nature: 'Hardy', gender: '', moves, evs: stats(0), ivs: stats(31),
});
const PLAYERS = {
  gengar: mon('Gengar', 'levitate', ['shadowball', 'sludgebomb', 'thunderbolt', 'hypnosis']),
  garchomp: mon('Garchomp', 'sandveil', ['earthquake', 'dragonclaw', 'firefang', 'swordsdance']),
  blissey: mon('Blissey', 'naturalcure', ['softboiled', 'icebeam', 'toxic', 'thunderwave']),
  magnezone: mon('Magnezone', 'magnetpull', ['thunderbolt', 'flashcannon', 'thunderwave', 'explosion']),
  gyarados: mon('Gyarados', 'intimidate', ['waterfall', 'dragondance', 'earthquake', 'icefang']),
  vaporeon: mon('Vaporeon', 'waterabsorb', ['surf', 'icebeam', 'wish', 'protect']),
};
/** Cynthia's ROM team (ROM levels) with party member `lead` moved to the front. */
const cynthia = (lead = 0) => { const t = cynthiaSets(data, null); return [t[lead], ...t.filter((_, i) => i !== lead)]; };
function battle(p1: PokemonSet[], p2: PokemonSet[] = cynthia()) {
  const b = new Battle({ formatid: 'gen4customgame' as any, seed: '1,2,3,4' as any });
  b.setPlayer('p1', { name: 'Player', team: p1 });
  b.setPlayer('p2', { name: 'Cynthia', team: p2 });
  return b;
}
const trainer = () => data.trainers[CYNTHIA_ID];
const moveName = (b: Battle, slot: number) => b.p2.active[0].moveSlots[slot].id;
/** Decisions over many AI seeds (the battle itself is not advanced). */
const decisions = (b: Battle, n = 60) =>
  Array.from({ length: n }, (_, seed) => chooseAction(b, data, createAIState(trainer(), seed), 1));

describe('bytecode', () => {
  it('decodes the flag table and Basic only reaches implemented commands', () => {
    const w = aiWords(data.aiSeq);
    expect(trainer().aiFlags).toBe(K.AI_FLAG_BASIC);
    expect(w[0]).toBe(32); // Basic_Main starts right after the 32-entry flag table
    for (let i = 0; i < 32; i++) expect(w[i]).toBeGreaterThanOrEqual(32), expect(w[i]).toBeLessThan(w.length);
    // static walk of everything reachable from Basic_Main
    const seen = new Set<number>(), ops = new Set<string>(), todo = [w[0]];
    while (todo.length) {
      const pc = todo.pop()!;
      if (seen.has(pc)) continue;
      seen.add(pc);
      const op = w[pc], [name, n] = K.OPCODES[op];
      ops.add(name);
      if (K.JUMP_LAST.has(op)) todo.push(pc + n + 1 + w[pc + n]);
      if (!['GoTo', 'PopOrEnd', 'Escape'].includes(name)) todo.push(pc + 1 + n);
    }
    const unimplemented = ['Dummy3E', 'Dummy3F', 'CheckIfHighestDamageWithPartner', 'IfBattlerFainted', 'IfBattlerNotFainted'];
    expect([...ops].filter(o => unimplemented.includes(o))).toEqual([]);
    expect(ops.size).toBeGreaterThan(40);
  });

  it('runs Basic for every Cynthia Pokémon against varied opponents without errors', () => {
    const warn = vi.spyOn(console, 'warn');
    for (let lead = 0; lead < 6; lead++) {
      for (const p of Object.values(PLAYERS)) {
        const b = battle([p], cynthia(lead));
        const d = chooseAction(b, data, createAIState(trainer(), lead), 1);
        expect(['move', 'switch']).toContain(d.kind);
      }
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Basic scoring', () => {
  it('Gastrodon never uses Earthquake into a Levitate Gengar', () => {
    const b = battle([PLAYERS.gengar], cynthia(2));
    const picks = decisions(b).map(d => (d.kind === 'move' ? moveName(b, d.slot) : d.kind));
    expect(picks).not.toContain('earthquake');
    expect(new Set(picks).size).toBeGreaterThan(1); // the other three tie at 100 and are picked randomly
  });

  it('Milotic never uses Surf into a Water Absorb Vaporeon', () => {
    const b = battle([PLAYERS.vaporeon], cynthia(4));
    const picks = decisions(b).map(d => (d.kind === 'move' ? moveName(b, d.slot) : d.kind));
    expect(picks).not.toContain('surf');
  });

  it('a status move into an already-statused target is discouraged', () => {
    const sets = [mon('Roserade', 'naturalcure', ['toxic', 'energyball'])];
    const fresh = battle([PLAYERS.blissey], sets);
    expect(decisions(fresh).map(d => d.kind === 'move' && moveName(fresh, d.slot))).toContain('toxic');
    const statused = battle([PLAYERS.blissey], sets);
    statused.p1.active[0].setStatus('par');
    expect(decisions(statused).map(d => d.kind === 'move' && moveName(statused, d.slot))).not.toContain('toxic');
  });

  it('is deterministic for the same seed and battle state', () => {
    const b = battle([PLAYERS.garchomp], cynthia(5));
    const run = () => { const s = createAIState(trainer(), 1234); return [chooseAction(b, data, s, 1), s] as const; };
    const [d1, s1] = run(), [d2, s2] = run();
    expect(d1).toEqual(d2);
    expect(s1).toEqual(s2);
  });
});

describe('items (TrainerAI_ShouldUseItem)', () => {
  const lowHP = (b: Battle) => { const p = b.p2.active[0]; p.sethp(Math.trunc(p.maxhp / 4) - 1); return p; };

  it('uses one Full Restore below 1/4 HP with 6 Pokémon left, then no more until fewer remain', () => {
    const b = battle([PLAYERS.blissey]);
    lowHP(b);
    const s = createAIState(trainer(), 7);
    expect(s.items).toEqual([23, 23, 23, 23]);
    expect(chooseAction(b, data, s, 1)).toEqual({ kind: 'item', item: 23 });
    expect(s.items).toEqual([0, 23, 23, 23]); // removed from the AI's pocket at decision time
    // still low, 6 alive: only slot 0 passes the "alive <= count - i + 1" gate and it is empty -> fight
    expect(chooseAction(b, data, s, 1).kind).toBe('move');
  });

  it('above 1/4 HP it fights', () => {
    const b = battle([PLAYERS.blissey]);
    b.p2.active[0].sethp(Math.trunc(b.p2.active[0].maxhp / 4));
    expect(chooseAction(b, data, createAIState(trainer(), 7), 1).kind).toBe('move');
  });

  it('reproduces the ROM loop without `break`: with 3 Pokémon left one use empties slots 0-2', () => {
    const b = battle([PLAYERS.blissey]);
    lowHP(b);
    for (const q of b.p2.pokemon.slice(3)) { q.hp = 0; q.fainted = true; }
    const s = createAIState(trainer(), 7);
    expect(chooseAction(b, data, s, 1)).toEqual({ kind: 'item', item: 23 });
    expect(s.items).toEqual([0, 0, 0, 23]);
  });

  it('applyTrainerItem fully heals, cures status and logs', () => {
    const b = battle([PLAYERS.blissey]);
    const p = lowHP(b);
    p.setStatus('par');
    const s: AIState = createAIState(trainer(), 7);
    const before = b.log.length;
    applyTrainerItem(b, data, s, 23);
    expect(p.hp).toBe(p.maxhp);
    expect(p.status).toBe('');
    expect(s.items).toEqual([0, 23, 23, 23]);
    const lines = b.log.slice(before).join('\n');
    expect(lines).toContain('Cynthia used Full Restore!');
    expect(lines).toContain('|-heal|p2a:');
  });
});

describe('replacement & robustness', () => {
  it('chooseReplacement returns a living, non-active party index', () => {
    for (const p of Object.values(PLAYERS)) {
      const b = battle([p]);
      b.p2.active[0].hp = 0; b.p2.active[0].fainted = true;
      const i = chooseReplacement(b, data, createAIState(trainer(), 1));
      const q = b.p2.pokemon[i];
      expect(q && q.hp > 0 && q !== b.p2.active[0]).toBe(true);
    }
  });

  it('an unimplemented opcode falls back to a legal move instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seq = data.aiSeq.slice();
    new DataView(seq.buffer).setInt32(aiWords(data.aiSeq)[0] * 4, K.OP.Dummy3E, true); // first Basic instruction
    const b = battle([PLAYERS.gengar], cynthia(5));
    const s = createAIState(trainer(), 3);
    const d = chooseAction(b, { ...data, aiSeq: seq }, s, 1);
    expect(d.kind).toBe('move');
    const slot = b.p2.active[0].moveSlots[(d as { slot: number }).slot];
    expect(slot.pp).toBeGreaterThan(0);
    expect(s).toEqual(createAIState(trainer(), 3)); // state untouched by the failed attempt
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
