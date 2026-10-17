# Daily Champion

Wordle-style daily battle vs. Champion Cynthia (Pokémon Diamond). One date-seeded puzzle per UTC day: 6 random legal level-76 Pokémon vs. Cynthia, Gen 4 mechanics, authentic DS look.

## Legal rules (non-negotiable)
- Never commit the ROM (`*.nds`) or anything extracted from it. `extracted/` is git-ignored; keep it that way.
- The repo contains only our code. Users run the extractor against their own ROM.
- Never download ROMs/assets. pret decomps may be read as a *reference* (not copied in).

## Layout
- `tools/extract/` — Python extractor (ndspy). `python -m tools.extract [rom] [--only data|gfx|audio|anim]` → `extracted/`.
- `tools/tests/` — pytest gates against known Gen 4 values (`python -m pytest tools/tests`).
- `web/` — TypeScript + Vite game. Serves `../extracted` as its public dir.
  - `src/generator/` daily team generator, `src/battle/` Showdown wrapper (+ ROM damage cross-check) + Cynthia AI (ROM AI bytecode interpreter), `src/anim/` move animations (ROM script interpreter `system.ts`, ported script functions `funcs.ts`, SPL particle port, WebGL), `src/ui/` canvas scenes. Dev: `?anim=<move>` previews a move animation (468-507 = common anims 1-40).
  - `npm test` (vitest), `npm run dev`, `npm run sim -- YYYY-MM-DD` (headless battle log), `npm run passrate`.
- `docs/rom-map.md` — every decoded ROM format, offsets, archive indices. Read it before touching the extractor.
- `docs/deviations.md` — Showdown vs. real-game differences.
- `.claude/skills/` — project skills: `nds-gen4-rom-map`, `nds-graphics-formats`, `gen4-battle-notes`.

## ROM
Diamond USA (ADAE) rev 5 only. ROM is auto-found as any `*.nds` under the repo, or `$DC_ROM`.
Python: on Windows set `PYTHONIOENCODING=utf-8` when printing decoded text.
