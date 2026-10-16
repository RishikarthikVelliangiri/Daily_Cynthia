// Champion Cynthia's trainer AI: the ROM's AI bytecode (interpreter.ts) plus the C-side decision layer of
// pret/pokeplatinum trainer_ai.c (TrainerAI_PickCommand -> ShouldSwitch -> ShouldUseItem -> TrainerAI_Main) and
// battle_lib.c (BattleAI_PostKOSwitchIn). See .claude/skills/gen4-battle-notes/SKILL.md "Trainer AI".
import type { Battle, Pokemon } from '@pkmn/sim';
import type { GameData, Trainer } from '../../data';
import * as K from './constants';
import * as G from './gen4';
import { aiWords, type Env, type Knowledge, scoreMoves } from './interpreter';

export { UnimplementedAICommand } from './interpreter';

export type AIDecision =
  | { kind: 'move'; slot: number }     // index into battle.p2.active[0].moveSlots
  | { kind: 'switch'; slot: number }   // index into battle.p2.pokemon (Showdown side order)
  | { kind: 'item'; item: number };    // ROM item id from trainer.items (e.g. 23 = Full Restore)

export interface AIState {
  /** Gen 4 LCG state (x * 0x41C64E6D + 0x6073), separate from Showdown's PRNG. */
  rng: number;
  trainerName: string;
  /** AIContext.trainerItems: used slots become 0 (never compacted). */
  items: number[];
  /** AIContext.trainerItemCounts: number of items at battle start; the ROM never decrements it. */
  itemCount: number;
  /** Item chosen by chooseAction and already removed from `items`, awaiting applyTrainerItem. */
  pendingItem: number;
  /** AIContext.battlerMoves for the player's active Pokémon; `key` = log index of its switch-in (cleared on switch). */
  seen: { key: number; moves: number[] };
}

export function createAIState(trainer: Trainer, seed: number): AIState {
  const items = trainer.items.filter(Boolean).slice(0, 4);
  return { rng: seed >>> 0, trainerName: trainer.name, items, itemCount: items.length, pendingItem: 0,
    seen: { key: -1, moves: [] } };
}

const nextRand = (s: AIState) => {
  s.rng = (Math.imul(s.rng, 0x41c64e6d) + 0x6073) >>> 0;
  return s.rng >>> 16;
};
const ctx = (battle: Battle, data: GameData, state: AIState): G.Ctx =>
  ({ battle, data, rand: () => nextRand(state), speeds: new Map() });

/** Reads what the AI would have been told: announced abilities/items of the player's active, switch-in turns. */
function scanLog(battle: Battle): Knowledge & { key: number } {
  const k: Knowledge & { key: number } = { seenMoves: [], fakeOut: { p1: 1, p2: 1 }, key: -1 };
  let turn = 0;
  battle.log.forEach((line, idx) => {
    const parts = line.split('|'), cmd = parts[1], side = parts[2]?.slice(0, 2);
    if (cmd === 'turn') turn = +parts[2];
    if ((cmd === 'switch' || cmd === 'drag' || cmd === 'replace') && (side === 'p1' || side === 'p2')) {
      k.fakeOut[side] = Math.max(1, turn); // fakeOutTurnNumber = totalTurns + 1, totalTurns = Showdown turn - 1
      if (side === 'p1') { k.ability = k.item = undefined; k.key = idx; }
    }
    if (cmd === '-ability' && side === 'p1') k.ability = parts[3];
    if ((cmd === '-item' || cmd === '-enditem') && side === 'p1') k.item = parts[3];
    const owner = line.match(/\[of\] (p\d)/)?.[1] ?? side;
    if (owner !== 'p1' || cmd === '-ability') return;
    const fa = line.match(/\[from\] ability: ([^|]+)/), fi = line.match(/\[from\] item: ([^|]+)/);
    if (fa) k.ability = fa[1];
    if (fi) k.item = fi[1];
  });
  return k;
}

