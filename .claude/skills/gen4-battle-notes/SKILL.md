---
name: gen4-battle-notes
description: Gen 4 trainer AI (ROM bytecode interpreter), Showdown-vs-ROM differences, and battle engine notes for the Daily Champion project
---

## Trainer AI

Code: `web/src/battle/ai/` — `constants.ts` (opcode table, Gen 4 bitmasks), `gen4.ts` (Showdown -> Gen 4 state
translation, type chart, damage, speed), `interpreter.ts` (bytecode VM), `index.ts` (public API + switch/item/
replacement logic), `ai.test.ts`. Reference: pret/pokeplatinum `src/battle/trainer_ai.c`, `res/battle/tr_ai/script.s`
(Basic_Main ~lines 52-1622), `asm/macros/aicmd.inc`, `include/data/scripts/aicmd.h`, `src/battle/battle_lib.c`.
Read pret only as a reference; never copy it or ROM data into the repo.

### Bytecode layout (`data.aiSeq` = `battle/tr_ai/tr_ai_seq.narc` member 0, 42388 bytes)
- Little-endian 32-bit signed words. Words 0..31 = flag table: word *i* = start (word index from file start) of the
  script for AI-flag bit *i* (0 Basic, 1 EvalAttack, 2 Expert, ... 29 Roamer, 30 Safari, 31 CatchTutorial; 11-28 point
  at `Terminate`). Basic starts at word 32.
- Instruction = opcode word (index into `aicmd.h`, 0 = IfRandomLessThan ... 108 = LoadAbility) + fixed argument words
  (`OPCODES` in constants.ts gives the counts, from `aicmd.inc`).
- Jump argument (always the last arg of `If*`, `GoTo`, `PushAndGoTo`): target = index of the jump word + 1 + value.
- `IfLoaded(Not)InTable` first arg: table = index of that word + 2 + value; table = words terminated by 0xFFFFFFFF.
- The structure matches Platinum but **constants are Diamond's**: e.g. Fling tables contain hold effects 99/79/100/70
  where Platinum has 100/80/101/71 (Platinum inserted HOLD_EFFECT_GIRATINA_BOOST at 2). Never hardcode hold-effect ids;
  `gen4.HE(c, 'Iron Ball')` reads them from ROM item data. Move battle-effect ids, ability/move/item ids are shared.
- Cynthia (trainer 267) has AI flags 0x01 (Basic only) and items [23,23,23,23] (Full Restore x4).

### Decision order (per Cynthia move request) — `chooseAction`
`TrainerAI_PickCommand`: 1) `TrainerAI_ShouldSwitch` -> switch (slot 6 = `BattleAI_PostKOSwitchIn`, then first living
member); 2) `TrainerAI_ShouldUseItem` -> item (engine applies it at turn start via `applyTrainerItem`, p2 passes);
3) `TrainerAI_Main` -> RecordLastMove, Init (score 100 for usable moves / 0 for unusable via Showdown `getMoves()`
disabled flags, damage rolls `100 - rand%16` for slots 0-3), run the script of every set flag bit for each slot
(slot with no move / 0 PP -> 0), pick the max score; ties broken by `rand % count` (slot 0 always a candidate, others
only if they hold a move). Scores are s8 (wrap) then clamped at 0, exactly like `AICmd_AddToMoveScore`.
- RNG: own Gen 4 LCG (`x*0x41C64E6D+0x6073`, value = x>>16) in `AIState.rng`; `battle.prng` is never touched. RNG is
  consumed in ROM order (switch checks, item checks, rolls, script, tie-break).
- Locked battlers (recharge/Outrage/charge turn) return the locked slot without running the AI (the DS never shows the
  command menu then). On any thrown error state is restored, one `console.warn`, highest-base-power usable move.

