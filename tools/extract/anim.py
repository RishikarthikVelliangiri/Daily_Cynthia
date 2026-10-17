"""Move animations: battle animation scripts (wazaeffect/we.arc), SPL particle resources
(wazaeffect/effectdata/waza_particle.narc), the particle world positions table (overlay 8) and the sound
effects the scripts play. Formats: .claude/skills/nds-graphics-formats (SPL section) and pret's lib/spl."""
import json
import os
import struct

import numpy as np
from PIL import Image

from .gfx import bgr555

# --- animation scripts -----------------------------------------------------------------------
# Words after the opcode; 45 CallFunc, 55 SetExtraParams and 78 AddSpriteWithFunc carry a count.
ARGC = {0: 1, 1: 0, 2: 1, 3: 0, 4: 0, 5: 1, 8: 2, 9: 0, 10: 1, 11: 0, 12: 2, 13: 2, 14: 2, 15: 1, 16: 2, 17: 2,
        18: 2, 19: 0, 20: 0, 21: 1, 22: 2, 23: 1, 24: 5, 25: 4, 26: 3, 29: 0, 30: 3, 31: 2, 32: 1, 33: 1, 34: 3,
        35: 5, 36: 5, 44: 1, 46: 3, 47: 4, 48: 8, 49: 6, 50: 0, 51: 2, 52: 3, 53: 1, 56: 0, 57: 1, 58: 4, 59: 0,
        60: 1, 61: 1, 62: 2, 63: 2, 64: 3, 65: 3, 66: 1, 67: 0, 68: 1, 69: 1, 70: 5, 71: 1, 72: 1, 73: 8, 74: 2,
        75: 3, 76: 2, 77: 2, 79: 8, 80: 1, 81: 2, 82: 3, 83: 1, 84: 0}
SOUND_OPS = {5, 22, 24, 25, 26, 35, 36}  # first argument is a sequence id