// ------------------------------------------------------------------------------------------- switching
interface Sw { c: G.Ctx; atk: Pokemon; def: Pokemon; party: Pokemon[] }
/** Bench members the C code may switch to (alive, not the active battler), with their ROM party index. */
const bench = ({ party, atk }: Sw) => party.map((q, i) => [q, i] as const).filter(([q]) => G.alive(q) && q !== atk);
const lastHit = (p: Pokemon) => {
  const a = p.attackedBy[p.attackedBy.length - 1];
  return { move: a ? G.moveId(a.move) : 0, source: a?.source ?? null };
};
const benchEff = (c: G.Ctx, q: Pokemon, m: number, def: Pokemon) => G.calcEffectiveness(c, m, G.moveType(c, q, m),
  G.abilityNum(q.ability), G.ability(c, def), G.itemEffect(c, def), ...G.types(def));

/** AI_HasPartyMemberWithSuperEffectiveMove */
function partyMemberSE(s: Sw, check: number, mod: number): number | null {
  const { c } = s, hit = lastHit(s.atk), src = hit.source;
  if (!hit.move || !src || !G.romMove(c, hit.move).power) return null;
  for (const [q, i] of bench(s)) {
    const f = G.calcEffectiveness(c, hit.move, G.moveType(c, src, hit.move), G.ability(c, src), G.abilityNum(q.ability),
      G.holdEffect(c, G.itemNum(q.item)), ...G.types(q, true));
    if (!(f & check)) continue;
    for (const m of G.movesOf(q)) if (m && benchEff(c, q, m, src) & K.MS_SUPER && c.rand() % mod === 0) return i;
  }
  return null;
}

/** TrainerAI_ShouldSwitch: party index to switch to, 6 = "use post-KO logic", null = don't switch. */
function shouldSwitch(s: Sw): number | null {
  const { c, atk, def } = s;
  const defAb = G.ability(c, def);
  if (G.volatileBits(atk) & K.VOL_TRAPPED || atk.volatiles.ingrain || defAb === G.ABILITY.SHADOWTAG
    || defAb === G.ABILITY.ARENATRAP || (defAb === G.abilityNum('magnetpull') && G.hasType(atk, K.T.STEEL))) return null;
  if (!bench(s).length) return null;
  // AI_PerishSongKO: pret documents it as never firing (the counter decrements at end of turn) -> omitted.

  // AI_CannotDamageWonderGuard
  if (G.abilityNum(def.ability) === G.ABILITY.WONDERGUARD
    && !G.movesOf(atk).some(m => m && G.applyTypeChart(c, m, G.moveType(c, atk, m), atk, def, 0).flags & K.MS_SUPER)) {
    for (const [q, i] of bench(s)) for (const m of G.movesOf(q)) {
      if (m && benchEff(c, q, m, def) & K.MS_SUPER && c.rand() % 3 < 2) return i;
    }
  }
  // AI_OnlyIneffectiveMoves (singles: "both" defenders are the same battler, so every roll happens twice)
  const dmg = G.movesOf(atk).filter(m => m && G.romMove(c, m).power);
  if (dmg.length >= 2 && dmg.every(m => G.applyTypeChart(c, m, G.moveType(c, atk, m), atk, def, 0).flags & K.MS_INEFFECTIVE)) {
    for (const [q, i] of bench(s)) for (const m of G.movesOf(q)) {
      if (!m || !G.romMove(c, m).power) continue;
      const f = G.alive(def) ? benchEff(c, q, m, def) : 0;
      if (f & K.MS_SUPER && c.rand() % 3 < 2) return i;
      if (f & K.MS_SUPER && c.rand() % 3 < 2) return i;
    }
    for (const [q, i] of bench(s)) for (const m of G.movesOf(q)) {
      if (!m || !G.romMove(c, m).power) continue;
      const f = G.alive(def) ? benchEff(c, q, m, def) : 0;
      if (f === 0 && c.rand() % 2 === 0) return i;
      if (f === 0 && c.rand() % 2 === 0) return i;
    }
  }
  // AI_HasAbsorbAbilityInParty
  if (!(G.hasSuperEffectiveMove(c, atk, def, true) && c.rand() % 3 !== 0)) {
    const hit = lastHit(atk);
    const t = hit.move && G.romMove(c, hit.move).power ? G.romType(G.romMove(c, hit.move).type) : -1;
    const check = G.abilityNum(({ [K.T.FIRE]: 'flashfire', [K.T.WATER]: 'waterabsorb', [K.T.ELECTRIC]: 'voltabsorb' } as
      Record<number, string>)[t] ?? '');
    if (check && G.ability(c, atk) !== check) {
      for (const [q, i] of bench(s)) if (G.abilityNum(q.ability) === check && c.rand() & 1) return i;
    }
  }
  // AI_IsAsleepWithNaturalCure
  if (G.statusBits(atk) & K.MON_SLEEP && G.ability(c, atk) === G.abilityNum('naturalcure')
    && atk.hp >= Math.trunc(atk.maxhp / 2)) {
    const hit = lastHit(atk);
    if (!hit.move && c.rand() & 1) return 6;
    if (!G.romMove(c, hit.move).power && c.rand() & 1) return 6;
    const r = partyMemberSE(s, K.MS_INEFFECTIVE, 1) ?? partyMemberSE(s, K.MS_NOT_VERY, 1);
    if (r !== null) return r;
    if (c.rand() & 1) return 6;
  }
  if (G.hasSuperEffectiveMove(c, atk, def, false)) return null;
  if ([0, 1, 2, 3, 4, 5, 6, 7].reduce((n, st) => n + Math.max(0, G.stage(atk, st) - 6), 0) >= 4) return null;
  return partyMemberSE(s, K.MS_INEFFECTIVE, 2) ?? partyMemberSE(s, K.MS_NOT_VERY, 3);
}

