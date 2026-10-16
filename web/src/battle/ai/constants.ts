// Gen 4 trainer-AI constants. Values come from the pret/pokeplatinum decomp (read as a reference, not copied):
// include/constants/battle/*.h, generated/*.txt, data/scripts/aicmd.h. The ROM (Diamond) shares these numbers
// EXCEPT item hold-effect ids (Platinum inserted HOLD_EFFECT_GIRATINA_BOOST), which we always read from ROM data.

/** Opcode index = position in aicmd.h; value = number of argument words (jumps included). */
export const OPCODES: [name: string, args: number][] = [
  ['IfRandomLessThan', 2], ['IfRandomGreaterThan', 2], ['IfRandomEqualTo', 2], ['IfRandomNotEqualTo', 2],
  ['AddToMoveScore', 1], ['IfHPPercentLessThan', 3], ['IfHPPercentGreaterThan', 3], ['IfHPPercentEqualTo', 3],
  ['IfHPPercentNotEqualTo', 3], ['IfStatus', 3], ['IfNotStatus', 3], ['IfVolatileStatus', 3],
  ['IfNotVolatileStatus', 3], ['IfMoveEffect', 3], ['IfNotMoveEffect', 3], ['IfSideCondition', 3],
  ['IfNotSideCondition', 3], ['IfLoadedLessThan', 2], ['IfLoadedGreaterThan', 2], ['IfLoadedEqualTo', 2],
  ['IfLoadedNotEqualTo', 2], ['IfLoadedMask', 2], ['IfLoadedNotMask', 2], ['IfMoveEqualTo', 2],
  ['IfMoveNotEqualTo', 2], ['IfLoadedInTable', 2], ['IfLoadedNotInTable', 2], ['IfAttackerHasDamagingMoves', 1],
  ['IfAttackerHasNoDamagingMoves', 1], ['LoadTurnCount', 0], ['LoadTypeFrom', 1], ['LoadMovePower', 0],
  ['FlagMoveDamageScore', 1], ['LoadBattlerPreviousMove', 1], ['IfTempEqualTo', 2], ['IfTempNotEqualTo', 2],
  ['IfSpeedCompareEqualTo', 2], ['IfSpeedCompareNotEqualTo', 2], ['CountAlivePartyBattlers', 1], ['LoadCurrentMove', 0],
  ['LoadCurrentMoveEffect', 0], ['LoadBattlerAbility', 1], ['CalcMaxEffectiveness', 0], ['IfMoveEffectivenessEquals', 2],
  ['IfPartyMemberStatus', 3], ['IfPartyMemberNotStatus', 3], ['LoadCurrentWeather', 0], ['IfCurrentMoveEffectEqualTo', 2],
  ['IfCurrentMoveEffectNotEqualTo', 2], ['IfStatStageLessThan', 4], ['IfStatStageGreaterThan', 4], ['IfStatStageEqualTo', 4],
  ['IfStatStageNotEqualTo', 4], ['IfCurrentMoveKills', 2], ['IfCurrentMoveDoesNotKill', 2], ['IfMoveKnown', 3],
  ['IfMoveNotKnown', 3], ['IfMoveEffectKnown', 3], ['IfMoveEffectNotKnown', 3], ['IfBattlerUnderEffect', 3],
  ['IfCurrentMoveMatchesEffect', 2], ['Escape', 0], ['Dummy3E', 1], ['Dummy3F', 0],
  ['LoadHeldItem', 1], ['LoadHeldItemEffect', 1], ['LoadGender', 1], ['LoadIsFirstTurnInBattle', 1],
  ['LoadStockpileCount', 1], ['LoadBattleType', 0], ['LoadRecycleItem', 1], ['LoadTypeOfLoadedMove', 0],
  ['LoadPowerOfLoadedMove', 0], ['LoadEffectOfLoadedMove', 0], ['LoadProtectChain', 1], ['PushAndGoTo', 1],
  ['GoTo', 1], ['PopOrEnd', 0], ['IfLevel', 2], ['IfTargetIsTaunted', 1],
  ['IfTargetIsNotTaunted', 1], ['IfTargetIsPartner', 1], ['FlagBattlerIsType', 2], ['CheckBattlerAbility', 2],
  ['IfActivatedFlashFire', 2], ['IfHeldItemEqualTo', 3], ['IfFieldConditionsMask', 2], ['LoadSpikesLayers', 2],
  ['IfAnyPartyMemberIsWounded', 2], ['IfAnyPartyMemberUsedPP', 2], ['LoadFlingPower', 1], ['LoadCurrentMovePP', 0],
  ['IfCanUseLastResort', 2], ['LoadCurrentMoveClass', 0], ['LoadDefenderLastUsedMoveClass', 0], ['LoadBattlerSpeedRank', 1],
  ['LoadBattlerTurnCount', 1], ['IfPartyMemberDealsMoreDamage', 2], ['IfHasSuperEffectiveMove', 1], ['IfBattlerDealsMoreDamage', 3],
  ['SumPositiveStatStages', 1], ['DiffStatStages', 2], ['IfBattlerHasHigherStat', 3], ['IfBattlerHasLowerStat', 3],
  ['IfBattlerHasEqualStat', 3], ['CheckIfHighestDamageWithPartner', 1], ['IfBattlerFainted', 2], ['IfBattlerNotFainted', 2],
  ['LoadAbility', 1],
];
export const OP = Object.fromEntries(OPCODES.map(([n], i) => [n, i])) as Record<string, number>;
/** Opcodes whose LAST argument word is a relative jump (target = address of that word + 1 + value). */
export const JUMP_LAST = new Set(OPCODES.map(([n], i) => (/^If/.test(n) || n === 'GoTo' || n === 'PushAndGoTo') ? i : -1));
/** IfLoaded(Not)InTable: first argument is a relative table pointer (table = address of that word + 2 + value). */
export const TABLE_ARG = new Set([OP.IfLoadedInTable, OP.IfLoadedNotInTable]);

