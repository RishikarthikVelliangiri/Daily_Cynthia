# ROM map — Pokémon Diamond (USA), game code ADAE, revision 5, English

Everything below was found by decoding this ROM and checking against known Gen 4 values (tests in
`tools/tests/`). Where pret's decompilation (pokeplatinum / pokediamond, read online as a reference only)
was used to *confirm* a layout, it says so. Multi-byte values are little-endian.

## Header
- Title `POKEMON D`, game code `ADAE`, maker `01`, ROM version byte `5`, 61,169,344 bytes used.
- ARM9 is stored uncompressed (ndspy `rom.arm9`). Overlays via `loadArm9Overlays()`.

## Text (`msgdata/msg.narc`, 624 archives)
Archive: `u16 count, u16 seed`; then `count × (u32 offset, u32 length)` each XOR'd with
`k | k<<16`, `k = seed*0x2FD*(i+1) & 0xFFFF`. String `i` is `u16` chars XOR'd with a rolling key starting
`0x91BD3*(i+1) & 0xFFFF`, `+0x493D` per char. `0xFFFF` ends; `0xE000` newline; `0x25BC` scroll (`\r`);
`0x25BD` new page (`\f`); `0xFFFE cmd argc args…` = variable (`{0101:n}` Pokémon, `{0103}` trainer name,
`{0105}` ability, `{0106}` move, `{0108}` item, `{010D}` stat, `{010E}` trainer class, `{0134}` number).
`0xF100` = 9-bit packed string (15 bits used per u16 word, terminator `0x1FF`) — used by trainer names.
Character table: `0x0121–0x012A` 0–9, `0x012B–0x0144` A–Z, `0x0145–0x015E` a–z, `0x015F–0x01A9` accents/symbols,
`0x01AA–0x01DE` punctuation (`0x01DE` space). See `tools/extract/text.py`.

| Archive | Contents |
|---|---|
| 0 | "X used MOVE!" — index `move*3 + {0 own, 1 wild, 2 foe}` |
| 3 | Battle UI labels (PHYSICAL/SPECIAL/…) |
| 180 | Champion room script (0 = pre-battle speech, 1 = after battle) |
| 324 | Battle messages (1260; triplets own/wild/foe). Key indices in `web/src/battle/protocol.ts` |
| 344 | Item names (465) |
| 362 | Species names, uppercase (496) |
| 495 | Stat names |
| 552 | Ability names (124) |
| 558 | Trainer battle lines (indexed by `trtbl` row) |
| 559 | Trainer names (850, 9-bit packed) — Cynthia = 267 |
| 560 | Trainer class names — Champion = 69 |
| 565 | Type names, uppercase (18) |
| 587 | Move descriptions |
| 588 | Move names (468) |

## Pokémon
- `poketool/personal/personal.narc` (one 44-byte record per species, index = National Dex):
  `+0` HP, Atk, Def, Spe, SpA, SpD (u8 each); `+6/+7` types; `+8` catch rate; `+9` base exp; `+10` u16 EV yield;
  `+12/+14` u16 wild items; `+16` gender ratio (0 male-only, 254 female-only, 255 genderless); `+17` egg cycles;
  `+18` friendship; `+19` growth; `+20/+21` egg groups; `+22/+23` abilities; `+24` flee; `+25` color;
  `+28..+43` TM/HM compatibility bits (bit k = TM k+1; bits 92–99 = HM01–08).
  Type ids: 0 Normal,1 Fighting,2 Flying,3 Poison,4 Ground,5 Rock,6 Bug,7 Ghost,8 Steel,9 ???,10 Fire,11 Water,12 Grass,13 Electric,14 Psychic,15 Ice,16 Dragon,17 Dark.