/** BattleAI_PostKOSwitchIn (keeps the ROM's u8 score overflow); 6 = nothing found. */
function postKOSwitchIn(s: Sw): number {
  const { c, atk, def, party } = s;
  const [d1, d2] = G.types(def);
  // Stage 1: best offensive type matchup that also has a super-effective move (ties -> party order).
  for (let ignored = 0; ignored !== 0x3f;) {
    let max = 0, picked = 6;
    party.forEach((q, i) => {
      if (!G.alive(q) || ignored & (1 << i) || q === atk) { ignored |= 1 << i; return; }
      const [m1, m2] = G.types(q, true);
      const score = (G.typeMatchup(c, m1, d1, d2) + G.typeMatchup(c, m2, d1, d2)) & 0xff;
      if (max < score) { max = score; picked = i; }
    });
    if (picked === 6) break;
    const q = party[picked];
    if (G.movesOf(q).some(m => m && benchEff(c, q, m, def) & K.MS_SUPER)) return picked;
    ignored |= 1 << picked;
  }
  // Stage 2: highest damage of each bench move as if used by the battler that just fainted (u8 score).
  let max = 0, picked = 6, score = 0;
  party.forEach((q, i) => {
    if (!G.alive(q) || q === atk) return;
    for (const m of G.movesOf(q)) {
      if (m && G.romMove(c, m).power !== 1) {
        score = G.calcMoveDamage(c, m, 0, 0, atk, def) & 0xff;
        const r = G.applyTypeChart(c, m, G.moveType(c, q, m), atk, def, score);
        score = r.flags & K.MS_IMMUNE ? 0 : r.damage & 0xff;
      }
      if (max < score) { max = score; picked = i; }
    }
  });
  return picked;
}

// ------------------------------------------------------------------------------------------- items
/** ROM item flags we don't extract (ITEM_PARAM_HEAL_* / *_STAGES / GUARD_SPEC), keyed by ROM item name. The value is
 * the FIRST flag in TrainerAI_ShouldUseItem's else-if chain that the item has (so Full Heal only fires on sleep). */
const ITEM_KIND: Record<string, string> = {
  'Awakening': 'slp', 'Full Heal': 'slp', 'Lava Cookie': 'slp', 'Old Gateau': 'slp', 'Heal Powder': 'slp',
  'Antidote': 'psn', 'Burn Heal': 'brn', 'Ice Heal': 'frz', 'Parlyz Heal': 'par', 'Yellow Flute': 'confusion',
  'X Attack': 'atk', 'X Defend': 'def', 'X Special': 'spa', 'X Sp. Def': 'spd', 'X Speed': 'spe',
  'X Accuracy': 'accuracy', 'Guard Spec.': 'guard',
};
const STATUS_OF: Record<string, string[]> = { slp: ['slp'], psn: ['psn', 'tox'], brn: ['brn'], frz: ['frz'], par: ['par'] };

