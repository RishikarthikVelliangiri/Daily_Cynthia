// Gen 4 battle-library helpers used by the trainer AI, ported from pret/pokeplatinum src/battle/battle_lib.c and
// trainer_ai.c, reading live state from a Showdown Battle. Every Showdown -> Gen 4 translation lives here.
import { Dex, type Battle, type Pokemon, type Side } from '@pkmn/sim';
import type { GameData } from '../../data';
import * as K from './constants';

/** Everything the AI routines read. `rand` is the AI's own Gen 4 LCG (never battle.prng). */
export interface Ctx {
  battle: Battle;
  data: GameData;
  rand(): number;
  /** battleCtx->monSpeedValues, written by compareSpeed (read by Gyro Ball). */
  speeds: Map<Pokemon, number>;
}

export const abilityNum = (id: string) => (id ? Dex.abilities.get(id).num : 0);
const A = Object.fromEntries(['Levitate', 'Wonder Guard', 'Mold Breaker', 'Normalize', 'Adaptability', 'Scrappy',
  'Filter', 'Solid Rock', 'Tinted Lens', 'Klutz', 'Multitype', 'Stall', 'Gluttony', 'Cloud Nine', 'Air Lock',
  'Technician', 'Huge Power', 'Pure Power', 'Hustle', 'Guts', 'Marvel Scale', 'Thick Fat', 'Heatproof', 'Dry Skin',
  'Simple', 'Unaware', 'Overgrow', 'Blaze', 'Torrent', 'Swarm', 'Solar Power',
].map(n => [n.replace(/ /g, '').toUpperCase(), abilityNum(n)])) as Record<string, number>;
export { A as ABILITY };
const moveNum = (n: string) => Dex.moves.get(n).num;
export const MOVE = {
  STRUGGLE: moveNum('Struggle'), NATURAL_GIFT: moveNum('Natural Gift'), JUDGMENT: moveNum('Judgment'),
  HIDDEN_POWER: moveNum('Hidden Power'), WEATHER_BALL: moveNum('Weather Ball'), GYRO_BALL: moveNum('Gyro Ball'),
  DRAGON_RAGE: moveNum('Dragon Rage'), SEISMIC_TOSS: moveNum('Seismic Toss'), NIGHT_SHADE: moveNum('Night Shade'),
  PSYWAVE: moveNum('Psywave'), RETURN: moveNum('Return'), FRUSTRATION: moveNum('Frustration'),
  MAGNITUDE: moveNum('Magnitude'), SONIC_BOOM: moveNum('Sonic Boom'), LOW_KICK: moveNum('Low Kick'),
  GRASS_KNOT: moveNum('Grass Knot'), SOLAR_BEAM: moveNum('Solar Beam'),
  PROTECT: moveNum('Protect'), DETECT: moveNum('Detect'), ENDURE: moveNum('Endure'),
};

// ---------------------------------------------------------------- ids, items, types
export const romType = (name: string | undefined) => Math.max(0, K.TYPES.indexOf(name ?? 'Normal'));
export const itemNum = (id: string) => (id ? Dex.items.get(id).num : 0);
export const moveId = (p: { id: string } | string | null | undefined) =>
  p ? Dex.moves.get(typeof p === 'string' ? p : p.id).num : 0;
/** ROM hold-effect id of an item (Diamond numbering, read from ROM item data). */
export const holdEffect = (c: Ctx, item: number) => c.data.items[item]?.holdEffect ?? 0;
export const holdParam = (c: Ctx, item: number) => c.data.items[item]?.holdParam ?? 0;
/** Hold-effect id of a named item, so we never hardcode (game-specific) hold-effect numbers. */
export const HE = (c: Ctx, name: string) => holdEffect(c, Dex.items.get(name).num);

