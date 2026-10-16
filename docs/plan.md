# Daily Champion — Implementation Plan

> **For agentic workers:** Execute with superpowers:executing-plans (native) — the user asked for a single uninterrupted build. Steps use `- [ ]` checkboxes.

**Goal:** A static browser game: one date-seeded puzzle per day, 6 random level-76 Pokémon vs. Champion Cynthia, Gen 4 mechanics, authentic Diamond visuals, all data/assets extracted locally from the user's own ROM.

**Architecture:** Python extraction pipeline (`tools/extract/`) reads the ROM once and writes git-ignored JSON/PNG/WAV to `extracted/`. TypeScript game (`web/`) loads only `extracted/`; battle mechanics via `@pkmn/sim` (Gen 4), Cynthia's AI is a TS interpreter of the ROM's own AI bytecode (`battle/tr_ai/tr_ai_seq.narc`), daily teams from a seeded generator shared by browser and Node CLI.

**Tech Stack:** Python 3.12 + ndspy + Pillow + numpy (pytest). TypeScript + Vite + plain Canvas 2D + `@pkmn/sim` (vitest).

**Spec:** the user's brief (conversation, 2026-10-16). Section numbers below (§) refer to it.

## Decisions taken without a question round (user asked for one pass)

| §9 question | Default taken |
|---|---|
| 1. Player controls | Player picks moves and switches each turn. Bag opens but the player carries no items (generator default "no items"); Run gives the real "No! There's no running…" message. |
| 2. Cynthia difficulty | Same 6 species/moves/items, levels scaled to 76 (configurable `CYNTHIA_LEVEL`, default 76; `null` = original levels). |
| 3. Scoring | First attempt of the UTC day is scored; replays are practice; attempts counter shown. |
| 4. Walk-in | 2D, built from extracted sprites (the Champion room is a 3D NSBMD map; full 3D is out of scope). |
| 5. ROM | **ADAE, Pokémon Diamond (USA) rev 5, English** — detected from header. |

Other calls:
- **Extraction runs as a local build step** (`python -m tools.extract <rom>`), not in-browser. In-browser extraction would mean a second implementation of every parser plus the music synthesizer in TS. The fallback is explicitly allowed by §5.
- **AI reference:** pret/pokeplatinum is public; Diamond's `tr_ai_seq.narc` is byte-identical to Platinum's (verified with `cmp`), so pret's `trainer_ai.c` is used as the spec for command semantics. Nothing from pret is copied into the repo.

## Global Constraints

- Never commit `*.nds`, `extracted/`, `assets-extracted/`, or any generated sprite/audio/data (enforced in `.gitignore` before extraction).
- Game code never reads the ROM; only `extracted/`.
- Daily seed = UTC date `YYYYMMDD`; identical teams everywhere for the same ROM.
- Pool: fully evolved, non-legendary/mythical, National Dex 1–493. Level 76, max IVs, neutral nature (Hardy), random legal ability, no item, 4 legal moves, ≥1 damaging move, no duplicate species.
- Battle screen = authentic Gen 4 look (256×192 ×2 screens, integer pixel scaling). Impeccable only for menus/results/page chrome.
- No backend, accounts, or leaderboards.

## Review Focus

1. Player leaves mid-battle and reloads → the scored attempt must still count as attempted (record the attempt at battle start, not at the end).
2. UTC day rollover while on the result screen → replay must use the date the battle started, not "now".
3. Generator meets a species whose legal moves are all status → that species is rerolled, never shipped (test: generator never emits a set with no damaging move across 1000 seeds).
4. `extracted/` missing or stale → app shows a "run the extractor" screen instead of crashing (test: loader throws a typed `MissingDataError`).
5. AI bytecode hits an unimplemented command → log and fall back to the highest-damage move, never freeze the battle (test: interpreter on unknown opcode returns a legal choice).

---

## M1 — Repo + safety
- [x] `git init`, `.gitignore` (ROM, `extracted/`, generated audio/images).
- [ ] `CLAUDE.md`, this plan, `docs/rom-map.md` stub. Commit.