- `poketool/personal/wotbl.narc`: level-up learnset per species, `u16 = move | level<<9`, `0xFFFF` end.
- `poketool/personal/evo.narc`: 7 × `(u16 method, u16 param, u16 target)` per species.
- Egg moves: **overlay 5 @ 0x20668**, u16 stream `20000+species, moves…`, `0xFFFF` end.
- TM/HM → move: **ARM9 @ 0xF84EC**, `u16[100]` (TM01 Focus Punch … TM92 Trick Room, HM01 Cut … HM08 Rock Climb).
- Tutor moves: not decoded (DP's few tutors are hard-coded in scripts); not used by the generator.

## Moves — `poketool/waza/waza_tbl.narc` (16 bytes each, 468 used)
`u16 effect, u8 category (0 phys, 1 spec, 2 status), u8 power, u8 type, u8 accuracy (0 = never misses),
u8 pp, u8 effect chance, u16 target, s8 priority, u8 flags, u8 contest effect, u8 contest type, u16 pad`.
Variable-power moves store power 1 (e.g. Mirror Coat, Low Kick).

## Type chart — overlay 11 @ 0x30DB8
`u8` triplets `(attacker, defender, multiplier×10)`; `FE FE 00` separates the Foresight-only rows
(Normal/Fighting → Ghost); `FF` ends.

## Items
- `itemtool/itemdata/item_data.narc`, 34-byte records: `+0 u16 price`, `+2` hold effect, `+3` hold param,
  `+27` heal amount (`0xFF` full, `0xFE` half). Partially decoded (only battle-relevant fields).
- Item id → record index: **ARM9 @ 0xF85B4**, 8 bytes per item id (`u16 data, u16 icon, u16 palette, u16 ?`).

## Trainers
- `poketool/trainer/trdata.narc`, 20 bytes: `u8 party type (bit0 moves, bit1 item), u8 class, u8 sprite?, u8 party size,
  u16 items[4], u32 AI flags, u32 battle type`. Field order confirmed by pret `TrainerDataParam`.
- `poketool/trainer/trpoke.narc`: per mon `u8 difficulty (IV = d*31/255), u8 ability/gender flags, u16 level,
  u16 species (bits 10–15 form), [u16 item], [u16 moves[4]]`.
- **Cynthia = trainer 267**, class 69 (Champion), items 4 × Full Restore (23), **AI flags 0x01 (Basic only)**
  — every trainer in this ROM (846/850) has 0x01. Party: Spiritomb 61, Roserade 60, Gastrodon 60, Lucario 63,
  Milotic 63, Garchomp 66 @ Sitrus Berry; difficulty 250 → IV 30.
- Trainer Pokémon PID (pret `TrainerData_BuildParty`): seed LCRNG with `difficulty+level+species+trainerID`,
  step it `class` times, `PID = (rnd<<8) + (120 female class | 136 male)`; nature = PID % 25, ability slot = PID & 1.
  Cynthia's natures: Jolly, Naughty, Calm, Timid, Sassy, Timid.
- `poketool/trmsg/trtbl.narc` rows `(u16 trainer, u16 type)`; `trtblofs.narc` u16 byte offset per trainer.
  Row k's text is archive 558 entry k. Cynthia: lastMon (15), lastMonHalfHp (16), defeat (1).

## Trainer AI — `battle/tr_ai/tr_ai_seq.narc` member 0
Bytecode, **byte-identical to Platinum's** (verified with `cmp` against pret pokeplatinum's prebuilt NARC), so
pret's `script.s` documents it exactly. See `.claude/skills/gen4-battle-notes`.

## Graphics
- `poketool/pokegra/pokegra.narc`: 6 files per species (`species*6`): F-back, M-back, F-front, M-front NCGR
  (160×80, two 80×80 frames, 4bpp scanned, **encrypted**), normal NCLR, shiny NCLR. Female-only species use only the F slots.
  DP encryption: XOR u16 words back-to-front with the Gen 4 LCRNG seeded by the last word.
- `poketool/pokegra/height.narc`: 4 × u8 per species = empty rows under the sprite (F-back, M-back, F-front, M-front).
  `poke_yofs.narc`: s8 per species (purpose unconfirmed; not used).
- `poketool/trgra/trfgra.narc`: (NCGR, NCLR) per class → Cynthia at 138/139. `trbgra.narc`: player backs (0 Lucas, 2 Dawn).
- `battle/graphic/batt_bg.narc` (LZ10): backdrop k (0–11) = NCGR `3+k` (8bpp) + NSCR 2 (512×256) + NCLR `158+3k+timeOfDay`.
  The Champion room's MapHeader `battle_bg` = **7** (pret pokediamond `map_header.c`). Message window = NCGR 0 + NSCR 1 + NCLR 196.
  Touch-screen sheets 15–29, screens 30–37 (idle Poké Ball screen = 17 + 37 with NCLR 157).
