"""Decoders for Diamond (ADAE rev 5) game data. Layouts documented in docs/rom-map.md."""
import struct

from .text import Messages

N_SPECIES = 493
TYPES = ["Normal", "Fighting", "Flying", "Poison", "Ground", "Rock", "Bug", "Ghost", "Steel", "???",
         "Fire", "Water", "Grass", "Electric", "Psychic", "Ice", "Dragon", "Dark"]
CATEGORIES = ["Physical", "Special", "Status"]
GROWTH = ["Medium Fast", "Erratic", "Fluctuating", "Medium Slow", "Fast", "Slow"]

# Fixed offsets for ADAE rev 5 (found by signature search, see docs/rom-map.md).
ARM9_TM_TABLE = 0xF84EC        # u16[100]: TM01..TM92, HM01..HM08 -> move id
ARM9_ITEM_TABLE = 0xF85B4      # 8-byte entries per item id: u16 data_idx, icon, palette, gen
OV5_EGG_MOVES = 0x20668        # u16 stream: 20000+species, moves..., 0xFFFF end
OV11_TYPE_CHART = 0x30DB8      # u8 triplets (atk, def, x10 mult); FE FE 00 = foresight split; FF end


def _u16s(b, off, n):
    return list(struct.unpack_from("<%dH" % n, b, off))


def species(rom, msgs):
    names = msgs.archive(Messages.SPECIES)
    abil_names = msgs.archive(Messages.ABILITIES)
    out = []
    for i, b in enumerate(rom.narc("poketool/personal/personal.narc")[: N_SPECIES + 1]):
        tm_bits = int.from_bytes(b[28:44], "little")
        out.append({
            "id": i,
            "name": names[i].title().replace("’D", "'d") if i else "-",
            "baseStats": dict(zip(["hp", "atk", "def", "spe", "spa", "spd"], b[0:6])),
            "types": sorted({TYPES[b[6]], TYPES[b[7]]}, key=[TYPES[b[6]], TYPES[b[7]]].index),
            "catchRate": b[8],
            "genderRatio": b[16],
            "growth": GROWTH[b[19]],
            "eggGroups": [b[20], b[21]],
            "abilities": [abil_names[a] for a in dict.fromkeys(b[22:24]) if a],
            "tmBits": tm_bits,
        })
    return out


def moves(rom, msgs):
    names = msgs.archive(Messages.MOVES)
    out = []
    for i, b in enumerate(rom.narc("poketool/waza/waza_tbl.narc")[: len(names)]):
        effect, cat, power, typ, acc, pp, chance, target, prio, flags = struct.unpack_from("<HBBBBBBHbB", b, 0)
        out.append({
            "id": i, "name": names[i], "effect": effect, "category": CATEGORIES[cat], "power": power,
            "type": TYPES[typ], "accuracy": acc, "pp": pp, "effectChance": chance,
            "target": target, "priority": prio, "flags": flags,
        })
    return out


def tm_moves(rom):
    return _u16s(bytes(rom.nds.arm9), ARM9_TM_TABLE, 100)


