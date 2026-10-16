"""NDS 2D graphics decoders (NCLR/NCGR/NCER/NSCR) + Diamond asset export. See .claude/skills/nds-graphics-formats."""
import json
import os
import struct

import numpy as np
from PIL import Image


def _blocks(b):
    """Nitro file -> {magic: block_bytes_without_8_byte_header}. Magic as stored (reversed, e.g. 'TTLP')."""
    hdr_size, n = struct.unpack_from("<HH", b, 12)
    out, off = {}, hdr_size
    for _ in range(n):
        magic = bytes(b[off:off + 4]).decode("ascii")
        size = struct.unpack_from("<I", b, off + 4)[0]
        out[magic] = bytes(b[off + 8: off + size])
        off += size
    return out


def bgr555(words):
    w = np.asarray(words, dtype=np.uint16)
    r, g, b = w & 31, (w >> 5) & 31, (w >> 10) & 31
    return (np.stack([r, g, b], -1).astype(np.uint16) * 255 // 31).astype(np.uint8)


def nclr(b):
    """-> (N,3) uint8 RGB palette (all colors, 16- or 256-color banks concatenated)."""
    p = _blocks(b)["TTLP"]
    depth, _, size, off = struct.unpack_from("<IIII", p, 0)
    n = size // 2 if size and 8 + off + size <= len(p) + 8 else (len(p) - 16) // 2
    return bgr555(struct.unpack_from("<%dH" % n, p, off - 8 + 8))


def dp_decrypt(data):
    """DP Pokémon sprite NCGR scramble: XOR u16 words back-to-front with the Gen 4 LCRNG,
    seeded by the (encrypted) last word."""
    w = np.frombuffer(data, dtype="<u2").copy()
    seed = int(w[-1])
    for i in range(len(w) - 1, -1, -1):
        w[i] ^= seed & 0xFFFF
        seed = (seed * 0x41C64E6D + 0x6073) & 0xFFFFFFFF
    return w.tobytes()


def ncgr(b, decrypt=False):
    """-> (pixels uint8 index array HxW, bpp, tiled). Tiled data is returned as a linear tile strip
    (rows of 8x8 tiles, width_tiles wide) so callers can index tiles by number."""
    c = _blocks(b)["RAHC"]
    h_t, w_t, depth, _, scanned, size, off = struct.unpack_from("<HHIIIII", c, 0)
    data = c[off - 8 + 8: off + size] if off else c[0x18:]
    data = c[0x18: 0x18 + size]
    if decrypt:
        data = dp_decrypt(data)
    bpp = 4 if depth == 3 else 8
    raw = np.frombuffer(data, dtype=np.uint8)
    px = np.stack([raw & 15, raw >> 4], -1).reshape(-1) if bpp == 4 else raw
    if h_t == 0xFFFF or w_t == 0xFFFF:  # size unspecified: treat as a strip of tiles 32 wide
        n_tiles = len(px) // 64
        w_t, h_t = min(32, n_tiles), (n_tiles + 31) // 32
        px = np.pad(px, (0, w_t * h_t * 64 - len(px)))
    if scanned & 1:
        return px.reshape(h_t * 8, w_t * 8), bpp, False
    tiles = px[: h_t * w_t * 64].reshape(h_t, w_t, 8, 8)
    return tiles.transpose(0, 2, 1, 3).reshape(h_t * 8, w_t * 8), bpp, True


def tile(px, n, w_t):
    """8x8 tile n from a tiled pixel sheet w_t tiles wide."""
    y, x = divmod(n, w_t)
    return px[y * 8:(y + 1) * 8, x * 8:(x + 1) * 8]


def to_rgba(idx, pal, transparent0=True):
    pal = np.asarray(pal)
    rgb = pal[np.minimum(idx, len(pal) - 1)]
    a = np.where((idx % 16 == 0) if transparent0 else np.zeros_like(idx, bool), 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, a]), "RGBA")