/** Battler_Ability: Gastro Acid suppresses (except Multitype); Gravity/Ingrain negate Levitate. */
export function ability(c: Ctx, p: Pokemon) {
  const a = abilityNum(p.ability);
  if (p.volatiles.gastroacid && a !== A.MULTITYPE) return 0;
  if ((c.battle.field.pseudoWeather.gravity || p.volatiles.ingrain) && a === A.LEVITATE) return 0;
  return a;
}
/** Battler_HeldItem: Klutz / Embargo hide the item from battle effects. */
export const effItem = (c: Ctx, p: Pokemon) => (ability(c, p) === A.KLUTZ || p.volatiles.embargo ? 0 : itemNum(p.item));
export const itemEffect = (c: Ctx, p: Pokemon) => holdEffect(c, effItem(c, p));
export const itemPower = (c: Ctx, p: Pokemon) => holdParam(c, effItem(c, p));

/** BATTLEMON_TYPE_1/2 (mono-types report the same type twice). `species` = party data (MON_DATA_TYPE_*). */
export function types(p: Pokemon, species = false): [number, number] {
  const t = species ? p.species.types : p.getTypes();
  return [romType(t[0]), romType(t[1] ?? t[0])];
}
export const hasType = (p: Pokemon, t: number) => types(p).includes(t);
export const romMove = (c: Ctx, move: number) => c.data.moves[move] ?? c.data.moves[0];
export const moveClass = (c: Ctx, move: number) => ['Physical', 'Special', 'Status'].indexOf(romMove(c, move).category);
export const moveSlots = (p: Pokemon) => [0, 1, 2, 3].map(i => p.moveSlots[i]);
export const movesOf = (p: Pokemon) => moveSlots(p).map(s => (s ? moveId(s.id) : 0));
export const stage = (p: Pokemon, stat: number) => 6 + ((p.boosts as Record<string, number>)[K.STAT_KEYS[stat]] ?? 0);
export const genderId = (p: Pokemon) => (p.gender === 'M' ? 0 : p.gender === 'F' ? 1 : 2);
export const alive = (p: Pokemon) => p.hp > 0;
/** Party in ROM party order (Showdown reorders side.pokemon on switches; side.team keeps the original order). */
export const party = (side: Side) =>
  [...side.pokemon].sort((a, b) => side.team.indexOf(a.set) - side.team.indexOf(b.set));
export const noCloudNine = (c: Ctx) =>
  !c.battle.getAllActive().some(p => [A.CLOUDNINE, A.AIRLOCK].includes(ability(c, p)));

// ---------------------------------------------------------------- state bitmasks
export function statusBits(p: Pokemon) {
  const st = p.statusState as { time?: number; stage?: number };
  switch (p.status) {
    case 'slp': return Math.min(7, Math.max(1, st.time ?? 1)); // sleep counter lives in bits 0-2
    case 'psn': return K.MON_POISON;
    case 'brn': return K.MON_BURN;
    case 'frz': return K.MON_FREEZE;
    case 'par': return K.MON_PARALYSIS;
    case 'tox': return K.MON_TOXIC | (Math.min(15, st.stage ?? 0) << 8);
    default: return 0;
  }
}
export function volatileBits(p: Pokemon) {
  let m = p.transformed ? K.VOL.transform : 0;
  for (const [id, bits] of Object.entries(K.VOL)) if (p.volatiles[id]) m |= bits;
  return m | 0;
}
export function moveEffectBits(p: Pokemon) {
  let m = 0;
  for (const [id, bits] of Object.entries(K.MOVE_EFFECT)) if (p.volatiles[id]) m |= bits;
  return m;
}
export function sideBits(side: Side) {
  let m = 0;
  const conds = { ...side.sideConditions, ...(side.slotConditions[0] ?? {}) };
  for (const id of Object.keys(conds)) m |= K.SIDE[id] ?? 0;
  return m;
}
export function fieldBits(c: Ctx) {
  const f = c.battle.field;
  const perm = !f.weatherState.duration; // Gen 4 ability weather is permanent (duration 0)
  let m = ({ raindance: K.FIELD_RAIN, sunnyday: K.FIELD_SUN, sandstorm: K.FIELD_SAND, hail: K.FIELD_HAIL } as
    Record<string, number>)[f.weather] ?? 0;
  m &= perm ? 0xaa : 0x55; // *_PERM bits are the odd ones
  if (f.pseudoWeather.gravity) m |= K.FIELD_GRAVITY;
  if (f.pseudoWeather.trickroom) m |= K.FIELD_TRICK_ROOM;
  if (c.battle.getAllActive().some(p => p.volatiles.uproar)) m |= 1 << 8;
  return m;
}
export const weather = (c: Ctx) => fieldBits(c) & (K.FIELD_RAIN | K.FIELD_SAND | K.FIELD_SUN | K.FIELD_HAIL);