def level_up(rom):
    out = []
    for b in rom.narc("poketool/personal/wotbl.narc")[: N_SPECIES + 1]:
        ls = []
        for (v,) in struct.iter_unpack("<H", b[: len(b) // 2 * 2]):
            if v == 0xFFFF:
                break
            ls.append([v >> 9, v & 0x1FF])  # [level, move]
        out.append(ls)
    return out


def egg_moves(rom):
    b = bytes(rom.overlay(5))
    out, cur, off = {}, None, OV5_EGG_MOVES
    while True:
        (v,) = struct.unpack_from("<H", b, off)
        off += 2
        if v == 0xFFFF:
            return out
        if v > 20000:
            cur = v - 20000
            out[cur] = []
        else:
            out[cur].append(v)


def evolutions(rom):
    out = []
    for b in rom.narc("poketool/personal/evo.narc")[: N_SPECIES + 1]:
        evos = []
        for k in range(7):
            method, param, target = struct.unpack_from("<HHH", b, 6 * k)
            if method:
                evos.append({"method": method, "param": param, "target": target})
        out.append(evos)
    return out


def learnsets(rom, species_list):
    """Per species: levelUp [[lvl, move]], tm [move ids], egg [move ids]."""
    tms, lv, eggs = tm_moves(rom), level_up(rom), egg_moves(rom)
    out = []
    for s in species_list:
        bits = s["tmBits"]
        out.append({
            "levelUp": lv[s["id"]],
            "tm": [m for k, m in enumerate(tms) if bits >> k & 1],
            "egg": eggs.get(s["id"], []),
        })
    return out


def type_chart(rom):
    b = bytes(rom.overlay(11))
    out, off, foresight = [], OV11_TYPE_CHART, False
    while b[off] != 0xFF:
        a, d, m = b[off: off + 3]
        off += 3
        if a == 0xFE:
            foresight = True
            continue
        out.append({"atk": TYPES[a], "def": TYPES[d], "mult": m / 10, "foresightOnly": foresight})
    return out


def items(rom, msgs):
    names = msgs.archive(Messages.ITEMS)
    data = rom.narc("itemtool/itemdata/item_data.narc")
    arm9 = bytes(rom.nds.arm9)
    out = []
    for i, name in enumerate(names):
        idx = struct.unpack_from("<H", arm9, ARM9_ITEM_TABLE + 8 * i)[0]
        b = data[idx]
        out.append({
            "id": i, "name": name, "price": struct.unpack_from("<H", b, 0)[0],
            "holdEffect": b[2], "holdParam": b[3], "healAmount": b[27],  # 0xFF full, 0xFE half
        })
    return out


TRAINER_FLAG_MOVES, TRAINER_FLAG_ITEM = 1, 2


def trainers(rom, msgs):
    names = msgs.archive(Messages.TRAINER_NAMES)
    classes = msgs.archive(Messages.TRAINER_CLASSES)
    parties = rom.narc("poketool/trainer/trpoke.narc")
    out = []
    for i, b in enumerate(rom.narc("poketool/trainer/trdata.narc")):
        kind, cls, sprite, size = b[0:4]
        items_ = _u16s(b, 4, 4)
        ai, battle_type = struct.unpack_from("<II", b, 12)
        stride = 6 + (2 if kind & TRAINER_FLAG_ITEM else 0) + (8 if kind & TRAINER_FLAG_MOVES else 0)
        party, p = [], parties[i]
        for k in range(size):
            o = k * stride
            diff, abil_flags, level, sp = struct.unpack_from("<BBHH", p, o)
            mon = {"species": sp & 0x3FF, "form": sp >> 10, "level": level, "difficulty": diff,
                   "abilityFlags": abil_flags}
            o += 6
            if kind & TRAINER_FLAG_ITEM:
                mon["item"] = struct.unpack_from("<H", p, o)[0]
                o += 2
            if kind & TRAINER_FLAG_MOVES:
                mon["moves"] = _u16s(p, o, 4)
            party.append(mon)
        out.append({"id": i, "name": names[i], "class": classes[cls], "classId": cls, "sprite": sprite,
                    "items": items_, "aiFlags": ai, "battleType": battle_type, "party": party})
    return out


TRMSG_TYPES = {0: "preBattle", 1: "defeat", 2: "postBattle", 13: "firstDamage", 14: "halfHp",
               15: "lastMon", 16: "lastMonHalfHp"}


def trainer_messages(rom, msgs, trainer_id):
    """trtblofs[trainer] = byte offset into trtbl; trtbl = (u16 trainer, u16 type) rows,
    row k's text is message archive 558 entry k."""
    import ndspy.narc
    tbl = ndspy.narc.NARC(rom.file("poketool/trmsg/trtbl.narc")).files[0]
    ofs = ndspy.narc.NARC(rom.file("poketool/trmsg/trtblofs.narc")).files[0]
    lines = msgs.archive(Messages.TRAINER_MESSAGES)
    k, out = struct.unpack_from("<H", ofs, trainer_id * 2)[0] // 4, {}
    while k * 4 < len(tbl):
        tr, typ = struct.unpack_from("<HH", tbl, k * 4)
        if tr != trainer_id:
            break
        out[TRMSG_TYPES.get(typ, str(typ))] = lines[k]
        k += 1
    return out


NATURES = ["Hardy", "Lonely", "Brave", "Adamant", "Naughty", "Bold", "Docile", "Relaxed", "Impish", "Lax",
           "Timid", "Hasty", "Serious", "Jolly", "Naive", "Modest", "Mild", "Quiet", "Bashful", "Rash",
           "Calm", "Gentle", "Sassy", "Careful", "Quirky"]


def lcrng(seed):
    """Gen 4 LCRNG step: returns (new_seed, 16-bit output)."""
    seed = (seed * 0x41C64E6D + 0x6073) & 0xFFFFFFFF
    return seed, seed >> 16


def trainer_mon_personality(trainer_id, trainer_class, female, mon):
    """TrainerData_BuildParty (pret): seed = difficulty+level+species+trainerID, step LCRNG
    trainerClass times, PID = (rnd << 8) + (120 if female class else 136). Nature = PID % 25."""
    seed = rnd = mon["difficulty"] + mon["level"] + mon["species"] + trainer_id
    for _ in range(trainer_class):
        seed, rnd = lcrng(seed)
    pid = ((rnd << 8) + (120 if female else 136)) & 0xFFFFFFFF
    return {"pid": pid, "nature": NATURES[pid % 25], "abilitySlot": pid & 1, "iv": mon["difficulty"] * 31 // 255}
