"""python -m tools.extract [rom.nds] [--only data|gfx|audio]  -> extracted/ (git-ignored)."""
import argparse
import json
import os
import time

from . import data, rom
from .text import Messages

OUT = os.path.join(rom.REPO, "extracted")

# Message archives the game uses directly (names are in data JSON).
TEXT_ARCHIVES = {"battle": 324, "champion_room": 180, "trainer_classes": 560, "types": 565,
                 "move_descriptions": 587, "battle_ui": 3}
CYNTHIA = 267


def write_json(name, obj):
    os.makedirs(os.path.join(OUT, "data"), exist_ok=True)
    with open(os.path.join(OUT, "data", name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def extract_data(r):
    msgs = Messages(r)
    species = data.species(r, msgs)
    for s in species:
        s.pop("tmBits")  # superseded by learnsets.tm
    write_json("species.json", species)
    write_json("moves.json", data.moves(r, msgs))
    write_json("learnsets.json", data.learnsets(r, data.species(r, msgs)))
    write_json("evolutions.json", data.evolutions(r))
    write_json("typechart.json", data.type_chart(r))
    write_json("items.json", data.items(r, msgs))
    trainers = data.trainers(r, msgs)
    cyn = trainers[CYNTHIA]
    for mon in cyn["party"]:  # Champion class is female (TrainerClass_Gender)
        mon.update(data.trainer_mon_personality(CYNTHIA, cyn["classId"], True, mon))
    write_json("trainers.json", trainers)
    txt = {k: msgs.archive(v) for k, v in TEXT_ARCHIVES.items()}
    txt["cynthia"] = data.trainer_messages(r, msgs, CYNTHIA)
    write_json("text.json", txt)
    with open(os.path.join(OUT, "data", "tr_ai_seq.bin"), "wb") as f:
        f.write(r.narc("battle/tr_ai/tr_ai_seq.narc")[0])
    write_json("meta.json", {"gameCode": bytes(r.nds.idCode).decode(), "revision": r.revision,
                             "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rom", nargs="?")
    ap.add_argument("--only", choices=["data", "gfx", "audio"])
    a = ap.parse_args()
    r = rom.load(a.rom)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "rom-tree.txt"), "w") as f:
        f.writelines("%4d %s %d\n" % t for t in r.tree())
    if a.only in (None, "data"):
        extract_data(r)
        print("data ok")
    if a.only in (None, "gfx"):
        from . import gfx
        gfx.extract(r, OUT)
        print("gfx ok")
    if a.only in (None, "audio"):
        from . import audio
        audio.extract(r, OUT)
        print("audio ok")


if __name__ == "__main__":
    main()
