import type { Battle, Pokemon } from '@pkmn/sim';
import { dex } from './showdown';

// ponytail: 1-ply greedy damage bot for the winnability check. A smarter bot (switch prediction,
// setup) would raise pass rates; upgrade if puzzles start feeling unfair in practice.

function moveScore(user: Pokemon, foe: Pokemon, moveId: string): number {
  const m = dex.moves.get(moveId);
  if (m.category === 'Status') return 0;
  if (!dex.getImmunity(m.type, foe.getTypes())) return 0;
  if (m.type === 'Ground' && foe.ability === 'levitate') return 0;
  const fixed = m.damage === 'level' ? user.level : typeof m.damage === 'number' ? m.damage : 0;
  const atk = m.category === 'Physical' ? user.getStat('atk') / foe.getStat('def') : user.getStat('spa') / foe.getStat('spd');
  const power = m.basePower || 60;
  const stab = user.getTypes().includes(m.type) ? 1.5 : 1;
  const eff = 2 ** dex.getEffectiveness(m.type, foe.getTypes());
  const acc = m.accuracy === true ? 1 : m.accuracy / 100;
  const dmg = fixed || (power * atk * stab * eff * user.level) / 50;
  // Recharge moves cost a turn; self-KO moves end the user.
  const penalty = m.self?.volatileStatus === 'mustrecharge' ? 0.6 : m.selfdestruct ? 0.4 : 1;
  return Math.min(dmg * acc * penalty, foe.hp * 1.05 + (m.priority > 0 ? 1 : 0));
}

function best(user: Pokemon, foe: Pokemon) {
  let bestSlot = -1, bestScore = -1;
  user.moveSlots.forEach((s, i) => {
    if (s.pp <= 0 || s.disabled) return;
    const sc = moveScore(user, foe, s.id);
    if (sc > bestScore) { bestScore = sc; bestSlot = i; }
  });
  return { slot: bestSlot, score: bestScore };
}

function threat(foe: Pokemon, mon: Pokemon) {
  return Math.max(0, ...foe.moveSlots.map(s => moveScore(foe, mon, s.id)));
}

/** Choice string for side p1. */
export function botChoice(battle: Battle): string {
  const side = battle.p1, foe = battle.p2.active[0];
  const bench = side.pokemon.map((p, i) => ({ p, i })).filter(({ p }) => !p.fainted && !p.isActive);
  const value = (p: Pokemon) => best(p, foe).score / foe.maxhp - threat(foe, p) / p.maxhp / 2;
  if (side.requestState === 'switch') {
    bench.sort((a, b) => value(b.p) - value(a.p));
    return `switch ${bench[0].i + 1}`;
  }
  const me = side.active[0];
  const b = best(me, foe);
  const trapped = me.volatiles['partiallytrapped'] || me.volatiles['trapped'];
  if (b.score <= 0 && bench.length && !trapped) {
    bench.sort((a, b2) => value(b2.p) - value(a.p));
    if (value(bench[0].p) > 0) return `switch ${bench[0].i + 1}`;
  }
  if (b.slot >= 0) return `move ${b.slot + 1}`;
  return 'move 1';
}