// ---------------------------------------------------------------- type chart (battle_lib.c)
const chartCache = new WeakMap<GameData, [number, number, number, boolean][]>();
function chart(data: GameData) {
  let t = chartCache.get(data);
  if (!t) chartCache.set(data, t = data.typechart.map(e => [romType(e.atk), romType(e.def), e.mult * 10, e.foresightOnly]));
  return t;
}
const divide = (a: number, b: number) => (a === 0 ? 0 : Math.trunc(a / b) || (a < 0 ? -1 : 1)); // BattleSystem_Divide

/** ApplyTypeMultiplier + UpateMoveStatusForTypeMul. */
function typeMul(mul: number, damage: number, update: boolean, flags: number, scale: boolean): [number, number] {
  if (scale && damage) damage = divide(damage * mul, 10);
  if (mul === 0) flags = (flags | K.MS_INEFFECTIVE) & ~(K.MS_NOT_VERY | K.MS_SUPER);
  else if (mul === 5 && update) flags = flags & K.MS_SUPER ? flags & ~K.MS_SUPER : flags | K.MS_NOT_VERY;
  else if (mul === 20 && update) flags = flags & K.MS_NOT_VERY ? flags & ~K.MS_NOT_VERY : flags | K.MS_SUPER;
  return [damage, flags];
}
const ignorable = (c: Ctx, atk: Pokemon, def: Pokemon, ab: number) =>
  ability(c, atk) !== A.MOLDBREAKER && ability(c, def) === ab;
const damagingTurn = (c: Ctx, move: number) => !K.CHARGE_TURN_EFFECTS.has(romMove(c, move).effect);

/** BattleSystem_ApplyTypeChart. `ignoreTypes` = SYSCTL_IGNORE_TYPE_CHECKS (fixed-damage moves). */
export function applyTypeChart(c: Ctx, move: number, inType: number, atk: Pokemon, def: Pokemon, damage: number,
  ignoreTypes = false): { damage: number; flags: number } {
  let flags = 0;
  if (move === MOVE.STRUGGLE) return { damage, flags };
  const ironBall = HE(c, 'Iron Ball');
  const defItem = itemEffect(c, def);
  const mt = ability(c, atk) === A.NORMALIZE ? 0 : inType || romType(romMove(c, move).type);
  const power = romMove(c, move).power;
  if (!ignoreTypes && hasType(atk, mt)) damage = ability(c, atk) === A.ADAPTABILITY ? damage * 2 : Math.trunc(damage * 15 / 10);
  if (ignorable(c, atk, def, A.LEVITATE) && mt === K.T.GROUND && defItem !== ironBall) flags |= K.MS_LEVITATED;
  else if (def.volatiles.magnetrise && !def.volatiles.ingrain && mt === K.T.GROUND && defItem !== ironBall) flags |= K.MS_MAGNET_RISE;
  else {
    const [t1, t2] = types(def);
    for (const [a, d, mul, foresightOnly] of chart(c.data)) {
      if (foresightOnly && (def.volatiles.foresight || ability(c, atk) === A.SCRAPPY)) break;
      if (a !== mt) continue;
      const applies = !((defItem === ironBall || def.volatiles.ingrain) && d === K.T.FLYING && mul === 0)
        && !(def.volatiles.roost && d === K.T.FLYING)
        && !(c.battle.field.pseudoWeather.gravity && d === K.T.FLYING && mul === 0)
        && !(def.volatiles.miracleeye && d === K.T.DARK && mul === 0);
      if (d === t1 && applies) [damage, flags] = typeMul(mul, damage, power > 0, flags, !ignoreTypes);
      if (d === t2 && t1 !== t2 && applies) [damage, flags] = typeMul(mul, damage, power > 0, flags, !ignoreTypes);
    }
  }
  const basic = K.MS_SUPER | K.MS_NOT_VERY;
  if (ignorable(c, atk, def, A.WONDERGUARD) && damagingTurn(c, move)
    && (!(flags & K.MS_SUPER) || (flags & basic) === basic) && power) {
    flags |= K.MS_WONDER_GUARD;
  } else if (!ignoreTypes) {
    if (flags & K.MS_SUPER && power) {
      if (ignorable(c, atk, def, A.FILTER) || ignorable(c, atk, def, A.SOLIDROCK)) damage = divide(damage * 3, 4);
      if (itemEffect(c, atk) === HE(c, 'Expert Belt')) damage = Math.trunc(damage * (100 + itemPower(c, atk)) / 100);
    }
    if (flags & K.MS_NOT_VERY && power && ability(c, atk) === A.TINTEDLENS) damage *= 2;
  } else flags &= ~basic;
  return { damage, flags };
}