/** Index in the flag table == bit in the trainer's AI mask. */
export const AI_FLAG_BASIC = 1 << 0;

// ROM type ids (Normal=0 ... Steel=8, ???=9, Fire=10 ... Dark=17)
export const TYPES = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', '???',
  'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark'];
export const T = Object.fromEntries(TYPES.map((t, i) => [t.toUpperCase(), i])) as Record<string, number>;

// AIScript_Battler codes
export const B_DEFENDER = 0, B_ATTACKER = 1;
// BATTLE_STAT_* (stage index into the 0..12 stat-stage array; 6 = neutral)
export const STAT_KEYS = ['hp', 'atk', 'def', 'spe', 'spa', 'spd', 'accuracy', 'evasion'] as const;

// MON_CONDITION_*
export const MON_SLEEP = 7, MON_POISON = 1 << 3, MON_BURN = 1 << 4, MON_FREEZE = 1 << 5, MON_PARALYSIS = 1 << 6,
  MON_TOXIC = 1 << 7;
// VOLATILE_CONDITION_*
export const VOL = {
  confusion: 7, flinch: 1 << 3, uproar: 7 << 4, bide: 3 << 8, lockedmove: 3 << 10, partiallytrapped: 7 << 13,
  attract: 1 << 16, focusenergy: 1 << 20, transform: 1 << 21, mustrecharge: 1 << 22, rage: 1 << 23,
  substitute: 1 << 24, destinybond: 1 << 25, trapped: 1 << 26, nightmare: 1 << 27, curse: 1 << 28,
  foresight: 1 << 29, defensecurl: 1 << 30, torment: 1 << 31,
};
export const VOL_TRAPPED = VOL.partiallytrapped | VOL.trapped;
// MOVE_EFFECT_* (battleMon.moveEffectsMask), keyed by Showdown volatile id
export const MOVE_EFFECT: Record<string, number> = {
  leechseed: 1 << 2, lockon: 1 << 3, perishsong: 1 << 5, fly: 1 << 6, bounce: 1 << 6, dig: 1 << 7, minimize: 1 << 8,
  charge: 1 << 9, ingrain: 1 << 10, yawn: 1 << 11, imprison: 1 << 13, grudge: 1 << 14, mudsport: 1 << 16,
  watersport: 1 << 17, dive: 1 << 18, gastroacid: 1 << 21, miracleeye: 1 << 22, powertrick: 1 << 23,
  aquaring: 1 << 24, healblock: 1 << 25, embargo: 1 << 26, magnetrise: 1 << 27, shadowforce: 1 << 29,
};
export const ME_INGRAIN = 1 << 10, ME_ABILITY_SUPPRESSED = 1 << 21, ME_MIRACLE_EYE = 1 << 22, ME_EMBARGO = 1 << 26;
// SIDE_CONDITION_*, keyed by Showdown side/slot condition id
export const SIDE: Record<string, number> = {
  reflect: 1 << 0, lightscreen: 1 << 1, spikes: 1 << 2, safeguard: 1 << 3, futuremove: 1 << 4, wish: 1 << 5,
  mist: 1 << 6, stealthrock: 1 << 7, tailwind: 3 << 8, toxicspikes: 1 << 10, luckychant: 7 << 12,
};
// FIELD_CONDITION_*
export const FIELD_RAIN = 3, FIELD_SAND = 3 << 2, FIELD_SUN = 3 << 4, FIELD_HAIL = 3 << 6, FIELD_UPROAR = 15 << 8,
  FIELD_GRAVITY = 7 << 12, FIELD_DEEP_FOG = 1 << 15, FIELD_TRICK_ROOM = 7 << 16;