- `battle/graphic/batt_obj.narc` (LZ10): platforms enemy (90 + cells 91), player (87 + 88); HP boxes enemy (124 + 123),
  player (127 + 126). Terrain palettes `1 + 3*terrain + tod` (identical triples at 19–21 cave, 28–30 building);
  HP box palette 36. Palette choices for platform/HP box/window were made by elimination + visual check — **unverified against hardware**.
- `graphic/font.narc` member 0: `u32 hdr, u32 widths_off, u32 count (509), u8 maxW, h, tilesW, tilesH`; glyphs 16×16
  2bpp, each 8-px row a big-endian u16 (pixel 0 in the top bits); values 1 text, 2 shadow, 3 background. Glyph i = char code i+1.
- `data/mmodel/mmodel.narc` (BTX0 textures, 32×32 frames): hero 90, heroine 91, champion 117. Frames 1–4 up, 5–8 down, 9–12 left, 13–16 right.

## Move animations (`tools/extract/anim.py` -> `extracted/anim/`)
- `wazaeffect/we.arc` (501 members, member = move id): battle animation bytecode, u32 words; command table and
  argument counts identical to Platinum (pret `include/data/scripts/btlanimcmd.h`, `asm/macros/btlanimcmd.inc`);
  45 CallFunc / 55 SetExtraParams / 78 AddSpriteWithFunc carry a count. All 501 disassemble cleanly.
- `wazaeffect/effectdata/waza_particle.narc` (485): SPL resources, magic `" APS"` version `"12_1"`; header 0x20, resource
  header 0x58 + optional scale/color/alpha/tex anims (12/12/8/12), child (20), behaviors (8/8/16/4/8/16); textures 0x20
  header + data + palette. Only A3I5 (1) and A5I3 (6) textures; repeat/flip mirroring is common.
- Overlay 8: particle world positions (8 battler types x 12 kinds x persp/ortho VecFx32) right after the particle camera
  eye (1.4375, 4.8125, -1.0); 8 emitter-axis tables (6x6 VecFx32, order differs from Platinum); the 58-row effect-BG
  table (NCGR, NCLR, NSCR, NSCR reversed, NSCR contest) into `battle/graphic/batt_bg.narc` (LZ).
- `wazaeffect/we_sub.narc` (50 members): common animations in the same bytecode, member order = pret
  `res/battle/scripts/common_anims/anim_subscripts.order` (1 sleep, 2 poison, 3 burn, 4 freeze, 5 paralysis,
  6 confusion, 10 held item, 12 stat up, 13 stat down, 14 restore HP, 19-22 rain/hail/sandstorm/sun, 30-40 damage
  curse/nightmare/leech seed/bind/wrap/fire spin/magma storm/clamp/whirlpool/sand tomb/ingrain). Script function ids
  match Platinum's table (80-83 = StatChangeUp/Down/Heal/Metal).
- Stat-change overlays: overlay 8 table of 4 x (NCGR, NCLR, NSCR, NSCR) into `batt_bg.narc`, first row (48, 207, 49, 49):
  up, down, heal, metal patterns (512x512, content in the left 256 columns) -> `extracted/anim/bg/stat{0..3}.png`.
- Sprite templates (AddSprite / AddSpriteWithFunc) name their wechar/wepltt/wecell/wecellanm members directly
  (resource id = member + 5000), so effect sprites are keyed by the template, not by the last Load* command.
- `wazaeffect/effectclact/{wechar,wepltt,wecell,wecellanm}.narc`: effect OAM sprites (NCGR/NCLR/NCER/NANR).
  NANR sequences are 16 bytes (u16 frames, start, element, type; u32 mode, frame offset); offsets relative to block data.
- Particle camera: eye (0,0,4), fovY index 45° passed as the half angle; battle default projection is orthographic
  (8 world units per screen height, 172 fx32 per pixel).

## Audio — `data/sound/sound_data.sdat`
See `.claude/skills/nds-graphics-formats` (Audio section). Cries: bank list position = National Dex number
(names for 387–493 are development numbers). BGM: `SEQ_BA_CHANP`, `SEQ_WINCHAMP`, `SEQ_EYE_CHAMP`, `SEQ_D_LEAGUE`.

