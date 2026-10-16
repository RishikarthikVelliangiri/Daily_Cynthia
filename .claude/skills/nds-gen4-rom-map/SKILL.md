---
name: nds-gen4-rom-map
description: Where each data type lives in the Pokémon Diamond (USA, ADAE rev 5) ROM and how it is laid out — text archives, personal/learnset/evo/egg/TM tables, moves, items, trainers, AI bytecode, type chart. Use before touching tools/extract or when a ROM fact is needed.
---

# Diamond ROM map (quick reference)

Full detail with byte layouts and the file tree: `docs/rom-map.md`. Code: `tools/extract/{rom,text,data}.py`. Tests that pin every fact: `tools/tests/test_data.py`.

## Fast facts
- ROM: ADAE rev 5 only (`rom.SUPPORTED`). Find it via `$DC_ROM` or any `*.nds` under the repo.
- `rom.load().narc(path)` raw members; `.narc_lz(path)` LZ10-decompressed members.
- Text: `Messages(rom).archive(n)`. Key archives: 0 move-use, 180 Champion room, 324 battle msgs, 344 items, 362 species (UPPERCASE), 495 stats, 552 abilities, 558 trainer lines, 559 trainer names (9-bit packed, 15 bits/word), 560 classes, 565 types, 588 moves.
- Battle text is in triplets (own / wild / foe's) → foe variant = base + 2.
- Fixed offsets: ARM9 `0xF84EC` TM table, ARM9 `0xF85B4` item→data table, overlay 5 `0x20668` egg moves, overlay 11 `0x30DB8` type chart.
- Cynthia: trainer 267, class 69, AI flags **0x01** (all trainers are 0x01 in DP), 4 Full Restores, Garchomp holds Sitrus Berry. Trainer PIDs via `data.trainer_mon_personality`.
- Variable-power moves have power 1 in `waza_tbl`; accuracy 0 = never misses.
- ROM vs Showdown Gen 4 differs only in Hypnosis accuracy (70 vs 60) and Endure priority (+3 vs +4); `applyRomOverrides` fixes Showdown.

## Gotchas found the hard way
- `ndspy` `idCode` is a bytearray (compare with `bytes(...)`).
- `waza_tbl.narc` has more members than names; slice to the name count.
- `pokegra` NCGRs are encrypted (see nds-graphics-formats). Female-only species only fill the female slots.
- Heredocs through the Bash tool eat backslashes — write Python sources with the Write tool.
- On Windows, print decoded text with `PYTHONIOENCODING=utf-8`.
