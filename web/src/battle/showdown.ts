import { Dex, toID, type PokemonSet } from '@pkmn/sim';
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
      nature: m.nature ?? 'Hardy', gender: '', moves: m.moves.filter(Boolean).map(psMove),
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
  return diffs;
}
