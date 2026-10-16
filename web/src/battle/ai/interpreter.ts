// Interpreter for the ROM's trainer-AI bytecode (battle/tr_ai/tr_ai_seq.narc member 0).
// Semantics follow pret/pokeplatinum src/battle/trainer_ai.c (TrainerAI_EvalMoves + the AICmd_* table).
//
// Layout: little-endian 32-bit words. Words 0..31 are the flag table: word i = start (word index from the file start)
// of the script for AI-flag bit i (0 = Basic). Each instruction is an opcode word (index into aicmd.h) followed by its
// argument words; a jump argument is relative: target = (index of the jump word) + 1 + value.
import type { Pokemon } from '@pkmn/sim';
import * as K from './constants';
import * as G from './gen4';

export class UnimplementedAICommand extends Error {
  constructor(what: string) { super(`Unimplemented AI command: ${what}`); this.name = 'UnimplementedAICommand'; }
}

const wordCache = new WeakMap<Uint8Array, Int32Array>();
export function aiWords(seq: Uint8Array): Int32Array {
  let w = wordCache.get(seq);
  if (!w) {
    const dv = new DataView(seq.buffer, seq.byteOffset, seq.byteLength);
    w = new Int32Array(seq.byteLength >> 2).map((_, i) => dv.getInt32(i * 4, true));
    wordCache.set(seq, w);
  }
  return w;
}

/** What the AI "knows" that is not plain battle state (AIContext.battlerMoves/Abilities/HeldItems, fakeOut turns). */
export interface Knowledge {
  /** Moves the player's active Pokémon has been seen using (TrainerAI_RecordLastMove), ROM ids. */
  seenMoves: number[];
  /** Ability / held item of the player's active Pokémon once announced in the battle log (Showdown names). */
  ability?: string;
  item?: string;
  /** moveEffectsData.fakeOutTurnNumber per side (totalTurns + 1 at switch-in). */
  fakeOut: { p1: number; p2: number };
}

export interface Env extends G.Ctx {
  atk: Pokemon; // AI_CONTEXT.attacker (Cynthia's active)
  def: Pokemon; // AI_CONTEXT.defender (the player's active)
  know: Knowledge;
  rolls: number[]; // moveDamageRolls
  totalTurns: number;
}

/** Scores Cynthia's 4 move slots for every AI flag bit set (TrainerAI_Init + TrainerAI_MainSingles' eval loop). */
export function scoreMoves(env: Env, words: Int32Array, aiFlags: number, scores: number[]): { escape: boolean } {
  const vm = { temp: 0, escape: false };
  const slots = G.moveSlots(env.atk);
  for (let bit = 0; bit < 32; bit++) {
    if (!(aiFlags & (1 << bit))) continue;
    for (let slot = 0; slot < 4; slot++) {
      const s = slots[slot];
      const move = s && s.pp > 0 ? G.moveId(s.id) : 0;
      if (!move) { scores[slot] = 0; continue; }
      run(env, words, words[bit], slot, move, scores, vm);
      if (vm.escape) return vm; // AI_STATUS_FLAG_BREAK
    }
  }
  return vm;
}

