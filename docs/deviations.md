# Known deviations from Pokémon Diamond

Honest list of where Daily Champion differs from the real game, and why.

## Battle data (ROM vs. Showdown)
`romShowdownDiffs()` compares every species (stats, types, abilities) and move (power, accuracy, PP, type,
category, priority) in the ROM with `@pkmn/sim`'s Gen 4 data. Only two differ, and the ROM values are applied
to Showdown at runtime (`applyRomOverrides`, test `showdown.test.ts`):

| Move | ROM (Diamond) | Showdown Gen 4 | Used |
|---|---|---|---|
| Hypnosis | accuracy 70 | 60 (HGSS value) | 70 |
| Endure | priority +3 | +4 | +3 |

## Battle mechanics
- Mechanics come from Pokémon Showdown's Gen 4 simulator, a reimplementation. Its RNG is not the DS RNG, so exact
  damage rolls/crits/accuracy outcomes differ from a real cartridge given the same inputs. Rare edge-case bugs of the
  DS engine that Showdown deliberately or accidentally does not reproduce may differ.
- Cynthia's trainer items (4 Full Restores) are not a Showdown concept. When her AI chooses an item, her turn is
  submitted as a no-op and the item is applied at the start of the turn, before any move — the Gen 4 order.
- Cynthia's level: scaled to 76 by default (`BattleConfig.cynthiaLevel`, `null` = ROM levels 60–66). Species, moves,
  items, natures (from her ROM-computed PIDs) and IVs (30) are untouched; she has 0 EVs as in the game.
- Player team: max IVs, neutral (Hardy) nature, 0 EVs, no held items (brief defaults; see `GenOptions`).
- Bag: the player carries no items, so BAG shows the ROM line "Items can't be used here." RUN shows the ROM line
  "No! There's no running from a Trainer battle!".
- No EXP is awarded (the EXP bar is not drawn).

## Presentation
- **Move animations**: Diamond's particle/BG move animations are not reproduced. Attacks show a small attacker
  nudge, the target blinks, the ROM hit sound plays and the HP bar drains at the Gen 4 rate (1 px/frame).
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