def nscr(b):
    """-> (H_tiles, W_tiles) array of u16 screen entries (tile | hflip<<10 | vflip<<11 | pal<<12)."""
    s = _blocks(b)["NRCS"]
    w, h, _, size = struct.unpack_from("<HHII", s, 0)
    ent = np.frombuffer(s[12:12 + size], dtype="<u2")
    # Text BG screens are stored as 32x32-tile blocks (left->right, top->bottom).
    bh, bw = max(h // 256, 1), max(w // 256, 1)
    th, tw = min(h // 8, 32), min(w // 8, 32)
    return ent.reshape(bh, bw, th, tw).transpose(0, 2, 1, 3).reshape(bh * th, bw * tw)


def render_screen(scr, px, w_t, pal, bpp=4, transparent0=False):
    """Compose an NSCR tilemap with a tiled NCGR sheet and palette (16-color banks for 4bpp)."""
    return to_rgba(screen_indices(scr, px, w_t, bpp), pal, transparent0)


def screen_indices(scr, px, w_t, bpp=4):
    H, W = scr.shape
    idx = np.zeros((H * 8, W * 8), np.uint16)
    n_tiles = (px.shape[0] // 8) * w_t
    for y in range(H):
        for x in range(W):
            e = int(scr[y, x])
            t = tile(px, (e & 0x3FF) % max(n_tiles, 1), w_t).astype(np.uint16)
            if e & 0x400:
                t = t[:, ::-1]
            if e & 0x800:
                t = t[::-1, :]
            idx[y * 8:(y + 1) * 8, x * 8:(x + 1) * 8] = t + ((e >> 12) * 16 if bpp == 4 else 0)
    return idx


def ncer(b):
    """-> list of cells; each cell = list of OAM dicts {x,y,w,h,tile,pal,hflip,vflip}."""
    c = _blocks(b)["KBEC"]
    n_cells, ext, off = struct.unpack_from("<HHI", c, 0)
    mapping = struct.unpack_from("<I", c, 8)[0]
    cell_size = 16 if ext == 1 else 8
    base = off - 8 + 8  # cell table start inside block
    oam_base = base + n_cells * cell_size
    shift = mapping & 0xF
    sizes = {(0, 0): (8, 8), (0, 1): (16, 16), (0, 2): (32, 32), (0, 3): (64, 64),
             (1, 0): (16, 8), (1, 1): (32, 8), (1, 2): (32, 16), (1, 3): (64, 32),
             (2, 0): (8, 16), (2, 1): (8, 32), (2, 2): (16, 32), (2, 3): (32, 64)}
    cells = []
    for i in range(n_cells):
        n_oam, _, oam_off = struct.unpack_from("<HHI", c, base + i * cell_size)
        oams = []
        for k in range(n_oam):
            a0, a1, a2 = struct.unpack_from("<HHH", c, oam_base + oam_off + 6 * k)
            y = a0 & 0xFF
            y = y - 256 if y >= 128 else y
            x = a1 & 0x1FF
            x = x - 512 if x >= 256 else x
            w, h = sizes[(a0 >> 14, a1 >> 14)]
            oams.append({"x": x, "y": y, "w": w, "h": h, "tile": (a2 & 0x3FF) << shift,
                         "pal": a2 >> 12, "hflip": bool(a1 & 0x1000), "vflip": bool(a1 & 0x2000),
                         "bpp8": bool(a0 & 0x2000)})
        cells.append(oams)
    return cells


def render_cell(oams, px_linear, pal, bpp=4):
    """Render one NCER cell using 1D-mapped tiles (px_linear = flat tile strip from ncgr_linear)."""
    if not oams:
        return None
    x0 = min(o["x"] for o in oams); y0 = min(o["y"] for o in oams)
    x1 = max(o["x"] + o["w"] for o in oams); y1 = max(o["y"] + o["h"] for o in oams)
    idx = np.zeros((y1 - y0, x1 - x0), np.uint16)
    mask = np.zeros_like(idx, bool)
    tiles = px_linear  # (n_tiles, 8, 8)
    for o in reversed(oams):  # first OAM drawn on top
        tw, th = o["w"] // 8, o["h"] // 8
        step = 2 if o["bpp8"] and bpp == 4 else 1
        for ty in range(th):
            for tx in range(tw):
                n = o["tile"] + (ty * tw + tx) * step
                if n >= len(tiles):
                    continue
                t = tiles[n].astype(np.uint16)
                yy, xx = ty, tx
                if o["hflip"]:
                    t = t[:, ::-1]; xx = tw - 1 - tx
                if o["vflip"]:
                    t = t[::-1, :]; yy = th - 1 - ty
                sy, sx = o["y"] - y0 + yy * 8, o["x"] - x0 + xx * 8
                m = t != 0
                region = idx[sy:sy + 8, sx:sx + 8]
                region[m] = t[m] + o["pal"] * 16
                mask[sy:sy + 8, sx:sx + 8] |= m
    img = to_rgba(idx, pal)
    return img, (x0, y0)


def ncgr_tiles(b, decrypt=False):
    """NCGR as a flat (n_tiles, 8, 8) array in storage order (for 1D OBJ mapping)."""
    c = _blocks(b)["RAHC"]
    depth, size = struct.unpack_from("<I", c, 4)[0], struct.unpack_from("<I", c, 0x10)[0]
    data = c[0x18:0x18 + size]
    raw = np.frombuffer(data, dtype=np.uint8)
    px = np.stack([raw & 15, raw >> 4], -1).reshape(-1) if depth == 3 else raw
    return px[: len(px) // 64 * 64].reshape(-1, 8, 8)


# ---------------------------------------------------------------- Diamond asset export

def pokemon_sprite(rom, species, which="front", shiny=False, female=False):
    """pokegra.narc: 6 files/species: 0 F-back, 1 M-back, 2 F-front, 3 M-front, 4 normal pal, 5 shiny pal.
    Returns RGBA 160x80 (two 80x80 frames side by side) or None if that sprite is empty."""
    p = rom.narc("poketool/pokegra/pokegra.narc")
    base = species * 6
    k = {"back": 0, "front": 2}[which] + (0 if female else 1)
    data = p[base + k]
    if not data:
        return None
    idx, _, _ = ncgr(data, decrypt=True)
    pal = nclr(p[base + (5 if shiny else 4)])
    return to_rgba(idx, pal)


def save(img, *path):
    os.makedirs(os.path.dirname(os.path.join(*path)), exist_ok=True)
    img.save(os.path.join(*path))


def extract(rom, out):
    g = os.path.join(out, "gfx")
    for sp in range(1, 494):
        for which in ("front", "back"):
            for shiny in (False, True):
                img = pokemon_sprite(rom, sp, which, shiny)
                fem = pokemon_sprite(rom, sp, which, shiny, female=True)
                if img is None:  # female-only species store their sprite only in the female slot
                    img, fem = fem, None
                if img:
                    save(img, g, "pokemon", which + ("-shiny" if shiny else ""), "%03d.png" % sp)
                if fem and img and fem.tobytes() != img.tobytes():
                    save(fem, g, "pokemon", which + ("-shiny" if shiny else "") + "-female", "%03d.png" % sp)
    from . import gfx_dp
    gfx_dp.extract(rom, g)
    contact_sheets(out)


def contact_sheets(out):
    g = os.path.join(out, "gfx", "pokemon")
    sheet = Image.new("RGBA", (24 * 80, 21 * 80), (248, 248, 248, 255))
    for sp in range(1, 494):
        f = os.path.join(g, "front", "%03d.png" % sp)
        if os.path.exists(f):
            im = Image.open(f).crop((0, 0, 80, 80))
            sheet.alpha_composite(im, (((sp - 1) % 24) * 80, ((sp - 1) // 24) * 80))
    save(sheet, out, "contact-sheets", "pokemon-front.png")


def font(b):
    """graphic/font.narc member: u32 hdr(0x10), u32 widths_off, u32 count, u8 maxW, u8 h, u8 tilesW, u8 tilesH;
    glyphs = count x (tilesW*tilesH) 2bpp 8x8 tiles; each row is a big-endian u16, pixel 0 in the top bits.
    Values: 1 text, 2 shadow, 3 glyph background, 0 empty; widths = u8[count].
    Glyph i draws char code i+1. Returns (glyphs uint8 [count,16,16] values 0..3, widths list)."""
    hdr, woff, count, maxw, h, tw, th = struct.unpack_from("<IIIBBBB", b, 0)
    raw = np.frombuffer(b[hdr:hdr + count * tw * th * 16], np.uint8).reshape(-1, 2)[:, ::-1].ravel()
    px = np.stack([(raw >> s) & 3 for s in (6, 4, 2, 0)], -1).reshape(count, th, tw, 8, 8)
    glyphs = px.transpose(0, 1, 3, 2, 4).reshape(count, th * 8, tw * 8)
    return glyphs, list(b[woff:woff + count])