/** BattleSystem_CalcEffectiveness (used for party members, which have no battle state). */
export function calcEffectiveness(c: Ctx, move: number, inType: number, atkAbility: number, defAbility: number,
  defItemEffect: number, t1: number, t2: number) {
  let flags = 0;
  if (move === MOVE.STRUGGLE) return 0;
  const mt = atkAbility === A.NORMALIZE ? 0 : inType || romType(romMove(c, move).type);
  const ironBall = HE(c, 'Iron Ball');
  const gravity = !!c.battle.field.pseudoWeather.gravity;
  if (atkAbility !== A.MOLDBREAKER && defAbility === A.LEVITATE && mt === K.T.GROUND && !gravity && defItemEffect !== ironBall) {
    flags |= K.MS_INEFFECTIVE;
  } else {
    for (const [a, d, mul, foresightOnly] of chart(c.data)) {
      if (foresightOnly && atkAbility === A.SCRAPPY) break;
      if (a !== mt) continue;
      const applies = !((defItemEffect === ironBall || gravity) && d === K.T.FLYING && mul === 0);
      if (d === t1 && applies) flags = typeMul(mul, 0, true, flags, false)[1];
      if (d === t2 && t1 !== t2 && applies) flags = typeMul(mul, 0, true, flags, false)[1];
    }
  }
  const basic = K.MS_SUPER | K.MS_NOT_VERY;
  if (atkAbility !== A.MOLDBREAKER && defAbility === A.WONDERGUARD && damagingTurn(c, move)
    && (!(flags & K.MS_SUPER) || (flags & basic) === basic)) flags |= K.MS_INEFFECTIVE;
  return flags;
}

/** BattleSystem_TypeMatchupMultiplier (40 = neutral). */
export function typeMatchup(c: Ctx, atkType: number, d1: number, d2: number) {
  let mul = 40;
  for (const [a, d, m] of chart(c.data)) {
    if (a !== atkType) continue;
    if (d === d1) mul = Math.trunc(mul * m / 10);
    if (d === d2 && d1 !== d2) mul = Math.trunc(mul * m / 10);
  }
  return mul;
}

/** TrainerAI_MoveType / Move_CalcVariableType: variable-type moves, else 0 (= "use the move's own type"). */
export function moveType(c: Ctx, p: Pokemon, move: number): number {
  const item = Dex.items.get(p.item);
  if (move === MOVE.NATURAL_GIFT) return romType(item.naturalGift?.type);
  if (move === MOVE.JUDGMENT) return romType(item.onPlate);
  if (move === MOVE.HIDDEN_POWER) {
    const iv = p.set.ivs;
    const t = (iv.hp & 1) | (iv.atk & 1) << 1 | (iv.def & 1) << 2 | (iv.spe & 1) << 3 | (iv.spa & 1) << 4 | (iv.spd & 1) << 5;
    const r = Math.trunc(t * 15 / 63) + 1;
    return r >= K.T['???'] ? r + 1 : r;
  }
  if (move === MOVE.WEATHER_BALL && noCloudNine(c)) {
    const w = weather(c);
    if (w & K.FIELD_HAIL) return K.T.ICE;
    if (w & K.FIELD_SUN) return K.T.FIRE;
    if (w & K.FIELD_SAND) return K.T.ROCK;
    if (w & K.FIELD_RAIN) return K.T.WATER;
  }
  return 0;
}