`TrainerAI_ShouldSwitch` (singles): no switch if trapped (Bind/Mean Look bits, Ingrain, foe Shadow Tag/Arena Trap, foe
Magnet Pull vs Steel — naive, as in ROM) or no living bench. Then in order: Wonder Guard foe and no SE move -> bench mon
with SE move 2/3; >=2 damaging moves all `MOVE_STATUS_INEFFECTIVE` -> bench SE mon 2/3 (rolled twice: both "defenders"
are the same battler in singles) else neutral mon 1/2; last move that hit us is Fire/Water/Electric and bench has Flash
Fire/Water Absorb/Volt Absorb 1/2 (skipped 2/3 of the time if we have an SE move); asleep + Natural Cure + HP>=50%;
then no switch if any SE move (each SE move: 90%) or >=4 positive stat stages; else bench mon immune (1/2) / resistant
(1/3) to the last hit with an SE move against the hitter. AI_PerishSongKO is omitted (pret: never fires).

`TrainerAI_ShouldUseItem`: no items under Embargo. For i in 0..3, slot considered if `i == 0 || aliveMons <=
itemCount - i + 1` (aliveMons includes the active; itemCount = items at battle start, never decremented). Full
Restore: HP < maxHP/4 (int div) and HP > 0. HP items: HP < max/4 or missing HP > heal amount. Status items:
matching status (else-if chain order: sleep, poison, burn, freeze, paralysis, confusion — so Full Heal only fires on
sleep). X items / Guard Spec: only on the battler's first turn. **The ROM loop has no `break`**: once an item is
chosen every later slot that passes the gate is also zeroed in the same call (e.g. Cynthia at 3 alive mons with 4 FR
uses one and loses three). With 6 alive only slot 0 can ever be used; at 5 alive still only slot 0; at <=4 slot 1 opens.
Implemented as in pret; flagged as uncertain (undocumented in pret's bugs list).

`BattleAI_PostKOSwitchIn` (`chooseReplacement`): stage 1 = best `TypeMatchupMultiplier(t1)+(t2)` (u8, overflows like the
ROM: 2x2x40 + 2x2x40 = 320 -> 64) among living bench members (party order breaks ties) that also has an SE move vs the
defender, discarding and retrying otherwise; stage 2 = highest u8 `CalcMoveDamage`+type chart of each bench move
**computed with the fainted battler's stats/ability** (as in ROM); fallback first living member. Party order = ROM order
(`side.team` order), not Showdown's reordered `side.pokemon`; results are converted back to Showdown indices.

### Showdown -> Gen 4 mapping (gen4.ts)
- Types: ROM ids Normal 0 .. Steel 8, ??? 9, Fire 10 .. Dark 17; battler types from `getTypes()` (mono = [t,t]),
  party types from species. Move type/power/effect/category always from ROM `data.moves`.
- Ids: ability/move/item ids = Showdown `num`. `Battler_Ability`: Gastro Acid -> 0 (not Multitype), Gravity/Ingrain
  negate Levitate. Held item hidden by Klutz/Embargo for effects.
- Status: slp -> sleep counter bits 0-2 (`statusState.time`, min 1), psn 1<<3, brn 1<<4, frz 1<<5, par 1<<6,
  tox 1<<7 | stage<<8.
- Volatiles: confusion 0-2, flinch 3, uproar 4-6, bide 8-9, lockedmove 10-11, partiallytrapped 13-15, attract 16,
  focusenergy 20, transformed 21, mustrecharge 22, rage 23, substitute 24, destinybond 25, trapped (Mean Look/Block) 26,
  nightmare 27, curse 28, foresight 29, defensecurl 30, torment 31.
- moveEffectsMask: leechseed 2, lockon 3, perishsong 5, fly/bounce 6, dig 7, minimize 8, charge 9, ingrain 10,
  yawn 11, imprison 13, grudge 14, mudsport 16, watersport 17, dive 18, gastroacid 21, miracleeye 22, powertrick 23,
  aquaring 24, healblock 25, embargo 26, magnetrise 27, shadowforce 29. Never set: IMPRISONED (30), CAMOUFLAGE.
- Side: reflect 0, lightscreen 1, spikes 2, safeguard 3, futuremove 4 / wish 5 (slot conditions), mist 6,
  stealthrock 7, tailwind 8-9, toxicspikes 10, luckychant 12-14. Spikes layers from `sideConditions.*.layers`.
- Field: weather (TEMP bit if it has a duration, PERM bit if duration 0), gravity 12-14, trickroom 16-18, uproar 8 if
  any active has uproar. Deep Fog never.
- Stat stages: 6 + Showdown boost; BATTLE_STAT order hp, atk, def, spe, spa, spd, accuracy, evasion. Raw stats =
  `storedStats`. totalTurns = `battle.turn - 1`. Gender M 0, F 1, N 2.
- Effectiveness: faithful port of `BattleSystem_ApplyTypeChart` over ROM `typechart.json` (order matters; the
  foresight-only Ghost immunities are skipped with Foresight/Scrappy), incl. Levitate/Magnet Rise/Iron Ball/Roost/
  Gravity/Miracle Eye, Wonder Guard (charge-turn effects + Fire Fang don't count as damaging — ROM bug kept), Filter/
  Solid Rock/Expert Belt/Tinted Lens. `IfMoveEffectivenessEquals` starts at 40, so a neutral STAB move = 60 (matches no
  constant), SE STAB 120 -> 80 etc., exactly as the ROM.
- AI knowledge: the player's ability/item count as "known" once announced in the battle log (`-ability`, `-item`,
  `-enditem`, `[from] ability:/item:` with `[of]` deciding the owner); cleared on switch. Unknown abilities: species
  ability list, coin flip between two (RNG), trappers always known. Seen moves = `lastMove` each decision.
  fakeOutTurnNumber = Showdown turn of the last `switch|drag|replace` line (min 1).

### Approximations / uncertainties
- Damage (`calcMoveDamage`, used by FlagMoveDamageScore/IfCurrentMoveKills/PostKO stage 2): base formula, stages
  (Simple/Unaware), burn, screens (singles), weather (Cloud Nine/Air Lock), Flash Fire, Explosion, Technician, Huge/Pure
  Power, Choice Band/Specs, Thick Fat, Heatproof, Dry Skin, Hustle, Guts, Marvel Scale, pinch abilities, Solar Power,
  Sandstorm SpD. Omitted: type-boost items/plates, species items (Light Ball, Thick Club, Soul Dew, DeepSea, orbs),
  Muscle Band/Wise Glasses, Iron Fist, Rivalry, Plus/Minus, Charge, Helping Hand, Mud/Water Sport, Flower Gift, Slow
  Start, powerMul. Basic only uses whether a comparison was made, so this cannot change Cynthia's choices.
- Speed compare: Showdown `getStat('spe')` + Custap/Lagging Tail/Stall/Trick Room + random ties; Quick Claw
  (battleCtx->speedRand) ignored.
- moveHit / moveHitBattler = last `attackedBy` entry. LoadProtectChain = 1 if last move was Protect/Detect/Endure with
  the `stall` volatile, else 0. Last Resort count from `moveSlot.used`. Post-faint replacements may differ by one turn
  in fakeOutTurnNumber (unknown whether the ROM increments totalTurns before end-of-turn switch-ins).
- Item categories (HEAL_* / stat-stage / Guard Spec flags) are not in our extracted item data: a name table in
  index.ts stands in; HP items use `healAmount` (Revive's 254 would count as an HP item).
- `Escape` (wild-only flags) is ignored for trainer battles. If every move scores 0 and the ROM would pick an unusable
  slot, we pick the highest-power usable move. A ROM switch decision is skipped when Showdown reports Cynthia trapped.
- Unimplemented (throw `UnimplementedAICommand`, caught -> fallback): Dummy3E/3F (never advance the cursor on DS),
  CheckIfHighestDamageWithPartner, IfBattlerFainted/NotFainted, LoadTypeFrom partner targets, any partner battler
  code. None are reachable from Basic (verified by a static walk in `ai.test.ts`).
