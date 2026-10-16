import { type Battle, Dex, toID, type PokemonSet } from '@pkmn/sim';
import type { GameData, TrainerMon } from '../data';
import { CYNTHIA_ID } from '../data';
import type { GenMon } from '../generator/generate';

export const dex = Dex.forGen(4);

const speciesByNum = new Map<number, string>();
for (const s of dex.species.all()) if (!s.forme && s.num > 0 && !speciesByNum.has(s.num)) speciesByNum.set(s.num, s.name);
const moveByNum = new Map<number, string>();
for (const m of dex.moves.all()) if (m.num > 0 && !moveByNum.has(m.num)) moveByNum.set(m.num, m.id);

export const psSpecies = (num: number) => speciesByNum.get(num)!;
export const psMove = (romId: number) => moveByNum.get(romId)!;

const stats = (v: number) => ({ hp: v, atk: v, def: v, spa: v, spd: v, spe: v });

export function playerSet(mon: GenMon): PokemonSet {
  const species = psSpecies(mon.species);
  return {
    name: species, species, level: mon.level, ability: toID(mon.ability), item: '', nature: mon.nature,
    gender: mon.gender === 'N' ? '' : mon.gender, moves: mon.moves.map(psMove),
    evs: stats(mon.evs), ivs: stats(mon.ivs),
  };
}

/** Gen 4: female when the PID's low byte is below the species' gender ratio (0 all male, 254 all female, 255 none). */
export function romGender(ratio: number, pid = 0): 'M' | 'F' | '' {
  if (ratio === 255) return '';
  if (ratio === 254) return 'F';
  if (ratio === 0) return 'M';
  return (pid & 0xff) < ratio ? 'F' : 'M';
}

/** Cynthia's ROM team as Showdown sets. Species/moves/items/natures/IVs come from the ROM untouched;
 * only the level is overridden (null keeps the original 60-66 levels). */
export function cynthiaSets(data: GameData, level: number | null): PokemonSet[] {
  return data.trainers[CYNTHIA_ID].party.map((m: TrainerMon) => {
    const sp = data.species[m.species];
    const species = psSpecies(m.species);
    return {
      name: species, species, level: level ?? m.level,
      ability: toID(sp.abilities[m.abilitySlot ?? 0] ?? sp.abilities[0]),
      item: m.item ? toID(data.items[m.item].name) : '',
      nature: m.nature ?? 'Hardy', gender: romGender(sp.genderRatio, m.pid), moves: m.moves.filter(Boolean).map(psMove),
      evs: stats(0), ivs: stats(m.iv ?? 31),
    };
  });
}

/** Differences between ROM data and Showdown's Gen 4 data that could affect battles. */
export function romShowdownDiffs(data: GameData): string[] {
  const out: string[] = [];
  for (let n = 1; n <= 493; n++) {
    const r = data.species[n], p = dex.species.get(psSpecies(n));
    const rb = r.baseStats, pb = p.baseStats;
    if (rb.hp !== pb.hp || rb.atk !== pb.atk || rb.def !== pb.def || rb.spa !== pb.spa || rb.spd !== pb.spd || rb.spe !== pb.spe)
      out.push(`species ${r.name}: ROM stats ${JSON.stringify(rb)} vs Showdown ${JSON.stringify(pb)}`);
    if (r.types.join('/') !== p.types.join('/')) out.push(`species ${r.name}: ROM types ${r.types} vs Showdown ${p.types}`);
    const pa = Object.values(p.abilities).map(a => toID(a));
    for (const a of r.abilities) if (!pa.includes(toID(a))) out.push(`species ${r.name}: ROM ability ${a} not in Showdown ${pa}`);
  }
  for (const r of data.moves.slice(1)) {
    const p = dex.moves.get(psMove(r.id));
    const pAcc = p.accuracy === true ? 0 : p.accuracy;
    const rPow = r.power === 1 && p.basePower === 0 ? 0 : r.power; // ROM marks variable-power moves as 1
    const diffs: string[] = [];
    if (rPow !== p.basePower) diffs.push(`power ${r.power}/${p.basePower}`);
    if (r.accuracy !== pAcc) diffs.push(`acc ${r.accuracy}/${pAcc}`);
    if (r.pp !== p.pp) diffs.push(`pp ${r.pp}/${p.pp}`);
    if (r.type !== p.type) diffs.push(`type ${r.type}/${p.type}`);
    if (r.category !== p.category) diffs.push(`category ${r.category}/${p.category}`);
    if (r.priority !== p.priority) diffs.push(`priority ${r.priority}/${p.priority}`);
    if (diffs.length) out.push(`move ${r.name}: ${diffs.join(', ')} (ROM/Showdown)`);
  }
  return out;
}