/** TrainerAI_ShouldUseItem. Faithful to the ROM including its missing `break`: once an item is chosen, every later
 * slot that passes the "alive mons <= itemCount - i + 1" gate is also emptied in the same call. */
function shouldUseItem(c: G.Ctx, state: AIState, atk: Pokemon, fakeOut: number, totalTurns: number): number | null {
  if (atk.volatiles.embargo) return null;
  const aliveMons = G.party(atk.side).filter(G.alive).length;
  let result = false, used = 0;
  for (let i = 0; i < 4; i++) {
    if (!(i === 0 || aliveMons <= state.itemCount - i + 1)) continue;
    const item = state.items[i];
    if (!item) continue;
    const it = c.data.items[item], kind = ITEM_KIND[it?.name ?? ''];
    if (item === K.ITEM_FULL_RESTORE) {
      if (atk.hp < Math.trunc(atk.maxhp / 4) && atk.hp) result = true;
    } else if (it?.healAmount && !kind) {
      if (atk.hp && (atk.hp < Math.trunc(atk.maxhp / 4) || atk.maxhp - atk.hp > it.healAmount)) result = true;
    } else if (kind && STATUS_OF[kind]) {
      if (STATUS_OF[kind].includes(atk.status)) result = true;
    } else if (kind === 'confusion') {
      if (atk.volatiles.confusion) result = true;
    } else if (kind && fakeOut - totalTurns >= 0) { // stat boosters: only on the battler's first turn
      if (kind !== 'guard' || !atk.side.sideConditions.mist) result = true;
    }
    if (result) { used = item; state.items[i] = 0; }
  }
  return result ? used : null;
}

/** Apply a trainer item to Cynthia's active Pokémon and log it. */
export function applyTrainerItem(battle: Battle, data: GameData, state: AIState, item: number): void {
  const p = battle.p2.active[0], it = data.items[item];
  if (state.pendingItem === item) state.pendingItem = 0;
  else if (state.items.includes(item)) state.items[state.items.indexOf(item)] = 0;
  if (!p || p.fainted || !it) return;
  battle.add('-message', `${state.trainerName} used ${it.name}!`);
  const kind = ITEM_KIND[it.name];
  if (item === K.ITEM_FULL_RESTORE || (it.healAmount && !kind)) {
    const amount = it.healAmount >= 255 || item === K.ITEM_FULL_RESTORE ? p.maxhp : it.healAmount;
    if (p.heal(amount)) battle.add('-heal', p, p.getHealth);
    if (item === K.ITEM_FULL_RESTORE) {
      if (p.status) p.cureStatus();
      if (p.volatiles.confusion) p.removeVolatile('confusion');
    }
  } else if (kind === 'slp' && it.name !== 'Awakening') { // full-heal type items cure everything
    if (p.status) p.cureStatus();
    if (p.volatiles.confusion) p.removeVolatile('confusion');
  } else if (kind && STATUS_OF[kind]) {
    if (STATUS_OF[kind].includes(p.status)) p.cureStatus();
  } else if (kind === 'confusion') {
    p.removeVolatile('confusion');
  } else if (kind === 'guard') {
    p.side.addSideCondition('mist', p);
  } else if (kind) {
    battle.boost({ [kind]: 1 }, p, p);
  }
}

// ------------------------------------------------------------------------------------------- public API
let warned = false;
function fallbackMove(p: Pokemon): AIDecision {
  let best = 0, bp = -1;
  p.moveSlots.forEach((s, i) => {
    const power = G.moveId(s.id) ? (p.battle.dex.moves.get(s.id).basePower ?? 0) : 0;
    if (s.pp > 0 && !s.disabled && power > bp) { bp = power; best = i; }
  });
  return { kind: 'move', slot: best };
}
const showdownIndex = (battle: Battle, romIndex: number) =>
  battle.p2.pokemon.indexOf(G.party(battle.p2)[romIndex]);

