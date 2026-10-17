# Known deviations from Pokémon Diamond

Honest list of where Daily Cynthia differs from the real game, and why.

## Battle data (ROM vs. Showdown)
`romShowdownDiffs()` compares every species (stats, types, abilities) and move (power, accuracy, PP, type,
category, priority) in the ROM with `@pkmn/sim`'s Gen 4 data. Only two differ, and the ROM values are applied
to Showdown at runtime (`applyRomOverrides`, test `showdown.test.ts`):

| Move | ROM (Diamond) | Showdown Gen 4 | Used |
|---|---|---|---|
| Hypnosis | accuracy 70 | 60 (HGSS value) | 70 |
| Endure | priority +3 | +4 | +3 |

## Damage (verified against the ROM formula)
`src/battle/romdamage.ts` is an independent transcription of Diamond's damage code (pret `battle_lib.c`:
`BattleSystem_CalcMoveDamage`, variance, `ApplyTypeChart`) and of its stat formula. `damage.test.ts` compares all 16
damage rolls, crit and non-crit, against Showdown for thousands of daily-team-vs-Cynthia matchups and for every
damage-affecting ability forced on either side. Stats matched exactly. These differences were found and are patched
to the ROM behavior (`applyRomAbilities`, `applyRomTypeOrder` in `showdown.ts`):

| Case | Diamond | Showdown | 
|---|---|---|
| 2x and 1/2x type pair that cancels (Water vs. Gastrodon, Ghost vs. Spiritomb, Ground vs. Roserade, ...) | entries applied in ROM table order, flooring each: 2*floor(d/2) when the 1/2x entry comes first | netted to 1x (odd d kept), up to 1 HP more |
| Sniper | crit multiplier 3 before the random roll | crit 2, then x1.5 at the end |
| Iron Fist, Rivalry, Dry Skin (fire) | power * n / 100, floored | 4096-based modifier, rounded |
| Heatproof | halves the move's power | halves the attacker's stat (Gen 5+) |
| Technician | never boosts Struggle | boosts Struggle |
| Cynthia's genders | from her PIDs (all female except Lucario) | random |

Not covered by the test: variable-power moves (Gyro Ball, Eruption, Low Kick, ...), weather, screens, stat stages
and held items. Those use Showdown's Gen 4 code unchanged.

## Battle mechanics
- Mechanics come from Pokémon Showdown's Gen 4 simulator, a reimplementation. Its RNG is not the DS RNG, so exact
  damage rolls/crits/accuracy outcomes differ from a real cartridge given the same inputs. Rare edge-case bugs of the
  DS engine that Showdown deliberately or accidentally does not reproduce may differ.
- Cynthia's trainer items (4 Full Restores) are not a Showdown concept. When her AI chooses an item, her turn is
  submitted as a no-op and the item is applied at the start of the turn, before any move — the Gen 4 order.
- Cynthia's level: scaled to 76 by default (`BattleConfig.cynthiaLevel`, `null` = ROM levels 60–66). Species, moves,
  items, natures (from her ROM-computed PIDs) and IVs (30) are untouched; she has 0 EVs as in the game.
- Player team: max IVs, neutral (Hardy) nature, no held items (brief defaults), and 85 EVs in every stat (our call:
  with 0 EVs a random team almost never beats a level-76 Cynthia; see `.claude/skills/gen4-battle-notes`). Configurable in `GenOptions`.
- Bag: the player carries no items, so BAG shows the ROM line "Items can't be used here." RUN shows the ROM line
  "No! There's no running from a Trainer battle!".
- No EXP is awarded (the EXP bar is not drawn).

## Cynthia's AI
- Her AI flags in the Diamond ROM are `0x01` (**Basic** only), like every trainer in the game. Basic mostly removes useless
  moves (immunities, absorb abilities, redundant status/stat moves); it does not chase the strongest move. Harder flags
  can be enabled with `BattleConfig.aiFlags`, but that is not what Diamond does.
- The AI is our TypeScript interpreter of the ROM's own bytecode (`tr_ai_seq.narc`), with command semantics from pret's
  decompilation. Approximations (what the AI "knows" about the player, a simplified damage estimate that Basic only uses
  for a yes/no comparison, Quick Claw ignored in speed checks) are listed in `.claude/skills/gen4-battle-notes`.