/** Make Showdown use the ROM's numbers where they disagree (the Battle shares this Dex instance).
 * Returns the list of differences that were overridden. Idempotent. */
export function applyRomOverrides(data: GameData): string[] {
  const diffs = romShowdownDiffs(data);
  for (const r of data.moves.slice(1)) {
    const p = dex.moves.get(psMove(r.id)) as any;
    const acc = r.accuracy === 0 ? true : r.accuracy;
    if (p.accuracy !== acc) p.accuracy = acc;
    if (p.priority !== r.priority) p.priority = r.priority;
    if (p.pp !== r.pp) p.pp = r.pp;
  }
  applyRomAbilities();
  return diffs;
}

// Abilities whose Gen 4 math Showdown rounds differently (pret battle_lib.c, BattleSystem_CalcMoveDamage):
// the ROM floors power * n / 100 step by step; Showdown chains 4096-based modifiers. Found by damage.test.ts.
function applyRomAbilities() {
  const ab = (id: string) => dex.abilities.get(id) as any;
  const floorPct = (pct: number) => (bp: number) => Math.floor((bp * pct) / 100);
  // Sniper: crit multiplier 3 before the random roll, not 2 then x1.5 at the end.
  Object.assign(ab('sniper'), { onModifyDamage: undefined, onModifyMove(move: any) { move.critModifier = 3; } });
  Object.assign(ab('ironfist'), { onBasePower(bp: number, _a: any, _d: any, move: any) { if (move.flags.punch) return floorPct(120)(bp); } });
  Object.assign(ab('rivalry'), {
    onBasePower(bp: number, attacker: any, defender: any) {
      if (!attacker.gender || !defender.gender) return;
      return floorPct(attacker.gender === defender.gender ? 125 : 75)(bp);
    },
  });
  const tech = ab('technician'), techBp = tech.romBase ?? tech.onBasePower; // romBase: stay idempotent
  Object.assign(tech, { romBase: techBp, onBasePower(this: any, bp: number, a: any, d: any, move: any) {
    if (move.id !== 'struggle') return techBp.call(this, bp, a, d, move); // Gen 4 excludes Struggle
  } });
  Object.assign(ab('dryskin'), { onSourceBasePower(bp: number, _a: any, _d: any, move: any) { if (move.type === 'Fire') return floorPct(125)(bp); } });
  // Heatproof halves the move's power in Gen 4 (Showdown halves the attacker's stat, the Gen 5+ behavior).
  Object.assign(ab('heatproof'), {
    onSourceModifyAtk: undefined, onSourceModifySpA: undefined,
    onSourceBasePower(bp: number, _a: any, _d: any, move: any) { if (move.type === 'Fire') return Math.floor(bp / 2); },
  });
}

/** The ROM applies the type chart entry by entry in table order, flooring after each step. A 2x and a 1/2x that
 * cancel out therefore give 2*floor(d/2) when the 1/2x entry comes first (e.g. Water vs. Gastrodon), where Showdown
 * nets them to 1x and keeps an odd d. Patches one Battle's damage step to match. */
export function applyRomTypeOrder(battle: Battle, data: GameData) {
  const order = new Map<string, number>(); // "Atk>Def" -> index of the multiplier entry in the ROM table
  data.typechart.forEach((e, i) => { if (!e.foresightOnly) order.set(`${e.atk}>${e.def}`, i); });
  const mult = (atk: string, def: string) => data.typechart[order.get(`${atk}>${def}`) ?? -1]?.mult ?? 1;
  const actions = battle.actions as any;
  const base = actions.modifyDamage;
  actions.modifyDamage = function (this: any, dmg: number, source: any, target: any, move: any, suppress?: boolean) {
    const d = base.call(this, dmg, source, target, move, suppress);
    const [t1, t2] = target.getTypes();
    if (!t2 || typeof d !== 'number' || move.type === '???') return d;
    const m1 = mult(move.type, t1), m2 = mult(move.type, t2);
    if (m1 * m2 !== 1 || m1 === 1) return d; // only the 2x + 1/2x pair rounds differently
    const halfFirst = (order.get(`${move.type}>${m1 === 0.5 ? t1 : t2}`)! < order.get(`${move.type}>${m1 === 0.5 ? t2 : t1}`)!);
    return halfFirst ? Math.max(1, d - (d & 1)) : d;
  };
}
