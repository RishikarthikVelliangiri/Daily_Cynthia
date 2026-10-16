// Independent Gen 4 damage formula, transcribed from the Diamond/Platinum battle code (pret's battle_lib.c:
// BattleSystem_CalcMoveDamage, BattleScript_CalcMoveDamage, CalcDamageVariance, ApplyTypeChart).
// Used only to cross-check Showdown (damage.test.ts). Covers single battles, no stat stages/weather/screens/items;
// the abilities that change these numbers are handled.
import type { GameData, Species } from '../data';

const NATURES = ['Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash', 'Calm', 'Gentle',
  'Sassy', 'Careful', 'Quirky'];
const NATURE_STATS = ['atk', 'def', 'spe', 'spa', 'spd'] as const;
type Stat = 'hp' | (typeof NATURE_STATS)[number];

/** Pokemon_CalcStats: HP and the five others, with the nature applied as *110/100 or *90/100. */
export function romStat(sp: Species, stat: Stat, level: number, iv: number, ev: number, nature: string): number {
  const base = sp.baseStats[stat];
  const core = Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100);
  if (stat === 'hp') return sp.id === 292 ? 1 : core + level + 10; // Shedinja
  const n = NATURES.indexOf(nature), k = NATURE_STATS.indexOf(stat);
  const up = Math.floor(n / 5) === k, down = n % 5 === k;
  const v = core + 5;
  return up === down ? v : Math.floor((v * (up ? 110 : 90)) / 100);
}

export interface RomMon {
  species: number; level: number; ability: string; gender: 'M' | 'F' | 'N';
  stats: { atk: number; def: number; spa: number; spd: number }; types: string[];
}

const PUNCHING = new Set([4, 5, 7, 8, 9, 146, 183, 223, 264, 309, 325, 327, 359, 409, 418]);
const IGNORABLE = (att: RomMon, def: RomMon, ab: string) => def.ability === ab && att.ability !== 'Mold Breaker';

/** All 16 damage rolls (variance 100..85) for one hit, or null if the move doesn't deal normal damage. */
export function romDamageRolls(data: GameData, moveId: number, att: RomMon, def: RomMon, critMul: 1 | 2): number[] | null {
  const mv = data.moves[moveId];
  if (mv.category === 'Status' || mv.power <= 1) return null;
  if (critMul > 1 && (IGNORABLE(att, def, 'Battle Armor') || IGNORABLE(att, def, 'Shell Armor'))) return null;
  let power = mv.power;
  const type = att.ability === 'Normalize' ? 'Normal' : mv.type;
  let atk = att.stats.atk, dfn = def.stats.def, spa = att.stats.spa, spd = def.stats.spd;

  if (att.ability === 'Technician' && moveId !== 165 && power <= 60) power = Math.floor((power * 15) / 10);
  if (att.ability === 'Huge Power' || att.ability === 'Pure Power') atk *= 2;
  if (IGNORABLE(att, def, 'Thick Fat') && (type === 'Fire' || type === 'Ice')) power = Math.floor(power / 2);
  if (att.ability === 'Hustle') atk = Math.floor((atk * 150) / 100);
  if (type === 'Fire' && IGNORABLE(att, def, 'Heatproof')) power = Math.floor(power / 2);
  if (type === 'Fire' && IGNORABLE(att, def, 'Dry Skin')) power = Math.floor((power * 125) / 100);
  if (att.ability === 'Rivalry' && att.gender !== 'N' && def.gender !== 'N')
    power = Math.floor((power * (att.gender === def.gender ? 125 : 75)) / 100);
  if (att.ability === 'Iron Fist' && PUNCHING.has(moveId)) power = Math.floor((power * 12) / 10);
  if (data.moves[moveId].effect === 7) dfn = Math.floor(dfn / 2); // Explosion/Selfdestruct halve Defense (Gen 4)

  const lv = Math.floor((att.level * 2) / 5) + 2;
  let dmg = mv.category === 'Physical'
    ? Math.floor(Math.floor((atk * power * lv) / dfn) / 50)
    : Math.floor(Math.floor((spa * power * lv) / spd) / 50);
  dmg += 2;
  dmg *= att.ability === 'Sniper' && critMul === 2 ? 3 : critMul;

  return Array.from({ length: 16 }, (_, r) => {
    let d = Math.max(1, Math.floor((dmg * (100 - r)) / 100));
    if (moveId === 165) return d; // Struggle: ApplyTypeChart returns early (no STAB, no type)
    if (att.types.includes(type)) d = att.ability === 'Adaptability' ? d * 2 : Math.floor((d * 15) / 10);
    // Type chart applied entry by entry in ROM order, flooring after each (ApplyTypeMultiplier).
    let se = false, nve = false;
    const scrappy = att.ability === 'Scrappy';
    for (const e of data.typechart) {
      if (e.atk !== type || (e.foresightOnly && scrappy)) continue;
      const hits = (e.def === def.types[0] ? 1 : 0) + (def.types[1] && def.types[1] !== def.types[0] && e.def === def.types[1] ? 1 : 0);
      for (let k = 0; k < hits; k++) {
        d = Math.floor((d * Math.round(e.mult * 10)) / 10);
        if (e.mult === 2) { if (nve) nve = false; else se = true; }
        if (e.mult === 0.5) { if (se) se = false; else nve = true; }
      }
    }
    if (se && (IGNORABLE(att, def, 'Filter') || IGNORABLE(att, def, 'Solid Rock'))) d = Math.floor((d * 3) / 4);
    if (nve && att.ability === 'Tinted Lens') d *= 2;
    return d;
  });
}