## File tree (id, path, bytes)
```
  87 application/custom_ball/data/cb_data.narc 60812
  88 application/wifi_earth/wifi_earth.narc 152180
  89 application/wifi_earth/wifi_earth_place.narc 3272
  90 application/zukanlist/zkn_data/zukan_data.narc 22552
  91 application/zukanlist/zkn_data/zukan_enc_diamond.narc 71648
  92 application/zukanlist/zkn_data/zukan_enc_pearl.narc 71624
  93 arc/bm_anime.narc 37376
  94 arc/bm_anime_list.narc 15032
  95 arc/encdata_ex.narc 1828
  96 arc/ppark.narc 3020
  97 arc/ship_demo.narc 95064
  98 arc/tv.narc 896
  99 battle/b_tower/btdpm.narc 22876
 100 battle/b_tower/btdtr.narc 33728
 101 battle/graphic/b_bag_gra.narc 20228
 102 battle/graphic/b_plist_gra.narc 74408
 103 battle/graphic/batt_bg.narc 640124
 104 battle/graphic/batt_obj.narc 131676
 105 battle/graphic/vs_demo_gra.narc 20864
 106 battle/skill/be_seq.narc 16892
 107 battle/skill/sub_seq.narc 51000
 108 battle/skill/waza_seq.narc 6416
 109 battle/tr_ai/tr_ai_seq.narc 42448
 110 contest/data/contest_data.narc 14140
 111 contest/graphic/contest_bg.narc 80708
 112 contest/graphic/contest_obj.narc 23844
 113 data/area00light.txt 2082
 114 data/area01light.txt 2024
 115 data/area02light.txt 2114
 116 data/battle_win.NSCR 2084
 117 data/btower_canm.resdat 52
 118 data/btower_celact.cldat 64
 119 data/btower_cell.resdat 52
 120 data/btower_chr.resdat 52
 121 data/btower_pal.resdat 52
 122 data/cell0.NCGR 8240
 123 data/cell0.NCLR 552
 124 data/clact_default.NANR 111
 125 data/crystal.nsbmd 3332
 126 data/demo_climax.narc 472620
 127 data/dp_areawindow.NCGR 368
 128 data/dp_areawindow.NCLR 552
 129 data/dt_test_celact.txt 54
 130 data/dt_test_res_cell.txt 38
 131 data/dt_test_res_cellanm.txt 38
 132 data/dt_test_res_char.txt 43
 133 data/dt_test_res_multi.txt 16
 134 data/dt_test_res_multianm.txt 16
 135 data/dt_test_res_pltt.txt 45
 136 data/dun_sea.nsbtx 1400
 137 data/eoo.dat 286720
 138 data/exdata.dat 292
 139 data/field_cutin.narc 53792
 140 data/fld_anime0.bin 72
 141 data/fld_anime1.bin 72
 142 data/fld_anime10.bin 72
 143 data/fld_anime2.bin 72
 144 data/fld_anime3.bin 72
 145 data/fld_anime4.bin 72
 146 data/fld_anime5.bin 72
 147 data/fld_anime6.bin 72
 148 data/fld_anime7.bin 72
 149 data/fld_anime8.bin 72
 150 data/fld_anime9.bin 72
 151 data/fs_kanban.nsbca 2036
 152 data/ground0.NCGR 32816
 153 data/ground0.NCLR 552
 154 data/ground0.NSCR 2084
 155 data/kemu_itpconv.dat 20
 156 data/lake_anim.nsbtx 4432
 157 data/miniasahamabe.nsbtx 4488
 158 data/miniasasea.nsbtx 1400
 159 data/minihamabe.nsbtx 4488
 160 data/minimum.nsbtx 1400
 161 data/minirhana.nsbtx 712
 162 data/namein.narc 16216
 163 data/nfont.NCGR 32816
 164 data/nfont.NCLR 552
 165 data/pc.nsbca 396
 166 data/plist_canm.resdat 196
 167 data/plist_cell.resdat 196
 168 data/plist_chr.resdat 316
 169 data/plist_h.cldat 416
 170 data/plist_pal.resdat 148
 171 data/porucase_canm.resdat 76
 172 data/porucase_celact.cldat 96
 173 data/porucase_cell.resdat 76
 174 data/porucase_chr.resdat 76
 175 data/porucase_pal.resdat 52
 176 data/pst_canm.resdat 436
 177 data/pst_cell.resdat 436
 178 data/pst_chr.resdat 1060
 179 data/pst_h.cldat 1408
 180 data/pst_pal.resdat 172
 181 data/shop_canm.resdat 100
 182 data/shop_cell.resdat 100
 183 data/shop_chr.resdat 100
 184 data/shop_h.cldat 128
 185 data/shop_pal.resdat 76
 186 data/slot.narc 88388
 187 data/smptm_koori.NANR 163
 188 data/smptm_koori.NCER 215
 189 data/smptm_koori.NCGR 3248
 190 data/smptm_koori.NCLR 552
 191 data/smptm_nemuri.NANR 111
 192 data/smptm_nemuri.NCER 99
 193 data/smptm_nemuri.NCGR 560
 194 data/smptm_nemuri.NCLR 552
 195 data/t3_fl_b.nsbtx 592
 196 data/t3_fl_p.nsbtx 592
 197 data/t3_fl_r.nsbtx 592
 198 data/t3_fl_y.nsbtx 592
 199 data/test.atr 2048
 200 data/tmap_block.dat 4372
 201 data/tmap_flags.dat 732
 202 data/tmapn_canm.resdat 148
 203 data/tmapn_celact.cldat 192
 204 data/tmapn_celact.txt 268
 205 data/tmapn_cell.resdat 148
 206 data/tmapn_chr.resdat 148
 207 data/tmapn_pal.resdat 76
 208 data/tmapn_res_canm.txt 170
 209 data/tmapn_res_cell.txt 186
 210 data/tmapn_res_chr.txt 220
 211 data/tmapn_res_pal.txt 149
 212 data/tradelist.narc 10868
 213 data/trapmark.narc 612
 214 data/ug_anim.narc 23680
 215 data/ug_base_cur.nsbmd 1684
 216 data/ug_boygirl.NCGR 4656
 217 data/ug_boygirl.NCLR 552
 218 data/ug_fossil.narc 16088
 219 data/ug_hero.NANR 249
 220 data/ug_hero.NCER 265
 221 data/ug_hole.NANR 214
 222 data/ug_hole.NCER 162
 223 data/ug_hole.NCGR 1328
 224 data/ug_parts.narc 133020
 225 data/ug_radar.narc 14440
 226 data/ug_trap.narc 121772
 227 data/ugeffect_obj_graphic.narc 19816
 228 data/uground_cell.resdat 76
 229 data/uground_cellanm.resdat 76
 230 data/uground_char.resdat 76
 231 data/uground_char2.resdat 76
 232 data/uground_clact.cldat 96
 233 data/uground_pltt.resdat 52
 234 data/uground_pltt2.resdat 52
 235 data/underg_radar.narc 41524
 236 data/UTF16.dat 490
 237 data/utility.bin 898240
 238 data/weather_sys.narc 63656
 239 data/wifi.ncgr 576
 240 data/wifinote.narc 14668
 241 data/wifip2pmatch.narc 15892
 242 data/wm.ncgr 576
 243 data/wm.nclr 552
 244 data/mmodel/fldeff.narc 114328
 245 data/mmodel/mmodel.narc 1213532
 246 data/sound/sound_data.sdat 7484768
 247 demo/egg/data/egg_data.narc 11004
 248 demo/egg/data/particle/egg_demo_particle.narc 9708
 249 demo/intro/intro.narc 111500
 250 demo/intro/intro_tv.narc 57312
 251 demo/shinka/data/particle/shinka_demo_particle.narc 9364
 252 demo/syoujyou/syoujyou.narc 25796
 253 demo/title/op_demo.narc 618888
 254 demo/title/titledemo.narc 228112
 255 dwc/utility.bin 898240
 256 fielddata/areadata/area_data.narc 996
 257 fielddata/areadata/area_build_model/area_build.narc 4724
 258 fielddata/areadata/area_build_model/areabm_texset.narc 1201332
 259 fielddata/areadata/area_map_tex/map_tex_set.narc 1256784
 260 fielddata/areadata/area_move_model/move_model_list.narc 1240
 261 fielddata/build_model/build_model.narc 1918412
 262 fielddata/build_model/build_model_matshp.dat 5924
 263 fielddata/encountdata/d_enc_data.narc 79108
 264 fielddata/encountdata/p_enc_data.narc 79108
 265 fielddata/eventdata/zone_event_release.narc 140020
 266 fielddata/land_data/land_data_release.narc 14778156
 267 fielddata/mapmatrix/map_matrix.narc 11800
 268 fielddata/maptable/mapname.bin 8944
 269 fielddata/mm_list/move_model_list.narc 612
 270 fielddata/pokemon_trade/fld_trade.narc 404
 271 fielddata/script/scr_seq_release.narc 219608
 272 graphic/bag_gra.narc 105588
 273 graphic/box.narc 113440
 274 graphic/btower.narc 16888
 275 graphic/config_gra.narc 684
 276 graphic/demo_trade.narc 31512
 277 graphic/dendou_demo.narc 1564
 278 graphic/dendou_pc.narc 668
 279 graphic/ending.narc 333468
 280 graphic/ev_pokeselect.narc 140580
 281 graphic/f_note_gra.narc 10620
 282 graphic/field_board.narc 43260
 283 graphic/field_encounteffect.narc 38664
 284 graphic/fld_comact.narc 868
 285 graphic/font.narc 134744
 286 graphic/fontoam.narc 1444
 287 graphic/hiden_effect.narc 32276
 288 graphic/imageclip.narc 255536
 289 graphic/mail_gra.narc 106800
 290 graphic/menu_gra.narc 19312
 291 graphic/mysign.narc 4280
 292 graphic/mystery.narc 30916
 293 graphic/ntag_gra.narc 183920
 294 graphic/nutmixer.narc 180980
 295 graphic/oekaki.narc 5412
 296 graphic/opening.narc 27580
 297 graphic/plist_gra.narc 40108
 298 graphic/pmsi.narc 12644
 299 graphic/poketch.narc 58820
 300 graphic/poru_gra.narc 27108
 301 graphic/poruact.narc 5292
 302 graphic/porudemo.narc 8812
 303 graphic/pst_gra.narc 127152
 304 graphic/ranking.narc 5320
 305 graphic/record.narc 22980
 306 graphic/shop_gra.narc 10048
 307 graphic/tmap_gra.narc 85776
 308 graphic/touch_subwindow.narc 2456
 309 graphic/trainer_case.narc 228320
 310 graphic/unionroom.narc 4624
 311 graphic/waza_oshie_gra.narc 12084
 312 graphic/winframe.narc 35044
 313 graphic/worldtrade.narc 46808
 314 itemtool/itemdata/item_data.narc 19500
 315 itemtool/itemdata/item_icon.narc 395440
 316 itemtool/itemdata/nuts_data.narc 1332
 317 msgdata/msg.narc 2695184
 318 msgdata/scenario/scr_msg.narc 6748
 319 particledata/particledata.narc 34300
 320 pokeanime/poke_anm.narc 25412
 321 poketool/pokezukan.narc 1048
 322 poketool/shinzukan.narc 364
 323 poketool/icongra/poke_icon.narc 577776
 324 poketool/personal/evo.narc 26104
 325 poketool/personal/growtbl.narc 3348
 326 poketool/personal/personal.narc 26104
 327 poketool/personal/pms.narc 1002
 328 poketool/personal/wotbl.narc 18752
 329 poketool/pokeanm/pokeanm.narc 13892
 330 poketool/pokefoot/pokefoot.narc 58604
 331 poketool/pokegra/height.narc 23108
 332 poketool/pokegra/height_o.narc 1684
 333 poketool/pokegra/otherpoke.narc 890604
 334 poketool/pokegra/poke_shadow.narc 556
 335 poketool/pokegra/poke_shadow_ofx.narc 556
 336 poketool/pokegra/poke_yofs.narc 556
 337 poketool/pokegra/pokegra.narc 11778676
 338 poketool/trainer/trdata.narc 23852
 339 poketool/trainer/trpoke.narc 21908
 340 poketool/trgra/trbgra.narc 52340
 341 poketool/trgra/trfgra.narc 640580
 342 poketool/trmsg/trtbl.narc 9604
 343 poketool/trmsg/trtblofs.narc 1760
 344 poketool/waza/waza_tbl.narc 11356
 345 resource/eng/trial/trial.narc 56292
 346 resource/eng/zukan/zukan.narc 72988
 347 wazaeffect/we.arc 254028
 348 wazaeffect/we_sub.narc 12324
 349 wazaeffect/effectclact/wecell.narc 5364
 350 wazaeffect/effectclact/wecellanm.narc 4688
 351 wazaeffect/effectclact/wechar.narc 33076
 352 wazaeffect/effectclact/wepltt.narc 4480
 353 wazaeffect/effectdata/ball_particle.narc 321604
 354 wazaeffect/effectdata/waza_particle.narc 2381840
 355 wazaeffect/pt_debug/debug_particle.narc 3016
```
