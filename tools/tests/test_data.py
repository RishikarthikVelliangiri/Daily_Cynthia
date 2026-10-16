"""Phase 1 verification gates: decoded ROM data vs. known Gen 4 (Diamond) values."""
import pytest

from tools.extract import data, rom, text
from tools.extract.text import Messages

try:
    ROM = rom.load()
except FileNotFoundError:
    pytest.skip("ROM not available", allow_module_level=True)

MSGS = Messages(ROM)
SPECIES = data.species(ROM, MSGS)
MOVES = data.moves(ROM, MSGS)
BY_MOVE = {m["name"]: m for m in MOVES}
BY_SPECIES = {s["name"]: s for s in SPECIES}


def test_rom_identity():
    assert bytes(ROM.nds.idCode) == b"ADAE" and ROM.revision == 5


def test_text_roundtrip_and_names():
    assert MSGS.archive(Messages.SPECIES)[445] == "GARCHOMP"
    assert MSGS.archive(Messages.MOVES)[89] == "Earthquake"
    assert MSGS.archive(Messages.ABILITIES)[26] == "Levitate"
    assert MSGS.archive(Messages.ITEMS)[23] == "Full Restore"
    assert MSGS.archive(Messages.TRAINER_NAMES)[267] == "Cynthia"
    assert MSGS.archive(Messages.TYPES)[16] == "DRAGON"
    assert text._decode_chars(text.encode("Farfetch’d -Z!") + [0xFFFF]) == "Farfetch’d -Z!"


@pytest.mark.parametrize("name,stats,types", [
    ("Garchomp", (108, 130, 95, 102, 80, 85), ["Dragon", "Ground"]),
    ("Blissey", (255, 10, 10, 55, 75, 135), ["Normal"]),
    ("Shuckle", (20, 10, 230, 5, 10, 230), ["Bug", "Rock"]),
    ("Pikachu", (35, 55, 30, 90, 50, 40), ["Electric"]),
    ("Lucario", (70, 110, 70, 90, 115, 70), ["Fighting", "Steel"]),
    ("Spiritomb", (50, 92, 108, 35, 92, 108), ["Ghost", "Dark"]),
    ("Milotic", (95, 60, 79, 81, 100, 125), ["Water"]),
    ("Tyranitar", (100, 134, 110, 61, 95, 100), ["Rock", "Dark"]),
    ("Gengar", (60, 65, 60, 110, 130, 75), ["Ghost", "Poison"]),
    ("Togekiss", (85, 50, 95, 80, 120, 115), ["Normal", "Flying"]),
    ("Farfetch'd", (52, 65, 55, 60, 58, 62), ["Normal", "Flying"]),
])
def test_species_stats(name, stats, types):
    s = BY_SPECIES[name]
    b = s["baseStats"]
    assert (b["hp"], b["atk"], b["def"], b["spe"], b["spa"], b["spd"]) == stats
    assert s["types"] == types


def test_abilities():
    assert BY_SPECIES["Garchomp"]["abilities"] == ["Sand Veil"]
    assert BY_SPECIES["Gengar"]["abilities"] == ["Levitate"]
    assert BY_SPECIES["Milotic"]["abilities"] == ["Marvel Scale"]


@pytest.mark.parametrize("name,power,acc,pp,typ,cat,prio", [
    ("Earthquake", 100, 100, 10, "Ground", "Physical", 0),
    ("Thunderbolt", 95, 100, 15, "Electric", "Special", 0),
    ("Quick Attack", 40, 100, 30, "Normal", "Physical", 1),
    ("Dragon Rush", 100, 75, 10, "Dragon", "Physical", 0),
    ("Shadow Ball", 80, 100, 15, "Ghost", "Special", 0),
    ("Swords Dance", 0, 0, 30, "Normal", "Status", 0),
    ("Protect", 0, 0, 10, "Normal", "Status", 3),
    ("Aura Sphere", 90, 0, 20, "Fighting", "Special", 0),
    ("Giga Impact", 150, 90, 5, "Normal", "Physical", 0),
    ("Mirror Coat", 1, 100,  # ROM stores variable-damage moves as power 1
     20, "Psychic", "Special", -5),
    ("Fire Blast", 120, 85, 5, "Fire", "Special", 0),
])
def test_moves(name, power, acc, pp, typ, cat, prio):
    m = BY_MOVE[name]
    assert (m["power"], m["accuracy"], m["pp"], m["type"], m["category"], m["priority"]) == (power, acc, pp, typ, cat, prio)


