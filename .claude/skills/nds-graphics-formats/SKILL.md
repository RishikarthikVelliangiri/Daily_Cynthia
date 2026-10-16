---
name: nds-graphics-formats
description: How to decode NDS graphics/audio formats (NCGR/NCLR/NCER/NANR/NSCR/SDAT) in the Diamond ROM and the converters in tools/extract
---

## Graphics (2D + textures)

Code: `tools/extract/gfx.py` (generic decoders) and `tools/extract/gfx_dp.py` (Diamond archive indices). Tests: `tools/tests/test_gfx.py`. Output: `extracted/gfx/` + `extracted/contact-sheets/pokemon-front.png`.

- Nitro container: `u16 header size @0x0C`, `u16 block count @0x0E`; blocks are stored with reversed magic (`TTLP`, `RAHC`, `NRCS`, `KBEC`). `gfx._blocks()` returns block bodies without the 8-byte header.
- **NCLR** (`TTLP`): `u32 depth, u32 ?, u32 size, u32 offset` then BGR555 colors.
- **NCGR** (`RAHC`): `u16 h_tiles, u16 w_tiles, u32 depth (3 = 4bpp, 4 = 8bpp), u32 mapping, u32 scanned(bit0), u32 size, u32 offset`; pixel data at block+0x18. 4bpp low nibble first. Tiled = 8x8 tiles row-major; `ncgr_tiles()` returns storage order for 1D OBJ mapping.
- **DP Pokémon sprite encryption**: XOR u16 words *back-to-front* with LCRNG (`*0x41C64E6D + 0x6073`), seed = last (encrypted) word. Platinum runs front-to-back instead.
- **NSCR** (`NRCS`): `u16 w, u16 h, u32 mode, u32 size`; entries `tile | hflip<<10 | vflip<<11 | pal<<12`. Screens wider/taller than 256 px are stored in 32x32-tile blocks (left→right, top→bottom) — `nscr()` reassembles them.
- **NCER** (`KBEC`): `u16 cells, u16 ext flag (1 → 16-byte cell entries), u32 table offset, u32 mapping (low nibble = tile shift)`; OAM attr0/1/2 → shape/size table in `ncer()`; tile index `<< shift`.
- **Font** (`graphic/font.narc[0]`): see docs/rom-map.md. Each 8-px glyph row is a big-endian u16.
- **NSBTX/TEX0** (`tex0()`): TEX0 `+0x0E u16 tex dict, +0x14 u32 tex data, +0x34 u32 pal dict, +0x38 u32 pal data`. Dict: `u8 0, u8 n, u16 size, u16 8, u16 treeSize`, entries at `dict + treeSize` (`u16 entrySize, u16 sectionSize`, entries, then 16-byte names). Texture params u16 @+2: width `8<<((p>>4)&7)`, height `8<<((p>>7)&7)`, format `(p>>10)&7` (2 = 2bpp, 3 = 4bpp, 4 = 8bpp), bit 13 color-0 transparent. Palette chosen by `<tex>_pl` name or the first palette.
- Palette selection that could not be read from code (platform, HP box, message window) was done by elimination: identical palette triples mark indoor terrains; `bgprobe`-style smoothness scoring (mean neighbour colour delta) picks the right backdrop palette reliably.

## Audio (SDAT)

Code: `tools/extract/audio.py` (`python -m tools.extract --only audio`, ~30 s). Tests: `tools/tests/test_audio.py`.
Output: `extracted/audio/{cry/NNN.wav, bgm_*.ogg, se_*.ogg, manifest.json}`.