## M2 — ROM unpack + data JSON (`tools/extract/`, tests in `tools/tests/`)
Files: `rom.py` (open ROM, NARC access by path), `text.py` (Gen 4 text decrypt/decode), `personal.py`, `learnsets.py` (wotbl + TM bits + egg moves + pre-evo inheritance), `evo.py`, `moves.py`, `trainers.py` (trdata/trpoke), `items.py`, `typechart.py`, `__main__.py` (writes `extracted/data/*.json`, `rom-tree.txt`).
- [ ] Text decoder: test that species name 445 == "Garchomp", move 89 == "Earthquake", trainer class of Cynthia == "Champion".
- [ ] personal: 10 spot checks (e.g. Garchomp 108/130/95/80/85/102, Dragon/Ground; Blissey 255/10/10/75/135/55; Shuckle 20/10/230/10/230/5; …).
- [ ] moves: 10 spot checks (Earthquake 100/100/10 Ground physical; Thunderbolt 95/100/15; Quick Attack prio +1; …).
- [ ] learnsets: Garchomp level-up has Dragon Claw; TM26 Earthquake compatible.
- [ ] trainers: Cynthia (Champion) has 6 mons ending in Garchomp; print full team + AI flags.
- [ ] Type chart from ARM9 matches Gen 4 (Ghost→Steel 0.5, Steel resists Dark).
- [ ] Write formats into `docs/rom-map.md` and `.claude/skills/nds-gen4-rom-map/SKILL.md`. Commit.

## M3 — Graphics/audio (`tools/extract/gfx.py`, `audio.py`)
- [ ] NCLR/NCGR (incl. DP pokegra scrambled-sprite decryption) → PNG; NCER/NSCR for battle bg & UI; font from `graphic/font.narc`.
- [ ] Contact sheet `extracted/contact-sheets/pokemon.png` + `trainers.png`, inspected visually.
- [ ] SDAT parse; SWAR→WAV for cries; SSEQ+SBNK+SWAR software sequencer → WAV for Champion theme, victory theme. Verify by listening checks (duration, non-silence) + user spot-check.
- [ ] Skill `.claude/skills/nds-graphics-formats/SKILL.md`. Commit.

## M4 — Daily generator (`web/src/generator/`)
- [ ] `rng.ts`: `mulberry32(seed)`; `seedFromDate(d: Date): number` (UTC YYYYMMDD).
- [ ] `pool.ts`: `buildPool(data): Species[]` (fully evolved = no evo targets in 1–493, minus legendary list).
- [ ] `generate.ts`: `generateTeam(date, data, opts) → PokemonSet[]`; tests: determinism, constraints over 1000 seeds.
- [ ] Winnability: `isWinnable(team, cynthia, n)` with a greedy bot; deterministic reroll (`seed+1…`). CLI reports pass rate over 1000 seeds.

## M5 — Engine + Cynthia AI (`web/src/battle/`)
- [ ] `showdown.ts`: build `@pkmn/sim` gen4 battle with ROM-derived species/move overrides; log ROM↔Showdown diffs to `docs/deviations.md`.
- [ ] `ai/interpreter.ts`: runs `tr_ai_seq` bytecode against an adapter over Showdown state; switching + item use per pret `TrainerAI_ShouldSwitch` / `ShouldUseItem`.
- [ ] Tests: fixed damage calc, type interactions, AI picks super-effective move vs. obvious target, full battle for a sample date ends with a winner.
- [ ] `npm run sim -- 2026-10-16` prints a battle log. Skill `gen4-battle-notes`. Commit.

## M6 — Battle UI (`web/src/scenes/battle/`)
- [ ] Canvas 256×384 (two screens), integer scaling; bg, sprites, HP boxes (green/yellow/red, animated drain), text box + ROM font typewriter, Fight/Bag/Pokémon/Run touch-screen menu, move menu with type/PP, party screen.
- [ ] Audio: battle theme loop, cries, hit SFX, victory.

## M7 — Walk-in + transition
- [ ] 2D Champion room approach using extracted overworld sprites, Cynthia's pre-battle line from ROM text, swirl transition.

## M8 — Results, replay, share, a11y
- [ ] localStorage day record `{date, scoredResult, attempts}`; share grid; keyboard controls, readable-text toggle, mute.

## M9 — Verification
- [ ] Headless runs for 3 dates; browser playthrough screenshots; `docs/deviations.md` complete.