def script_words(b):
    return list(struct.unpack("<%di" % (len(b) // 4), bytes(b[:len(b) // 4 * 4])))


def disassemble(w):
    """-> [(word_index, opcode, args)]; raises on an unknown opcode."""
    out, i = [], 0
    while i < len(w):
        op = w[i]
        if op == 45:
            n = 2 + w[i + 2]
        elif op == 55:
            n = 1 + w[i + 1]
        elif op == 78:
            n = 9 + w[i + 9]
        elif op in ARGC:
            n = ARGC[op]
        else:
            raise ValueError(f"opcode {op} at {i}")
        out.append((i, op, w[i + 1:i + 1 + n]))
        i += 1 + n
    return out


# --- SPL particle resources (SPA "12_1") ------------------------------------------------------
FX = 4096.0
_TEX_BPP = {1: 8, 2: 2, 3: 4, 4: 8, 6: 8, 7: 16}


def _rgb(c):
    return [c & 31, (c >> 5) & 31, (c >> 10) & 31]


def decode_texture(fmt, w, h, data, pal, color0_transparent):
    """Nitro 3D texture -> RGBA uint8 (h, w, 4). Formats: 1 A3I5, 2 4-color, 3 16-color, 4 256-color,
    6 A5I3, 7 direct. (4x4-compressed textures are not used by the battle particles.)"""
    pal = bgr555(pal) if len(pal) else np.zeros((1, 3), np.uint8)
    raw = np.frombuffer(data, np.uint8)
    if fmt in (2, 3, 4):
        bpp = {2: 2, 3: 4, 4: 8}[fmt]
        idx = np.stack([(raw >> s) & ((1 << bpp) - 1) for s in range(0, 8, bpp)], -1).reshape(-1)[:w * h]
        rgb = pal[np.minimum(idx, len(pal) - 1)]
        a = np.where((idx == 0) & bool(color0_transparent), 0, 255).astype(np.uint8)
    elif fmt in (1, 6):
        ib = 5 if fmt == 1 else 3
        v = raw[:w * h]
        idx, alpha = v & ((1 << ib) - 1), v >> ib
        rgb = pal[np.minimum(idx, len(pal) - 1)]
        a = (alpha.astype(np.uint16) * 255 // ((1 << (8 - ib)) - 1)).astype(np.uint8)
    elif fmt == 7:
        c = np.frombuffer(data, "<u2")[:w * h]
        rgb = bgr555(c)
        a = np.where(c & 0x8000, 255, 0).astype(np.uint8)
    else:
        raise ValueError(f"texture format {fmt}")
    return np.concatenate([rgb.reshape(h, w, 3), a.reshape(h, w, 1)], -1)


def parse_spa(b):
    """SPA file -> (resources: list of dicts, textures: list of RGBA arrays + params)."""
    b = bytes(b)
    magic, version, res_count, tex_count = b[:4], b[4:8], *struct.unpack_from("<HH", b, 8)
    assert magic == b" APS" and version == b"12_1", (magic, version)
    off = 0x20
    resources = []
    for _ in range(res_count):
        h = struct.unpack_from("<I3i3i3hH3ihH2hHHHH", b, off)
        flags = h[0]
        f = lambda bit, n=1: (flags >> bit) & ((1 << n) - 1)
        rnd, m0, m1, m2 = struct.unpack_from("<4I", b, off + 0x40)
        poly_x, poly_y, user = struct.unpack_from("<hhI", b, off + 0x50)
        r = {
            "emissionType": f(0, 4), "drawType": f(4, 2), "circleAxis": f(6, 2),
            "hasRotation": f(12), "randomInitAngle": f(13), "selfMaintaining": f(14), "followEmitter": f(15),
            "polygonRotAxis": f(17, 2), "polygonReferencePlane": f(19), "randomizeLoopedAnim": f(20),
            "drawChildrenFirst": f(21), "hideParent": f(22), "useViewSpace": f(23),
            "basePos": [h[1] / FX, h[2] / FX, h[3] / FX], "emissionCount": h[4] / FX, "radius": h[5] / FX,
            "length": h[6] / FX, "axis": [h[7] / FX, h[8] / FX, h[9] / FX], "color": _rgb(h[10]),
            "initVelPos": h[11] / FX, "initVelAxis": h[12] / FX, "baseScale": h[13] / FX, "aspect": h[14] / FX,
            "startDelay": h[15], "minRotation": h[16], "maxRotation": h[17], "initAngle": h[18],
            "emitterLifeTime": h[20], "particleLifeTime": h[21],
            "attenScale": rnd & 0xFF, "attenLife": (rnd >> 8) & 0xFF, "attenVel": (rnd >> 16) & 0xFF,
            "emissionInterval": m0 & 0xFF, "baseAlpha": (m0 >> 8) & 0xFF, "airResistance": (m0 >> 16) & 0xFF,
            "texture": m0 >> 24, "loopFrames": m1 & 0xFF, "dbbScale": (m1 >> 8) & 0xFFFF,
            "tileS": (m1 >> 24) & 3, "tileT": (m1 >> 26) & 3, "scaleAnimDir": (m1 >> 28) & 7,
            "dpolFaceEmitter": m1 >> 31, "flipS": m2 & 1, "flipT": (m2 >> 1) & 1,
            "polygonX": poly_x / FX, "polygonY": poly_y / FX,
            "fixedPolygonID": f(30), "behaviors": [],
        }
        off += 0x58
        if f(8):  # scale anim
            s, mid, e, cin, cout, loop = struct.unpack_from("<3h2BH", b, off)
            r["scaleAnim"] = {"start": s / FX, "mid": mid / FX, "end": e / FX, "in": cin, "out": cout, "loop": loop & 1}
            off += 12
        if f(9):  # color anim
            s, e, curve, fl = struct.unpack_from("<HHIH", b, off)
            r["colorAnim"] = {"start": _rgb(s), "end": _rgb(e), "in": curve & 0xFF, "peak": (curve >> 8) & 0xFF,
                              "out": (curve >> 16) & 0xFF, "randomStart": fl & 1, "loop": (fl >> 1) & 1,
                              "interpolate": (fl >> 2) & 1}
            off += 12
        if f(10):  # alpha anim
            a, fl, cin, cout = struct.unpack_from("<HHBB", b, off)
            r["alphaAnim"] = {"start": a & 31, "mid": (a >> 5) & 31, "end": (a >> 10) & 31,
                              "randomRange": fl & 0xFF, "loop": (fl >> 8) & 1, "in": cin, "out": cout}
            off += 8
        if f(11):  # texture anim
            frames = list(b[off:off + 8])
            p = struct.unpack_from("<I", b, off + 8)[0]
            r["texAnim"] = {"textures": frames, "frameCount": p & 0xFF, "step": (p >> 8) & 0xFF,
                            "randomizeInit": (p >> 16) & 1, "loop": (p >> 17) & 1}
            off += 12
        if f(16):  # child resource
            cf, vel, end_scale, life, vr, sr, col, m0c, m1c = struct.unpack_from("<HhhHBBHII", b, off)
            r["child"] = {
                "usesBehaviors": cf & 1, "hasScaleAnim": (cf >> 1) & 1, "hasAlphaAnim": (cf >> 2) & 1,
                "rotationType": (cf >> 3) & 3, "followEmitter": (cf >> 5) & 1, "useChildColor": (cf >> 6) & 1,
                "drawType": (cf >> 7) & 3, "polygonRotAxis": (cf >> 9) & 3, "polygonReferencePlane": (cf >> 11) & 1,
                "randomInitVelMag": vel / FX, "endScale": end_scale / FX, "lifeTime": life,
                "velocityRatio": vr, "scaleRatio": sr, "color": _rgb(col),
                "emissionCount": m0c & 0xFF, "emissionDelay": (m0c >> 8) & 0xFF,
                "emissionInterval": (m0c >> 16) & 0xFF, "texture": m0c >> 24,
                "tileS": m1c & 3, "tileT": (m1c >> 2) & 3, "flipS": (m1c >> 4) & 1, "flipT": (m1c >> 5) & 1,
                "dpolFaceEmitter": (m1c >> 6) & 1,
            }
            off += 20
        if f(24):  # gravity
            x, y, z = struct.unpack_from("<3h", b, off)
            r["behaviors"].append({"type": "gravity", "mag": [x / FX, y / FX, z / FX]})
            off += 8
        if f(25):  # random
            x, y, z, interval = struct.unpack_from("<3hH", b, off)
            r["behaviors"].append({"type": "random", "mag": [x / FX, y / FX, z / FX], "interval": interval})
            off += 8
        if f(26):  # magnet
            x, y, z, force = struct.unpack_from("<3ih", b, off)
            r["behaviors"].append({"type": "magnet", "target": [x / FX, y / FX, z / FX], "force": force / FX})
            off += 16
        if f(27):  # spin
            angle, axis = struct.unpack_from("<HH", b, off)
            r["behaviors"].append({"type": "spin", "angle": angle, "axis": axis})
            off += 4
        if f(28):  # collision plane
            y, el, t = struct.unpack_from("<ihH", b, off)
            r["behaviors"].append({"type": "collision", "y": y / FX, "elasticity": el / FX, "kind": t & 3})
            off += 8
        if f(29):  # convergence
            x, y, z, force = struct.unpack_from("<3ih", b, off)
            r["behaviors"].append({"type": "convergence", "target": [x / FX, y / FX, z / FX], "force": force / FX})
            off += 16
        resources.append(r)
    textures = []
    for _ in range(tex_count):
        magic_id, param, tex_size, pal_off, pal_size, _, _, res_size = struct.unpack_from("<8I", b, off)
        fmt, s, t = param & 15, (param >> 4) & 15, (param >> 8) & 15
        w, h = 8 << s, 8 << t
        shared, shared_id = (param >> 17) & 1, (param >> 18) & 0xFF
        data = b[off + 32: off + 32 + tex_size]
        pal = struct.unpack_from("<%dH" % (pal_size // 2), b, off + pal_off) if pal_size else ()
        textures.append({"fmt": fmt, "w": w, "h": h, "repeat": (param >> 12) & 3, "flip": (param >> 14) & 3,
                         "color0": (param >> 16) & 1, "shared": shared, "sharedId": shared_id,
                         "data": data, "pal": pal})
        off += res_size
    for tx in textures:  # shared textures reuse another texture's pixels with their own palette
        src = textures[tx["sharedId"]] if tx["shared"] else tx
        tx["rgba"] = decode_texture(src["fmt"], src["w"], src["h"], src["data"], tx["pal"] or src["pal"], tx["color0"])
    return resources, textures


def world_positions(rom):
    """Particle world positions per battler type (overlay 8): 8 types x 12 kinds x (perspective, ortho)."""
    ov = bytes(rom.nds.loadArm9Overlays([8])[8].data)
    eye = struct.pack("<3i", 5888, 19712, -4096)  # sParticleCameraEye (1.4375, 4.8125, -1.0) precedes the table
    base = ov.index(eye) + 0x48
    vals = struct.unpack_from("<%di" % (8 * 24 * 3), ov, base)
    assert vals[:3] == (-9616, -5464, 64), vals[:3]  # solo player, normal, perspective
    return [[[round(v / FX, 4) for v in vals[(t * 24 + k) * 3:(t * 24 + k) * 3 + 3]] for k in range(24)] for t in range(8)]


# EmitterAxisConfigs1..8 (overlay 8): 6x6 battler-type tables of VecFx32. Located by their solo player->enemy entry;
# only the two single-battle entries are kept.
_AXIS_KEYS = [(3776, 2112, 3064), (2408, 1248, 0), (1408, 736, 0), (2528, 1588, 0),
              (1952, 1096, 0), (3200, 1720, 0), (1600, -64, 0), (3584, 2048, 0)]


def axis_tables(rom):
    ov = bytes(rom.nds.loadArm9Overlays([8])[8].data)
    out = []
    for key in _AXIS_KEYS:
        hits = [o for o in range(0, len(ov) - 12, 4)
                if all(abs(a - b) <= 2 for a, b in zip(struct.unpack_from("<3i", ov, o), key))]
        assert len(hits) == 1, (key, hits)
        base = hits[0] - 12  # [player][player] precedes [player][enemy]
        pe = struct.unpack_from("<3i", ov, base + 12)
        ep = struct.unpack_from("<3i", ov, base + 6 * 12)
        out.append({"playerToEnemy": [v / FX for v in pe], "enemyToPlayer": [v / FX for v in ep]})
    return out


def effect_bgs(rom, out_dir):
    """Move-animation backgrounds (SwitchBg): overlay 8 holds a 58-row table of batt_bg.narc members
    (NCGR, NCLR, NSCR normal, NSCR reversed, NSCR contest). Rendered as 16-color text BGs using the first
    palette of the NCLR (the game copies 32 bytes into the effect palette slot); color 0 is transparent."""
    from .gfx import ncgr, nscr, screen_indices, bgr555 as pal555
    ov = bytes(rom.nds.loadArm9Overlays([8])[8].data)
    key = struct.pack("<5i", 53, 208, 50, 51, 52) * 5
    base = ov.index(key)
    table = [struct.unpack_from("<5i", ov, base + 20 * i) for i in range(58)]
    narc = rom.narc_lz("battle/graphic/batt_bg.narc")
    os.makedirs(os.path.join(out_dir, "bg"), exist_ok=True)
    meta = []
    for bg_id, (cg, cl, s1, s2, _s3) in enumerate(table):
        px, bpp, _ = ncgr(narc[cg])
        w_t = px.shape[1] // 8
        pal = pal555(struct.unpack_from("<16H", _nclr_data(narc[cl]), 0))
        entry = {}
        for tag, scr_i in (("n", s1), ("r", s2)):
            if tag == "r" and s2 == s1:
                continue
            scr = nscr(narc[scr_i])
            idx = screen_indices(scr, px, w_t, bpp) & 15
            rgb = pal[idx]
            a = np.where(idx == 0, 0, 255).astype(np.uint8)
            Image.fromarray(np.dstack([rgb, a]), "RGBA").save(os.path.join(out_dir, "bg", f"{bg_id:02d}{tag}.png"))
            entry[tag] = f"{bg_id:02d}{tag}.png"
        meta.append(entry)
    # Stat-change overlays (StatChangeUp/Down/Heal/Metal): 4 rows of (NCGR, NCLR, NSCR, NSCR) after the stat-change
    # task code in overlay 8 -> bg/stat{0..3}.png, scrolled over the battler's silhouette.
    sbase = ov.index(struct.pack("<4i", 48, 207, 49, 49))
    for i in range(4):
        cg, cl, sc, _ = struct.unpack_from("<4i", ov, sbase + 16 * i)
        px, bpp, _ = ncgr(narc[cg])
        pal = pal555(struct.unpack_from("<16H", _nclr_data(narc[cl]), 0))
        idx = screen_indices(nscr(narc[sc]), px, px.shape[1] // 8, bpp) & 15
        Image.fromarray(np.dstack([pal[idx], np.where(idx == 0, 0, 255).astype(np.uint8)]), "RGBA").save(
            os.path.join(out_dir, "bg", f"stat{i}.png"))
    return meta


def nanr(b):
    """NANR -> list of sequences, each a list of (cell index, duration in frames)."""
    from .gfx import _blocks
    k = _blocks(bytes(b))["KNBA"]
    n_seq, _n_frames, seq_off, frame_off, data_off = struct.unpack_from("<HHIII", k, 0)
    out = []
    for i in range(n_seq):
        nf, _start, _elem, _type, _mode, foff = struct.unpack_from("<HHHHII", k, seq_off + i * 16)
        seq = []
        for f in range(nf):
            doff, dur = struct.unpack_from("<IH", k, frame_off + foff + f * 8)
            cell = struct.unpack_from("<H", k, data_off + doff)[0]
            seq.append((cell, dur))
        out.append(seq)
    return out


def effect_sprites(rom, out_dir, scripts):
    """OAM effect graphics (wazaeffect/effectclact): for every (char, palette, cell, anim) set a move script loads,
    render all cells to a sheet with their origins, plus the animation sequences."""
    from .gfx import ncer, ncgr_tiles, nclr, render_cell
    sets = set()
    for w in scripts:
        for _, op, a in disassemble(w):
            if op in (78, 79):  # sprite template: manager, spriteID/funcID, char, pltt, cell, anim (wechar.. members)
                sets.add(tuple(a[2:6]))
    chars = rom.narc_lz("wazaeffect/effectclact/wechar.narc")
    pals = rom.narc_lz("wazaeffect/effectclact/wepltt.narc")
    cellb = rom.narc_lz("wazaeffect/effectclact/wecell.narc")
    anims = rom.narc_lz("wazaeffect/effectclact/wecellanm.narc")
    os.makedirs(os.path.join(out_dir, "oam"), exist_ok=True)
    meta = {}
    for c, p, cl, an in sorted(sets):
        tiles = ncgr_tiles(chars[c])
        pal = nclr(pals[p])
        if len(pal) < 256:
            pal = np.concatenate([pal] * (256 // len(pal) + 1))[:256]
        cells, frames, x = ncer(cellb[cl]), [], 0
        imgs = []
        for oams in cells:
            r = render_cell([dict(o, pal=o["pal"] % (len(pal) // 16)) for o in oams], tiles, pal)
            imgs.append(r)
        h = max((r[0].height for r in imgs if r), default=1)
        sheet = Image.new("RGBA", (max(1, sum(r[0].width for r in imgs if r)), h))
        for r in imgs:
            if not r:
                frames.append(None)
                continue
            img, (ox, oy) = r
            sheet.paste(img, (x, 0))
            frames.append({"x": x, "w": img.width, "h": img.height, "ox": ox, "oy": oy})
            x += img.width
        key = f"{c}_{p}_{cl}"
        sheet.save(os.path.join(out_dir, "oam", key + ".png"))
        meta[f"{c}_{p}_{cl}_{an}"] = {"sheet": key + ".png", "cells": frames, "anims": nanr(anims[an])}
    return meta


def _nclr_data(b):
    """NCLR color data (TTLP block body after its 16-byte header)."""
    from .gfx import _blocks
    return _blocks(bytes(b))["TTLP"][16:]


def extract(rom, out_dir):
    base = os.path.join(out_dir, "anim")
    os.makedirs(os.path.join(base, "particles"), exist_ok=True)
    scripts = [script_words(b) for b in rom.narc("wazaeffect/we.arc")]
    # Common animations (status, stat change, weather, ...), same bytecode; member order = pret anim_subscripts.order.
    subs = [script_words(b) for b in rom.narc("wazaeffect/we_sub.narc")]
    used_particles, used_seqs = set(), set()
    for w in scripts + subs:
        for _, op, a in disassemble(w):
            if op == 51:
                used_particles.add(a[1])
            if op in SOUND_OPS:
                used_seqs.add(a[0])
    with open(os.path.join(base, "scripts.json"), "w") as fh:
        json.dump(scripts, fh, separators=(",", ":"))
    with open(os.path.join(base, "sub.json"), "w") as fh:
        json.dump(subs, fh, separators=(",", ":"))
    narc = rom.narc("wazaeffect/effectdata/waza_particle.narc")
    for i in sorted(used_particles):
        resources, textures = parse_spa(narc[i])
        sheet_w = sum(t["w"] for t in textures) or 1
        sheet_h = max((t["h"] for t in textures), default=1)
        sheet = np.zeros((sheet_h, sheet_w, 4), np.uint8)
        tex_meta, x = [], 0
        for t in textures:
            sheet[:t["h"], x:x + t["w"]] = t["rgba"]
            tex_meta.append({"x": x, "w": t["w"], "h": t["h"], "repeat": t["repeat"], "flip": t["flip"]})
            x += t["w"]
        Image.fromarray(sheet, "RGBA").save(os.path.join(base, "particles", f"{i:03d}.png"))
        with open(os.path.join(base, "particles", f"{i:03d}.json"), "w") as fh:
            json.dump({"resources": resources, "textures": tex_meta}, fh, separators=(",", ":"))
    with open(os.path.join(base, "oam.json"), "w") as fh:
        json.dump(effect_sprites(rom, base, scripts + subs), fh, separators=(",", ":"))
    bgs = effect_bgs(rom, base)
    with open(os.path.join(base, "bgs.json"), "w") as fh:
        json.dump(bgs, fh)
    with open(os.path.join(base, "positions.json"), "w") as fh:
        json.dump({"world": world_positions(rom), "axis": axis_tables(rom)}, fh, separators=(",", ":"))
    from . import audio
    sd = audio.Sdat(rom.file("data/sound/sound_data.sdat"))
    names = [n for n, _ in sd.a.sequences]
    os.makedirs(os.path.join(base, "se"), exist_ok=True)
    se = {}
    for sid in sorted(used_seqs):
        if 0 <= sid < len(names) and names[sid]:
            out, _, _ = audio.render(sd, names[sid])
            se[sid] = audio.write_ogg(os.path.join(base, "se", f"{sid:04d}"), out)
    with open(os.path.join(base, "se.json"), "w") as fh:
        json.dump(se, fh)
    return len(scripts), len(used_particles), len(se)
