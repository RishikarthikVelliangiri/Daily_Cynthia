"""Diamond-specific battle asset export. Archive indices were identified by probing (see docs/rom-map.md)."""
import json
import os

import numpy as np

from . import gfx

# batt_bg.narc
BG_SCREEN = 2            # 512x256 8bpp NSCR shared by all 12 backdrops
BG_SHEET0 = 3            # backdrop k sheet = 3 + k (8bpp)
BG_PAL0 = 158            # backdrop k palette = 158 + 3k + time_of_day (indoor k>=6: all 3 identical)
CHAMPION_BG = 7          # MapHeader battle_bg of MAP_POKEMON_LEAGUE_CYNTHIA_ROOM (pret pokediamond)
MSGWIN_SHEET, MSGWIN_SCREEN, MSGWIN_PAL = 0, 1, 196
TOUCH_IDLE = (17, 37)    # (sheet, screen): Poké Ball idle bottom screen
TOUCH_PAL = 157
# batt_obj.narc
PLAT_ENEMY = (90, 91)    # (sheet, cell bank)
PLAT_PLAYER = (87, 88)
PLAT_PAL_BUILDING = 28   # terrain palettes: 1 + 3*terrain + tod; building triple 28..30 is identical
HP_ENEMY = (124, 123)
HP_PLAYER = (127, 126)
HP_PAL = 36
# data/mmodel/mmodel.narc
OW_HERO, OW_HEROINE, OW_CHAMPION = 90, 91, 117


def _full(pal):
    """Pad a palette to 256 colors; a 16-color palette is repeated across all banks."""
    if len(pal) == 16:
        return np.tile(pal, (16, 1))
    out = np.zeros((256, 3), np.uint8)
    out[: min(256, len(pal))] = pal[:256]
    return out


def _cell(ob, sheet, cells, pal_i, k=0):
    img, origin = gfx.render_cell(gfx.ncer(ob[cells])[k], gfx.ncgr_tiles(ob[sheet]), _full(gfx.nclr(ob[pal_i])))
    return img, origin


def extract(rom, g):
    bg = rom.narc_lz("battle/graphic/batt_bg.narc")
    ob = rom.narc_lz("battle/graphic/batt_obj.narc")
    b = os.path.join(g, "battle")
    meta = {}

    scr = gfx.nscr(bg[BG_SCREEN])
    for k in range(12):
        idx, _, _ = gfx.ncgr(bg[BG_SHEET0 + k])
        img = gfx.render_screen(scr, idx, 32, gfx.nclr(bg[BG_PAL0 + 3 * k]), 8)
        gfx.save(img.crop((0, 0, 256, 192)), b, "bg_%02d.png" % k)
    meta["championBg"] = "bg_%02d.png" % CHAMPION_BG

    idx, _, _ = gfx.ncgr(bg[MSGWIN_SHEET])
    win = gfx.render_screen(gfx.nscr(bg[MSGWIN_SCREEN]), idx, 32, _full(gfx.nclr(bg[MSGWIN_PAL])), 4, True)
    gfx.save(win.crop((0, 144, 256, 192)), b, "msgwin.png")

    idx, _, _ = gfx.ncgr(bg[TOUCH_IDLE[0]])
    gfx.save(gfx.render_screen(gfx.nscr(bg[TOUCH_IDLE[1]]), idx, 32, gfx.nclr(bg[TOUCH_PAL]), 4).crop((0, 0, 256, 192)),
             b, "touch_idle.png")

    for name, (sheet, cells), pal in (("platform_enemy", PLAT_ENEMY, PLAT_PAL_BUILDING),
                                      ("platform_player", PLAT_PLAYER, PLAT_PAL_BUILDING),
                                      ("hpbox_enemy", HP_ENEMY, HP_PAL), ("hpbox_player", HP_PLAYER, HP_PAL)):
        img, origin = _cell(ob, sheet, cells, pal)
        gfx.save(img, b, name + ".png")
        meta[name] = {"originX": origin[0], "originY": origin[1], "w": img.width, "h": img.height}
    meta["hpPalette"] = gfx.nclr(ob[HP_PAL])[:16].tolist()

    # Trainers: Cynthia front (trfgra class 69 -> files 138/139), player backs (trbgra 0 Lucas, 2 Dawn).
    tf, tb = rom.narc("poketool/trgra/trfgra.narc"), rom.narc("poketool/trgra/trbgra.narc")
    for name, arc, i in (("cynthia", tf, 69 * 2), ("lucas_back", tb, 0), ("dawn_back", tb, 2)):
        idx, _, _ = gfx.ncgr(arc[i], decrypt=True)
        gfx.save(gfx.to_rgba(idx, gfx.nclr(arc[i + 1])), g, "trainers", name + ".png")

    # Overworld walking sprites (data/mmodel/mmodel.narc NSBTX): 32x32 frames in numeric order;
    # 1-4 face up, 5-8 down, 9-12 left, 13-16 right (stand, step, stand, step).
    from PIL import Image
    mm = rom.narc_lz("data/mmodel/mmodel.narc")
    for name, i in (("lucas", OW_HERO), ("dawn", OW_HEROINE), ("cynthia", OW_CHAMPION)):
        tex = gfx.tex0(mm[i])
        frames = [tex[n] for n in sorted(tex, key=lambda n: int(n.split(".")[-1]))][:16]
        strip = Image.new("RGBA", (32 * len(frames), 32))
        for k, f in enumerate(frames):
            strip.alpha_composite(f, (32 * k, 0))
        gfx.save(strip, g, "overworld", name + ".png")

    # Sprite placement tables (per species): yOffset = hover altitude (signed), height[4] = ground offsets
    # for (female back, male back, female front, male front).
    yofs = np.frombuffer(rom.narc("poketool/pokegra/poke_yofs.narc")[0], np.int8).tolist()
    heights = [h[0] if len(h) else 0 for h in rom.narc("poketool/pokegra/height.narc")]
    meta["species"] = {sp: {"yOffset": yofs[sp], "height": heights[sp * 4: sp * 4 + 4]} for sp in range(1, 494)}

    # Font: atlas 32 glyphs/row of 16x16; channel-coded so the web can recolor (R=text, G=shadow, B=bg).
    glyphs, widths = gfx.font(rom.narc("graphic/font.narc")[0])
    n = len(glyphs)
    rows = (n + 31) // 32
    atlas = np.zeros((rows * 16, 32 * 16, 4), np.uint8)
    lut = np.array([[0, 0, 0, 0], [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]], np.uint8)
    for i, gl in enumerate(glyphs):
        y, x = divmod(i, 32)
        atlas[y * 16:(y + 1) * 16, x * 16:(x + 1) * 16] = lut[gl]
    gfx.save(Image.fromarray(atlas, "RGBA"), g, "font.png")
    from .text import _ENCODE
    meta["font"] = {"glyphW": 16, "glyphH": 16, "perRow": 32, "firstChar": 1, "widths": widths,
                    "chars": {c: k for c, k in _ENCODE.items() if k < 0xE000}}

    with open(os.path.join(g, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