// ---------------------------------------------------------------- damage (BattleSystem_CalcMoveDamage, no crit)
/** Simplified port: base formula, stat stages (Simple/Unaware), STAB/type via applyTypeChart (caller), burn,
 * screens, weather, Flash Fire, Explosion's halved Defense and the common ability/item modifiers. Omitted (documented
 * in the skill): type-boosting items/plates, species items, Iron Fist, Rivalry, Plus/Minus, Charge, Helping Hand,
 * Mud/Water Sport, Flower Gift, Slow Start. */
export function calcMoveDamage(c: Ctx, move: number, inPower: number, inType: number, atk: Pokemon, def: Pokemon) {
  const md = romMove(c, move);
  const aAb = ability(c, atk), dAb = ability(c, def);
  const aItem = itemEffect(c, atk);
  let power = inPower || md.power;
  const mt = aAb === A.NORMALIZE ? 0 : inType || romType(md.type);
  const cls = moveClass(c, move);
  let [atkS, defS, spaS, spdS] = [atk.storedStats.atk, def.storedStats.def, atk.storedStats.spa, def.storedStats.spd];
  let [atkSt, defSt, spaSt, spdSt] = [stage(atk, 1) - 6, stage(def, 2) - 6, stage(atk, 4) - 6, stage(def, 5) - 6];
  if (aAb === A.TECHNICIAN && move !== MOVE.STRUGGLE && power <= 60) power = Math.trunc(power * 15 / 10);
  if (aAb === A.HUGEPOWER || aAb === A.PUREPOWER) atkS *= 2;
  if (aItem === HE(c, 'Choice Band')) atkS = Math.trunc(atkS * 150 / 100);
  if (aItem === HE(c, 'Choice Specs')) spaS = Math.trunc(spaS * 150 / 100);
  if (ignorable(c, atk, def, A.THICKFAT) && (mt === K.T.FIRE || mt === K.T.ICE)) power = Math.trunc(power / 2);
  if (aAb === A.HUSTLE) atkS = Math.trunc(atkS * 150 / 100);
  if (aAb === A.GUTS && atk.status) atkS = Math.trunc(atkS * 150 / 100);
  if (ignorable(c, atk, def, A.MARVELSCALE) && def.status) defS = Math.trunc(defS * 150 / 100);
  const pinch = atk.hp <= Math.trunc(atk.maxhp / 3);
  if (pinch && ((mt === K.T.GRASS && aAb === A.OVERGROW) || (mt === K.T.FIRE && aAb === A.BLAZE)
    || (mt === K.T.WATER && aAb === A.TORRENT) || (mt === K.T.BUG && aAb === A.SWARM))) power = Math.trunc(power * 150 / 100);
  if (mt === K.T.FIRE && ignorable(c, atk, def, A.HEATPROOF)) power = Math.trunc(power / 2);
  if (mt === K.T.FIRE && ignorable(c, atk, def, A.DRYSKIN)) power = Math.trunc(power * 125 / 100);
  const clamp = (s: number) => Math.max(-6, Math.min(6, s));
  if (aAb === A.SIMPLE) { atkSt = clamp(atkSt * 2); spaSt = clamp(spaSt * 2); }
  if (ignorable(c, atk, def, A.SIMPLE)) { defSt = clamp(defSt * 2); spdSt = clamp(spdSt * 2); }
  if (ignorable(c, atk, def, A.UNAWARE)) atkSt = spaSt = 0;
  if (aAb === A.UNAWARE) defSt = spdSt = 0;
  const fld = fieldBits(c), side = sideBits(def.side), nc = noCloudNine(c);
  if (nc && fld & K.FIELD_SUN && aAb === A.SOLARPOWER) spaS = Math.trunc(spaS * 15 / 10);
  if (nc && fld & K.FIELD_SAND && hasType(def, K.T.ROCK)) spdS = Math.trunc(spdS * 15 / 10);
  if (md.effect === K.EFFECT_HALVE_DEFENSE) defS = Math.trunc(defS / 2);
  const scale = (s: number, st: number) => Math.trunc(s * K.STAGE_RATIO[st + 6][0] / K.STAGE_RATIO[st + 6][1]);
  const lv = Math.trunc(atk.level * 2 / 5) + 2;
  let damage = 0;
  if (cls === 0) {
    damage = Math.trunc(Math.trunc(scale(atkS, atkSt) * power * lv / scale(defS, defSt)) / 50);
    if (atk.status === 'brn' && aAb !== A.GUTS) damage = Math.trunc(damage / 2);
    if (side & K.SIDE.reflect && md.effect !== K.EFFECT_REMOVE_SCREENS) damage = Math.trunc(damage / 2);
  } else if (cls === 1) {
    damage = Math.trunc(Math.trunc(scale(spaS, spaSt) * power * lv / scale(spdS, spdSt)) / 50);
    if (side & K.SIDE.lightscreen && md.effect !== K.EFFECT_REMOVE_SCREENS) damage = Math.trunc(damage / 2);
  }
  if (nc) {
    if (fld & K.FIELD_RAIN) damage = mt === K.T.FIRE ? Math.trunc(damage / 2) : mt === K.T.WATER ? Math.trunc(damage * 15 / 10) : damage;
    if (fld & (K.FIELD_RAIN | K.FIELD_SAND | K.FIELD_HAIL) && move === MOVE.SOLAR_BEAM) damage = Math.trunc(damage / 2);
    if (fld & K.FIELD_SUN) damage = mt === K.T.FIRE ? Math.trunc(damage * 15 / 10) : mt === K.T.WATER ? Math.trunc(damage / 2) : damage;
  }
  if (atk.volatiles.flashfire && mt === K.T.FIRE) damage = Math.trunc(damage * 15 / 10);
  return damage + 2;
}