function run(env: Env, w: Int32Array, start: number, slot: number, move: number, scores: number[],
  vm: { temp: number; escape: boolean }) {
  const { atk, def } = env;
  let cur = start;
  const stack: number[] = [];
  const r = () => {
    if (cur < 0 || cur >= w.length) throw new UnimplementedAICommand(`cursor out of range (${cur})`);
    return w[cur++];
  };
  const br = (cond: boolean) => { const j = r(); if (cond) cur += j; };
  const mon = (code: number): Pokemon => {
    if (code === K.B_ATTACKER) return atk;
    if (code === K.B_DEFENDER || code > 3) return def; // AIScript_Battler: default -> defender
    throw new UnimplementedAICommand(`partner battler ${code} in a single battle`);
  };
  const md = (m: number) => G.romMove(env, m);
  const known = (p: Pokemon) => (p === atk ? G.movesOf(atk) : env.know.seenMoves);
  const partyBench = (p: Pokemon) => G.party(p.side).filter(q => q !== p.side.active[0]);
  const fakeOut = (p: Pokemon) => (p === atk ? env.know.fakeOut.p2 : env.know.fakeOut.p1);
  const add = (v: number) => {
    const s = ((scores[slot] + v) << 24) >> 24; // moveScore is s8
    scores[slot] = s < 0 ? 0 : s;
  };
  const canDamage = (m: number) => {
    const e = md(m).effect;
    return K.ALT_POWER_EFFECTS.has(e) || (md(m).power > 1 && !K.NO_DAMAGE_CALC_EFFECTS.has(e));
  };
  const effectiveness = (m: number) => { // shared by CalcMaxEffectiveness / IfMoveEffectivenessEquals
    let { damage, flags } = G.applyTypeChart(env, m, G.moveType(env, atk, m), atk, def, K.TM_BASE);
    damage = damage === K.TM_STAB * 2 ? K.TM_DOUBLE : damage === K.TM_STAB * 4 ? K.TM_QUAD
      : damage === K.TM_STAB / 2 ? K.TM_HALF : damage === K.TM_STAB / 4 ? K.TM_QUARTER : damage;
    return flags & K.MS_IMMUNE ? K.TM_IMMUNE : damage;
  };
  /** LoadBattlerAbility / CheckBattlerAbility knowledge rules for the opponent. */
  const guessAbilities = (p: Pokemon): number[] | number => {
    if (env.know.ability) return G.abilityNum(env.know.ability);
    const real = G.abilityNum(p.ability);
    if (['shadowtag', 'magnetpull', 'arenatrap'].includes(p.ability)) return real; // self-announcing trappers
    return (env.data.species[p.species.num]?.abilities ?? []).map(G.abilityNum);
  };
  const stat = (p: Pokemon, s: number) => (s === 0 ? p.hp : p.storedStats[K.STAT_KEYS[s] as 'atk']);

  for (let steps = 0; ; steps++) {
    if (steps > 100000) throw new UnimplementedAICommand('runaway script');
    const at = cur;
    const op = r();
    const name = K.OPCODES[op]?.[0] ?? `opcode ${op}`;
    switch (op) {
      case K.OP.IfRandomLessThan: { const v = r(); br(env.rand() % 256 < v); break; }
      case K.OP.IfRandomGreaterThan: { const v = r(); br(env.rand() % 256 > v); break; }
      case K.OP.IfRandomEqualTo: { const v = r(); br(env.rand() % 256 === v); break; }
      case K.OP.IfRandomNotEqualTo: { const v = r(); br(env.rand() % 256 !== v); break; }
      case K.OP.AddToMoveScore: add(r()); break;
      case K.OP.IfHPPercentLessThan: case K.OP.IfHPPercentGreaterThan:
      case K.OP.IfHPPercentEqualTo: case K.OP.IfHPPercentNotEqualTo: {
        const p = mon(r()), v = r(), pct = Math.floor(p.hp * 100 / p.maxhp);
        br([pct < v, pct > v, pct === v, pct !== v][op - K.OP.IfHPPercentLessThan]);
        break;
      }
      case K.OP.IfStatus: { const p = mon(r()); br((G.statusBits(p) & r()) !== 0); break; }
      case K.OP.IfNotStatus: { const p = mon(r()); br((G.statusBits(p) & r()) === 0); break; }
      case K.OP.IfVolatileStatus: { const p = mon(r()); br((G.volatileBits(p) & r()) !== 0); break; }
      case K.OP.IfNotVolatileStatus: { const p = mon(r()); br((G.volatileBits(p) & r()) === 0); break; }
      case K.OP.IfMoveEffect: { const p = mon(r()); br((G.moveEffectBits(p) & r()) !== 0); break; }
      case K.OP.IfNotMoveEffect: { const p = mon(r()); br((G.moveEffectBits(p) & r()) === 0); break; }
      case K.OP.IfSideCondition: { const p = mon(r()); br((G.sideBits(p.side) & r()) !== 0); break; }
      case K.OP.IfNotSideCondition: { const p = mon(r()); br((G.sideBits(p.side) & r()) === 0); break; }
      case K.OP.IfLoadedLessThan: br(vm.temp < r()); break;
      case K.OP.IfLoadedGreaterThan: br(vm.temp > r()); break;
      case K.OP.IfLoadedEqualTo: case K.OP.IfTempEqualTo: br(vm.temp === r()); break;
      case K.OP.IfLoadedNotEqualTo: case K.OP.IfTempNotEqualTo: br(vm.temp !== r()); break;
      case K.OP.IfLoadedMask: br((vm.temp & r()) !== 0); break;
      case K.OP.IfLoadedNotMask: br((vm.temp & r()) === 0); break;
      case K.OP.IfMoveEqualTo: br(move === r()); break;
      case K.OP.IfMoveNotEqualTo: br(move !== r()); break;
      case K.OP.IfLoadedInTable: case K.OP.IfLoadedNotInTable: {
        const ofs = r(), jump = r();
        let found = false;
        for (let i = cur + ofs; (w[i] >>> 0) !== 0xffffffff; i++) if (w[i] === vm.temp) { found = true; break; }
        if (found === (op === K.OP.IfLoadedInTable)) cur += jump;
        break;
      }
      case K.OP.IfAttackerHasDamagingMoves: br(G.movesOf(atk).some(m => m && md(m).power)); break;
      case K.OP.IfAttackerHasNoDamagingMoves: br(!G.movesOf(atk).some(m => m && md(m).power)); break;
      case K.OP.LoadTurnCount: vm.temp = env.totalTurns; break;
      case K.OP.LoadTypeFrom: {
        const which = r();
        if (which === 4) vm.temp = G.romType(md(move).type);
        else if (which < 4) vm.temp = G.types(which & 1 ? atk : def)[which >> 1];
        else throw new UnimplementedAICommand(`LoadTypeFrom partner (${which})`);
        break;
      }
      case K.OP.LoadMovePower: vm.temp = md(move).power; break;
      case K.OP.FlagMoveDamageScore: {
        const vary = r() === 1;
        if (canDamage(move)) {
          const { vals } = G.aiCalcAllDamage(env, atk, def, G.movesOf(atk), vary ? env.rolls : null);
          vm.temp = vals.some(v => v > vals[slot]) ? K.AI_NOT_HIGHEST_DAMAGE : K.AI_MOVE_IS_HIGHEST_DAMAGE;
        } else vm.temp = K.AI_NO_COMPARISON_MADE;
        break;
      }
      case K.OP.LoadBattlerPreviousMove: vm.temp = G.moveId(mon(r()).lastMove); break;
      case K.OP.IfSpeedCompareEqualTo: { const v = r(); br(G.compareSpeed(env, atk, def) === v); break; }
      case K.OP.IfSpeedCompareNotEqualTo: { const v = r(); br(G.compareSpeed(env, atk, def) !== v); break; }
      case K.OP.CountAlivePartyBattlers: vm.temp = partyBench(mon(r())).filter(G.alive).length; break;
      case K.OP.LoadCurrentMove: vm.temp = move; break;
      case K.OP.LoadCurrentMoveEffect: vm.temp = md(move).effect; break;
      case K.OP.LoadBattlerAbility: {
        const code = r(), p = mon(code);
        if (p.volatiles.gastroacid) vm.temp = 0;
        else if (p === atk) vm.temp = G.abilityNum(p.ability);
        else {
          const g = guessAbilities(p);
          vm.temp = typeof g === 'number' ? g : g.length > 1 && g[0] && g[1] ? g[env.rand() & 1 ? 0 : 1] : g[0] || g[1] || 0;
        }
        break;
      }
      case K.OP.CheckBattlerAbility: {
        const p = mon(r()), expected = r();
        let a: number;
        if (p.volatiles.gastroacid) a = 0;
        else if (p === atk) a = G.abilityNum(p.ability);
        else {
          const g = guessAbilities(p);
          a = typeof g === 'number' ? g : g[0] && g[1] ? (g[0] !== expected && g[1] !== expected ? g[0] : 0) : g[0] || g[1] || 0;
        }
        vm.temp = a === 0 ? K.AI_UNKNOWN : a === expected ? K.AI_HAVE : K.AI_NOT_HAVE;
        break;
      }
      case K.OP.CalcMaxEffectiveness:
        vm.temp = Math.max(K.TM_IMMUNE, ...G.movesOf(atk).filter(Boolean).map(effectiveness)); break;
      case K.OP.IfMoveEffectivenessEquals: { const v = r(); br(effectiveness(move) === v); break; }
      case K.OP.IfPartyMemberStatus: case K.OP.IfPartyMemberNotStatus: {
        const p = mon(r()), mask = r(), want = op === K.OP.IfPartyMemberStatus;
        br(partyBench(p).some(q => G.alive(q) && ((G.statusBits(q) & mask) !== 0) === want));
        break;
      }
      case K.OP.LoadCurrentWeather: {
        const f = G.fieldBits(env);
        vm.temp = K.AI_WEATHER_CLEAR;
        if (f & K.FIELD_RAIN) vm.temp = K.AI_WEATHER_RAINING;
        if (f & K.FIELD_SAND) vm.temp = K.AI_WEATHER_SANDSTORM;
        if (f & K.FIELD_SUN) vm.temp = K.AI_WEATHER_SUNNY;
        if (f & K.FIELD_HAIL) vm.temp = K.AI_WEATHER_HAILING;
        break;
      }
      case K.OP.IfCurrentMoveEffectEqualTo: br(md(move).effect === r()); break;
      case K.OP.IfCurrentMoveEffectNotEqualTo: br(md(move).effect !== r()); break;
      case K.OP.IfStatStageLessThan: case K.OP.IfStatStageGreaterThan:
      case K.OP.IfStatStageEqualTo: case K.OP.IfStatStageNotEqualTo: {
        const s = G.stage(mon(r()), r()), v = r();
        br([s < v, s > v, s === v, s !== v][op - K.OP.IfStatStageLessThan]);
        break;
      }
      case K.OP.IfCurrentMoveKills: case K.OP.IfCurrentMoveDoesNotKill: {
        const roll = r() === 1 ? env.rolls[slot] : 100;
        const jump = r();
        if (canDamage(move)) {
          const dmg = G.aiCalcDamage(env, move, atk, def, roll);
          if ((def.hp <= dmg) === (op === K.OP.IfCurrentMoveKills)) cur += jump;
        }
        break;
      }
      case K.OP.IfMoveKnown: case K.OP.IfMoveNotKnown: case K.OP.IfMoveEffectKnown: case K.OP.IfMoveEffectNotKnown: {
        const code = r(), v = r(), jump = r();
        if (code !== K.B_ATTACKER && code !== K.B_DEFENDER) break; // partner: absent in singles (curHP 0) -> no jump
        const byEffect = op === K.OP.IfMoveEffectKnown || op === K.OP.IfMoveEffectNotKnown;
        const has = known(mon(code)).some(m => (byEffect ? m !== 0 && md(m).effect === v : m === v));
        if (has === (op === K.OP.IfMoveKnown || op === K.OP.IfMoveEffectKnown)) cur += jump;
        break;
      }
      case K.OP.IfBattlerUnderEffect: {
        const p = mon(r()), check = r();
        br(check === 0 ? !!p.volatiles.disable : check === 1 ? !!p.volatiles.encore : false);
        break;
      }
      case K.OP.IfCurrentMoveMatchesEffect: {
        const check = r(), v = check === 0 ? atk.volatiles.disable : check === 1 ? atk.volatiles.encore : undefined;
        br(!!v && G.moveId(v.move) === move);
        break;
      }
      case K.OP.Escape: vm.escape = true; return;
      case K.OP.LoadHeldItem: vm.temp = G.itemNum(mon(r()).item); break;
      case K.OP.LoadHeldItemEffect: {
        const p = mon(r());
        vm.temp = G.holdEffect(env, p === atk ? G.itemNum(p.item) : G.itemNum(env.know.item ?? ''));
        break;
      }
      case K.OP.IfHeldItemEqualTo: {
        const p = mon(r()), v = r();
        br((p === atk ? G.itemNum(p.item) : G.itemNum(env.know.item ?? '')) === v);
        break;
      }
      case K.OP.LoadGender: vm.temp = G.genderId(mon(r())); break;
      case K.OP.LoadIsFirstTurnInBattle: vm.temp = fakeOut(mon(r())) < env.totalTurns ? 0 : 1; break;
      case K.OP.LoadStockpileCount: vm.temp = (mon(r()).volatiles.stockpile as { layers?: number })?.layers ?? 0; break;
      case K.OP.LoadBattleType: vm.temp = K.BATTLE_TYPE_TRAINER | (env.battle.gameType === 'doubles' ? K.BATTLE_TYPE_DOUBLES : 0); break;
      case K.OP.LoadRecycleItem: vm.temp = G.itemNum(mon(r()).lastItem); break;
      case K.OP.LoadTypeOfLoadedMove: vm.temp = G.romType(md(vm.temp).type); break;
      case K.OP.LoadPowerOfLoadedMove: vm.temp = md(vm.temp).power; break;
      case K.OP.LoadEffectOfLoadedMove: vm.temp = md(vm.temp).effect; break;
      case K.OP.LoadProtectChain: { // approximation: Showdown keeps no Gen 4 protectSuccessTurns counter
        const p = mon(r()), last = G.moveId(p.lastMove);
        vm.temp = [G.MOVE.PROTECT, G.MOVE.DETECT, G.MOVE.ENDURE].includes(last) && p.volatiles.stall ? 1 : 0;
        break;
      }
      case K.OP.PushAndGoTo: {
        const j = r();
        stack.push(cur);
        if (stack.length > 8) throw new UnimplementedAICommand('AI script stack overflow');
        cur += j;
        break;
      }
      case K.OP.GoTo: { const j = r(); cur += j; break; }
      case K.OP.PopOrEnd: if (stack.length) { cur = stack.pop()!; break; } return;
      case K.OP.IfLevel: {
        const how = r(), a = atk.level, d = def.level;
        br(how === 0 ? a > d : how === 1 ? a < d : how === 2 ? a === d : false);
        break;
      }
      case K.OP.IfTargetIsTaunted: br(!!def.volatiles.taunt); break;
      case K.OP.IfTargetIsNotTaunted: br(!def.volatiles.taunt); break;
      case K.OP.IfTargetIsPartner: br(false); break; // singles: the defender is always an opponent
      case K.OP.FlagBattlerIsType: { const p = mon(r()); vm.temp = G.hasType(p, r()) ? 1 : 0; break; }
      case K.OP.IfActivatedFlashFire: br(!!mon(r()).volatiles.flashfire); break;
      case K.OP.IfFieldConditionsMask: br((G.fieldBits(env) & r()) !== 0); break;
      case K.OP.LoadSpikesLayers: {
        const p = mon(r()), cond = r();
        const sc = p.side.sideConditions as Record<string, { layers?: number }>;
        if (cond === K.SIDE.spikes) vm.temp = sc.spikes?.layers ?? 0;
        else if (cond === K.SIDE.toxicspikes) vm.temp = sc.toxicspikes?.layers ?? 0;
        break;
      }
      case K.OP.IfAnyPartyMemberIsWounded: br(partyBench(mon(r())).some(q => q.hp !== q.maxhp)); break;
      case K.OP.IfAnyPartyMemberUsedPP: br(partyBench(mon(r())).some(q => q.moveSlots.some(s => s.pp !== s.maxpp))); break;
      case K.OP.LoadFlingPower: {
        const p = mon(r());
        vm.temp = p.volatiles.embargo ? 0 : (p.getItem().fling?.basePower ?? 0);
        break;
      }
      case K.OP.LoadCurrentMovePP: vm.temp = G.moveSlots(atk)[slot]?.pp ?? 0; break;
      case K.OP.IfCanUseLastResort: { // lastResortCount approximated by Showdown's moveSlot.used flags
        const p = mon(r()), n = p.moveSlots.length;
        const used = p.moveSlots.filter(s => s.used && s.id !== 'lastresort').length;
        br(used >= n - 1 && n > 1);
        break;
      }
      case K.OP.LoadCurrentMoveClass: vm.temp = G.moveClass(env, move); break;
      case K.OP.LoadDefenderLastUsedMoveClass: vm.temp = G.moveClass(env, G.moveId(def.lastMove)); break;
      case K.OP.LoadBattlerSpeedRank: { // battler ids: player = 0, enemy = 1
        const p = mon(r());
        const order = [def, atk];
        if (G.compareSpeed(env, order[0], order[1]) !== K.COMPARE_SPEED_FASTER) order.reverse();
        vm.temp = order.indexOf(p);
        break;
      }
      case K.OP.LoadBattlerTurnCount: vm.temp = env.totalTurns - fakeOut(mon(r())); break;
      case K.OP.IfPartyMemberDealsMoreDamage: {
        const rolls = r() === 1 ? env.rolls : null;
        const mine = G.aiCalcAllDamage(env, atk, def, G.movesOf(atk), rolls).max;
        // As in the ROM, bench moves are evaluated with the ACTIVE battler's stats/ability.
        br(partyBench(atk).some(q => G.alive(q) && G.aiCalcAllDamage(env, atk, def, G.movesOf(q), rolls).max > mine));
        break;
      }
      case K.OP.IfHasSuperEffectiveMove: br(G.hasSuperEffectiveMove(env, atk, def, true)); break;
      case K.OP.IfBattlerDealsMoreDamage: {
        const p = mon(r()), vary = r() === 1;
        const mine = G.aiCalcAllDamage(env, atk, def, G.movesOf(atk), vary ? env.rolls : null).max;
        const prev = G.moveId(p.lastMove);
        const theirs = prev ? G.aiCalcDamage(env, prev, p, def, vary ? env.rolls[slot] : 100) : 0;
        br(theirs > mine);
        break;
      }
      case K.OP.SumPositiveStatStages: {
        const p = mon(r());
        vm.temp = [0, 1, 2, 3, 4, 5, 6, 7].reduce((s, i) => s + Math.max(0, G.stage(p, i) - 6), 0);
        break;
      }
      case K.OP.DiffStatStages: { const p = mon(r()), s = r(); vm.temp = G.stage(p, s) - G.stage(atk, s); break; }
      case K.OP.IfBattlerHasHigherStat: case K.OP.IfBattlerHasLowerStat: case K.OP.IfBattlerHasEqualStat: {
        const p = mon(r()), s = r();
        if (s > 5) throw new UnimplementedAICommand(`${name} stat ${s}`);
        const a = stat(atk, s), b = stat(p, s);
        br([a < b, a > b, a === b][op - K.OP.IfBattlerHasHigherStat]);
        break;
      }
      case K.OP.LoadAbility: vm.temp = G.ability(env, mon(r())); break;
      default: // Dummy3E/3F never advance the cursor (would hang the DS); the rest are doubles-only.
        throw new UnimplementedAICommand(`${name} at word ${at}`);
    }
  }
}