def test_learnsets_garchomp():
    ls = data.learnsets(ROM, SPECIES)[445]
    lvl_moves = {m for _, m in ls["levelUp"]}
    assert BY_MOVE["Dragon Claw"]["id"] in lvl_moves
    assert BY_MOVE["Earthquake"]["id"] in ls["tm"]
    assert BY_MOVE["Dragon Claw"]["id"] in ls["tm"]  # TM02


def test_tm_table():
    tms = data.tm_moves(ROM)
    assert tms[0] == BY_MOVE["Focus Punch"]["id"]
    assert tms[25] == BY_MOVE["Earthquake"]["id"]  # TM26
    assert tms[92] == BY_MOVE["Cut"]["id"]  # HM01


def test_egg_moves():
    eggs = data.egg_moves(ROM)
    assert BY_MOVE["Light Screen"]["id"] in eggs[1]  # Bulbasaur
    assert BY_MOVE["Outrage"]["id"] in eggs[443]  # Gible


def test_evolution():
    evo = data.evolutions(ROM)
    assert evo[443][0]["target"] == 444 and evo[444][0]["target"] == 445
    assert evo[445] == []


def test_type_chart():
    chart = {(e["atk"], e["def"]): e["mult"] for e in data.type_chart(ROM) if not e["foresightOnly"]}
    assert chart[("Ghost", "Steel")] == 0.5 and chart[("Dark", "Steel")] == 0.5
    assert chart[("Ground", "Flying")] == 0 and chart[("Ice", "Dragon")] == 2
    assert ("Normal", "Ghost") not in chart  # lives in the foresight section


def test_items():
    it = {i["name"]: i for i in data.items(ROM, MSGS)}
    assert it["Full Restore"]["price"] == 3000 and it["Full Restore"]["healAmount"] == 0xFF
    assert it["Hyper Potion"]["healAmount"] == 200
    assert it["Sitrus Berry"]["price"] == 20


def test_cynthia():
    t = data.trainers(ROM, MSGS)[267]
    assert (t["name"], t["class"]) == ("Cynthia", "Champion")
    names = [SPECIES[m["species"]]["name"] for m in t["party"]]
    assert names == ["Spiritomb", "Roserade", "Gastrodon", "Lucario", "Milotic", "Garchomp"]
    assert [m["level"] for m in t["party"]] == [61, 60, 60, 63, 63, 66]
    assert t["party"][5]["moves"] == [BY_MOVE[n]["id"] for n in ("Dragon Rush", "Earthquake", "Brick Break", "Giga Impact")]
    assert t["items"] == [23, 23, 23, 23]
    assert t["aiFlags"] == 0x01


def test_cynthia_messages():
    m = data.trainer_messages(ROM, MSGS, 267)
    assert m["defeat"].startswith("...Just a few minutes ago")
    assert "lastMon" in m and "lastMonHalfHp" in m
    assert MSGS.archive(Messages.CHAMPION_ROOM)[0].startswith("Cynthia: Have you been keeping well?")


def test_lcrng():
    # Known Gen 3/4 LCRNG: seed 0 -> 0x00006073 -> 0xE97E7B6A
    s, _ = data.lcrng(0)
    assert s == 0x6073
    assert data.lcrng(s)[0] == 0xE97E7B6A