/** TrainerAI_CalcDamage: the AI's own estimate (no crits, fixed `variance` roll in 85..100). */
export function aiCalcDamage(c: Ctx, move: number, atk: Pokemon, def: Pokemon, variance: number) {
  let damage = 0, power = 0, type = 0;
  const item = Dex.items.get(effItem(c, atk) ? atk.item : '');
  switch (move) {
    case MOVE.NATURAL_GIFT: power = item.naturalGift?.basePower ?? 0; type = power ? romType(item.naturalGift!.type) : 0; break;
    case MOVE.JUDGMENT: type = romType(item.onPlate); break;
    case MOVE.HIDDEN_POWER: {
      const iv = atk.set.ivs;
      const p = (iv.hp & 2) >> 1 | (iv.atk & 2) | (iv.def & 2) << 1 | (iv.spe & 2) << 2 | (iv.spa & 2) << 3 | (iv.spd & 2) << 4;
      power = Math.trunc(p * 40 / 63) + 30; type = moveType(c, atk, move); break;
    }
    case MOVE.GYRO_BALL: {
      const sa = c.speeds.get(atk) ?? atk.getStat('spe'), sd = c.speeds.get(def) ?? def.getStat('spe');
      power = Math.min(150, 1 + Math.trunc(25 * sd / Math.max(1, sa))); break;
    }
    case MOVE.DRAGON_RAGE: damage = 40; break;
    case MOVE.SEISMIC_TOSS: case MOVE.NIGHT_SHADE: damage = atk.level; break;
    case MOVE.PSYWAVE: damage = Math.trunc(atk.level * (c.rand() % 11 + 5) / 10); break;
    case MOVE.RETURN: power = Math.trunc(atk.happiness * 10 / 25); break;
    case MOVE.FRUSTRATION: power = Math.trunc((255 - atk.happiness) * 10 / 25); break;
    case MOVE.MAGNITUDE: {
      const r = c.rand() % 100;
      power = r < 5 ? 10 : r < 15 ? 30 : r < 35 ? 50 : r < 65 ? 70 : r < 85 ? 90 : r < 95 ? 110 : 150; break;
    }
    case MOVE.SONIC_BOOM: damage = 20; break;
    case MOVE.LOW_KICK: case MOVE.GRASS_KNOT:
      power = K.WEIGHT_TO_POWER.find(([w]) => w >= def.weighthg)?.[1] ?? 120; break;
  }
  const fixed = damage !== 0;
  if (!fixed) damage = calcMoveDamage(c, move, power, type, atk, def);
  const r = applyTypeChart(c, move, type, atk, def, damage, fixed);
  return r.flags & K.MS_IMMUNE ? 0 : divide(r.damage * variance, 100);
}