- **Item-use quirk, kept on purpose**: `TrainerAI_ShouldUseItem` has no `break`, so one Full Restore use also empties every
  later item slot that passes the "alive Pokémon ≤ items − slot + 1" gate. With 5–6 Pokémon alive Cynthia can use only her
  first Full Restore; at 3 alive one use can burn three. This is read straight from the decompiled C (verified by us);
  we could not confirm it on hardware.
- The AI uses its own Gen 4 RNG stream, not Showdown's.

## Presentation
- **Move animations**: Diamond's own move scripts (`wazaeffect/we.arc`) run in a TypeScript port of the battle animation
  system (`web/src/anim/`): SPL particles (port of Nintendo's particle library, ROM `waza_particle.narc`, drawn with WebGL),
  move backgrounds (`batt_bg.narc` via overlay 8's table, including the scanline "wave" scroll), effect sprites
  (`effectclact`), the per-move sound effects, and all the script functions the 467 move scripts and the common
  animations call (ported from pret's `script_funcs_*.c`; a test fails if any id lacks a port). The common animations
  (`we_sub.narc`: status, stat up/down with the ROM's scrolling patterns, held item, weather each turn, trap/Leech
  Seed/Curse damage, Ingrain) play on the matching battle events. Approximations: DS alpha blending is drawn as canvas
  opacity (EVA/(EVA+EVB)); OBJ-window effects are reduced to their visible result (Harden's gray flash, the stat
  pattern clipped to the silhouette, Camouflage hides the battler behind a fading copy); Mean Look's master-brightness
  flash is a palette fade; weather-dependent script branches take the no-weather branch; the six 3D-polygon particle
  types are drawn as billboards; Transform pixelates but the battler keeps its own sprite; substitute in/out (common
  anims 15/16/25/26) are not triggered. Timing is 30 Hz like the game (pret `main.c` waits two vblanks per frame).
- **Send-out**: the Poké Ball throw is simplified to the white "materialize" grow; cries are the ROM samples.
- **Touch screen**: the ROM composes the battle menus from many BG/OBJ fragments with runtime palette swaps. The
  menus here are drawn in code following the DP layout and colors, with the ROM font and the ROM's own labels
  (FIGHT/BAG/POKéMON/RUN); the idle Poké Ball screen is the ROM image.
- **Palettes picked by elimination**: the platform (building terrain), HP box and message-window palettes were chosen by
  structural evidence (identical palette triples, colour smoothness) plus visual checks, not read from code.
- **Sprite placement**: feet are aligned with the ROM `height` table; `poke_yofs` is not applied (meaning unconfirmed),
  so hovering Pokémon may sit slightly lower than on hardware. Positions of HP boxes and text are hand-measured.
- **Walk-in**: the Champion's room is a 3D NSBMD map in the ROM. A faithful 3D renderer was out of scope, so the room is a
  2D approximation drawn in code. The walking sprites (Lucas/Dawn and Cynthia), the room music (`SEQ_D_LEAGUE`),
  Cynthia's speech (message archive 180) and the encounter music (`SEQ_EYE_CHAMP`) are extracted from the ROM.
  The transition is a three-flash + spiral wipe in the DP style, not a frame-exact copy.
- **Pokétch**: the bottom-screen clock during the walk-in is drawn in code.
- A few UI strings are ours, not the ROM's: "Choose a POKéMON.", "X has no energy left to battle!", "X is already in
  battle!", "You blacked out!", "But it failed!", and the item-damage line.
- **Music**: rendered offline by our own SSEQ sequencer (see the audio section of `.claude/skills/nds-graphics-formats`);
  it uses linear interpolation and a float mixer, so it is slightly cleaner than the DS hardware. No modulation/portamento
  edge cases are used by the rendered tracks.

## Platform
- Extraction runs locally (`python -m tools.extract`), not in the browser. In-browser extraction would need a second,
  TypeScript implementation of every decoder and the music sequencer; the brief allowed this fallback.
- `vite build` deliberately does not copy `extracted/` into `dist/`; a deployed build needs each player's own extracted
  files beside it.