// MOVE_STATUS_* (effectiveness flags)
export const MS_SUPER = 1 << 1, MS_NOT_VERY = 1 << 2, MS_INEFFECTIVE = 1 << 3, MS_LEVITATED = 1 << 11,
  MS_WONDER_GUARD = 1 << 18, MS_MAGNET_RISE = 1 << 20;
export const MS_IMMUNE = MS_INEFFECTIVE | MS_WONDER_GUARD | MS_LEVITATED | MS_MAGNET_RISE;
// TYPE_MULTI_*
export const TM_IMMUNE = 0, TM_QUARTER = 10, TM_HALF = 20, TM_BASE = 40, TM_STAB = 60, TM_DOUBLE = 80, TM_QUAD = 160;

// AI_WEATHER_*
export const AI_WEATHER_CLEAR = 0, AI_WEATHER_SUNNY = 1, AI_WEATHER_RAINING = 2, AI_WEATHER_SANDSTORM = 3,
  AI_WEATHER_HAILING = 4;
// FlagMoveDamageScore results / CheckBattlerAbility results
export const AI_NO_COMPARISON_MADE = 0, AI_NOT_HIGHEST_DAMAGE = 1, AI_MOVE_IS_HIGHEST_DAMAGE = 2;
export const AI_NOT_HAVE = 0, AI_HAVE = 1, AI_UNKNOWN = 2;
export const COMPARE_SPEED_FASTER = 0, COMPARE_SPEED_SLOWER = 1, COMPARE_SPEED_TIE = 2;
export const BATTLE_TYPE_TRAINER = 1, BATTLE_TYPE_DOUBLES = 2;

// BATTLE_EFFECT_* ids used by the C code (generated/move_battle_effects.txt; identical in Diamond's move data)
export const NO_DAMAGE_CALC_EFFECTS = new Set([7, 8, 39, 75, 80, 145, 151, 161, 170, 182, 190, 248, 269]);
export const ALT_POWER_EFFECTS = new Set([135, 219, 222, 268, 41, 87, 88, 121, 123, 130, 196]);
/** MoveIsOnDamagingTurn: charge-turn effects (incl. Fire Fang's FLINCH_BURN_HIT bug) are "not damaging" for Wonder Guard. */
export const CHARGE_TURN_EFFECTS = new Set([26, 39, 75, 145, 151, 155, 255, 256, 263, 273]);
export const EFFECT_HALVE_DEFENSE = 7, EFFECT_REMOVE_SCREENS = 186;

export const STAGE_RATIO: [number, number][] = [[10, 40], [10, 35], [10, 30], [10, 25], [10, 20], [10, 15], [10, 10],
  [15, 10], [20, 10], [25, 10], [30, 10], [35, 10], [40, 10]];
/** sWeightToPower (weight in 0.1 kg): Low Kick / Grass Knot. */
export const WEIGHT_TO_POWER: [number, number][] = [[100, 20], [250, 40], [500, 60], [1000, 80], [2000, 100]];

export const ITEM_FULL_RESTORE = 23;