/** TrainerAI_CalcAllDamage: damage of each of `moves` (0 for status / no-calc moves) and the maximum. */
export function aiCalcAllDamage(c: Ctx, atk: Pokemon, def: Pokemon, moves: number[], rolls: number[] | null) {
  const vals = moves.map((m, i) => {
    const e = romMove(c, m).effect;
    const ok = K.ALT_POWER_EFFECTS.has(e) || (m !== 0 && !K.NO_DAMAGE_CALC_EFFECTS.has(e) && romMove(c, m).power > 1);
    return ok ? aiCalcDamage(c, m, atk, def, rolls ? rolls[i] : 100) : 0;
  });
  return { vals, max: Math.max(0, ...vals) };
}

// ---------------------------------------------------------------- speed (BattleSystem_CompareBattlerSpeed)
/** Speeds come from Showdown's getStat('spe') (stages, paralysis, Choice Scarf, Iron Ball/Macho Brace, Swift Swim,
 * Chlorophyll, Quick Feet, Slow Start, Unburden, Tailwind). Quick Claw needs battleCtx->speedRand: ignored.
 * With ignoreQuickClaw = TRUE (all AI callers) move priority is not considered. */
export function compareSpeed(c: Ctx, a: Pokemon, b: Pokemon) {
  if (!alive(a) && alive(b)) return 1;
  if (alive(a) && !alive(b)) return 0;
  const sa = a.getStat('spe', false, false), sb = b.getStat('spe', false, false);
  c.speeds.set(a, sa).set(b, sb);
  const lag = (p: Pokemon) => itemEffect(c, p) === HE(c, 'Lagging Tail');
  const custap = (p: Pokemon) => {
    if (itemEffect(c, p) !== HE(c, 'Custap Berry')) return false;
    let prm = itemPower(c, p);
    if (ability(c, p) === A.GLUTTONY) prm = Math.trunc(prm / 2);
    return prm > 0 && p.hp <= Math.trunc(p.maxhp / prm);
  };
  const tie = () => (c.rand() & 1 ? K.COMPARE_SPEED_TIE : K.COMPARE_SPEED_FASTER);
  const lowFirst = (x: number, y: number) => (x > y ? K.COMPARE_SPEED_SLOWER : x === y ? tie() : K.COMPARE_SPEED_FASTER);
  const highFirst = (x: number, y: number) => (x < y ? K.COMPARE_SPEED_SLOWER : x === y ? tie() : K.COMPARE_SPEED_FASTER);
  const [qa, qb, la, lb] = [custap(a), custap(b), lag(a), lag(b)];
  const [stA, stB] = [ability(c, a) === A.STALL, ability(c, b) === A.STALL];
  if (qa && qb) return highFirst(sa, sb);
  if (qa !== qb) return qa ? K.COMPARE_SPEED_FASTER : K.COMPARE_SPEED_SLOWER;
  if (la && lb) return lowFirst(sa, sb);
  if (la !== lb) return la ? K.COMPARE_SPEED_SLOWER : K.COMPARE_SPEED_FASTER;
  if (stA && stB) return lowFirst(sa, sb);
  if (stA !== stB) return stA ? K.COMPARE_SPEED_SLOWER : K.COMPARE_SPEED_FASTER;
  if (c.battle.field.pseudoWeather.trickroom) return lowFirst(sa, sb);
  return highFirst(sa, sb);
}

/** AI_HasSuperEffectiveMove (singles: only the opposing active battler). */
export function hasSuperEffectiveMove(c: Ctx, atk: Pokemon, def: Pokemon, always: boolean) {
  for (const m of movesOf(atk)) {
    if (!m) continue;
    const { flags } = applyTypeChart(c, m, moveType(c, atk, m), atk, def, 0);
    if (flags & K.MS_SUPER && (always || c.rand() % 10 !== 0)) return true;
  }
  return false;
}