/** TrainerAI_PickCommand + TrainerAI_Main for Cynthia's move request. Never throws. */
export function chooseAction(battle: Battle, data: GameData, state: AIState, aiFlags: number): AIDecision {
  const atk = battle.p2.active[0], def = battle.p1.active[0];
  // A locked battler (recharge, Outrage, charge turn) never reaches the command menu in Gen 4: no AI, no RNG.
  const locked = atk.getLockedMove();
  if (locked) return { kind: 'move', slot: Math.max(0, atk.moveSlots.findIndex(s => s.id === locked)) };
  const saved = JSON.stringify(state);
  try {
    const c = ctx(battle, data, state);
    const know = scanLog(battle);
    const totalTurns = battle.turn - 1;
    const party = G.party(battle.p2);
    const s: Sw = { c, atk, def, party };

    // 1. TrainerAI_ShouldSwitch (skipped if Showdown says Cynthia can't switch, which the ROM check doesn't model)
    const req = battle.p2.activeRequest as { active?: { trapped?: boolean }[] } | null;
    let sw = req?.active?.[0]?.trapped ? null : shouldSwitch(s);
    if (sw !== null) {
      if (sw === 6) {
        sw = postKOSwitchIn(s);
        if (sw === 6) sw = party.findIndex(q => G.alive(q) && q !== atk);
      }
      if (sw >= 0) return { kind: 'switch', slot: showdownIndex(battle, sw) };
    }
    // 2. TrainerAI_ShouldUseItem
    const item = shouldUseItem(c, state, atk, know.fakeOut.p2, totalTurns);
    if (item !== null) { state.pendingItem = item; return { kind: 'item', item }; }

    // 3. TrainerAI_Main: RecordLastMove, Init (scores 100/0 + damage rolls), run the script per flag, pick max.
    if (state.seen.key !== know.key) state.seen = { key: know.key, moves: [] };
    const last = G.moveId(def.lastMove), seen = state.seen.moves;
    if (last && !seen.includes(last) && seen.length < 4) seen.push(last);
    const usable = atk.getMoves().map(m => !m.disabled);
    const slots = G.moveSlots(atk);
    const scores = slots.map((sl, i) => (sl && usable[i] ? 100 : 0));
    const rolls = [0, 1, 2, 3].map(() => 100 - (c.rand() % 16));
    const env: Env = { ...c, atk, def, know: { ...know, seenMoves: seen }, rolls, totalTurns };
    scoreMoves(env, aiWords(data.aiSeq), aiFlags, scores); // Escape (wild-only flags) is ignored for trainers
    let best = [0];
    for (let i = 1; i < 4; i++) {
      if (!slots[i]) continue;
      if (scores[i] === scores[best[0]]) best.push(i);
      if (scores[i] > scores[best[0]]) best = [i];
    }
    const pick = best[c.rand() % best.length];
    // If every move scored 0 the ROM may "pick" an unusable slot; Showdown would reject it.
    return usable[pick] ? { kind: 'move', slot: pick } : fallbackMove(atk);
  } catch (e) {
    Object.assign(state, JSON.parse(saved));
    if (!warned) { warned = true; console.warn('[trainer AI] falling back to highest-power move:', e); }
    return fallbackMove(atk);
  }
}

/** Post-faint replacement (BattleAI_PostKOSwitchIn, then first living party member). Index into battle.p2.pokemon. */
export function chooseReplacement(battle: Battle, data: GameData, state: AIState): number {
  const party = G.party(battle.p2), atk = battle.p2.active[0];
  const firstAlive = () => battle.p2.pokemon.findIndex(q => G.alive(q) && q !== atk);
  try {
    const s: Sw = { c: ctx(battle, data, state), atk, def: battle.p1.active[0], party };
    const i = postKOSwitchIn(s);
    return i === 6 ? firstAlive() : showdownIndex(battle, i);
  } catch (e) {
    if (!warned) { warned = true; console.warn('[trainer AI] replacement fallback:', e); }
    return firstAlive();
  }
}