### Layout facts relied on
- `data/sound/sound_data.sdat`, parsed with `ndspy.soundArchive.SDAT`: 2133 sequences, 0 SSARs, 1519 banks, 1519 wave archives, 8 players. `a.sequences/banks/waveArchives` are `(name, obj)` lists; **index matters, names can lie**.
- **Cries**: game plays `SEQ_PV001` (tempo 100, prg 0, vol 127, pan 64, one note key 60 vel 127 dur 0) with the bank swapped to bank **index = National Dex no.**. Indices 1-386 are named `BANK_PV001..386`, but 387-493 carry *dev-number* names (e.g. index 445 Garchomp = `BANK_PV493`/`WAVE_ARC_PV493`; there is no `BANK_PV387`). Every one of 1..493 is one single-note instrument, base pitch 60, one non-looped PCM8 SWAV → key 60 = native rate, so cries are dumped raw (8-bit WAV at `16756991/swav.time` Hz). Durations 0.18-2.24 s.
- Champion room / E4 rooms: arm9 map-header table (24-byte entries, u16 msgArchive then u16 musicDay, u16 musicNight; msg archive 180 entry at arm9+0xEFF1C) → `SEQ_D_LEAGUE` day & night (matches pret `map_header.c`). Hall of Fame next entry = `SEQ_BLD_DENDO`.
- Sequences used: `SEQ_BA_CHANP`/`SEQ_WINCHAMP` (BANK_BGM_BATTLE), `SEQ_EYE_CHAMP` (BANK_BASIC), `SEQ_D_LEAGUE` (BANK_BGM_DUNGEON). SE: hit = `SEQ_SE_DP_KOUKA_M`, super = `KOUKA_H`, weak = `KOUKA_L` (効果 high/mid/low), select/confirm = `SEQ_SE_DP_DECIDE`, cursor = `SEQ_SE_DP_SELECT`, HP-low = `SEQ_SE_DP_HINSI` (瀕死; one "pi-po" cycle, the game repeats it). All BGM samples are IMA-ADPCM; KOUKA_* use PSG noise, HINSI uses a PSG square.
- SBNK note def: `waveArchiveIDID` indexes `bank.waveArchiveIDs`; instrument types 1 PCM / 2 PSG square (waveID = duty) / 3 noise / 16 range (`firstPitch`) / 17 regional (`lastPitch`).
- SWAV: loopOffset/length are in 32-bit words. PCM8 = 4 samples/word, PCM16 = 2, ADPCM = 8 minus the 4-byte header (s16 predictor, u8 index; low nibble first; clamp ±0x7FFF).

### Sequencer semantics implemented (raw `sseq.eventsData`, own interpreter)
ndspy's `SSEQ` gives header (`bankID`, `volume`) and raw event bytes; ndspy names 0xC4/0xC5 "portamento"/"portamento range" but they are **pitch bend / bend range**.
- Clock: driver frame = 64*2728/33513982 s (~192 Hz). Each frame `counter += tempo`; while ≥240 → one tick for tracks 0..15 in order. Track: wait-decrement then run commands until a wait is set. Tracks default to note-wait (mono) mode; `C7 0` = poly.
- Opcodes: note (vel, varlen dur), 80 rest, 81 prg, 93 open track, 94 jump, 95 call, FD return, D4/FC loop (0 = infinite), FF end, FE alloc (skip), C0 pan, C1 vol, C2 master vol, C3 transpose, C4 bend (s8), C5 bend range, C7 mono/poly, CA-CD mod depth/speed/type/range, E0 mod delay, D0-D3 ADSR override (255 = instrument's), D5 expression, E1 tempo, E3 sweep pitch. A0-BD (random/var/if) and tie/portamento (C8/C9/CE on) raise NotImplementedError — none of our sequences use them.
- Volume (centibels): `db(seqVol)+db(master)+db(trackVol)+db(expr)+db(velocity)+(envelope>>7)`, `db(x)=40*log10(x/127)` = SNDi_DecibelSquareTable (-723 floor); amplitude `10^(cB/200)`. Pan `trackPan + instPan - 64`, linear L/R.
- Envelope per frame from level -92544: attack `lvl = -((-lvl*A)>>8)` (A = 255-a, or LUT for a≥109), decay/release subtract `fall(x)` (127→0xFFFF, 126→0x3C00, <50→2x+1, else 0x1E00/(126-x)) down to sustain `db(s)<<7` / floor. Key-off after `dur` ticks; dur 0 = no key-off (plays to sample end).
- Pitch in 1/64 semitone: `(key - basePitch)*64 + (bend*range>>1) + LFO`; rate = `16756991/swav.time * 2^(p/768)`. PSG: 8-step square at 3520 Hz for key 69 (A440); noise = 15-bit LFSR.
- LFO: per frame after `delay` frames, counter += speed<<6 (wraps 0x8000), `sin128[counter>>8]*range*depth>>8` (pitch/pan), `*60>>14` cB for volume.
- Loops: a jump/infinite loop end to an offset the track already executed marks (firstTick(target), jumpTick). Simulation stops once every track has ended or looped; loopEnd = latest jump tick, loopStart = that track's target tick. Render intro + one loop body, release tails past loopEnd are folded (added) onto loopStart, so `[loopStart, loopEnd)` loops seamlessly. Manifest stores seconds.

### Known deviations from real DS playback
- Linear sample interpolation (hardware: none) and per-sample amplitude interpolation between frames (hardware: stepped per frame); float mix with fixed gain 0.5 + peak safety, not the 10-bit DS mixer.
- No voice limits/stealing (player channel masks ignored), no priority. Portamento, tie, sweep-with-portamento, variables/random/if not implemented. Mod params speed/type/delay latched at note-on (depth/range follow the track per frame).
- First pass into the loop body also contains the folded loop-end tails (≈ standard loop-folding artifact).
- Output 32728 Hz stereo; OGG Vorbis q6 via ffmpeg (falls back to WAV if ffmpeg/libvorbis missing).
