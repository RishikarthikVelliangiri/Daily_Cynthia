"""ROM access: open the user's Diamond ROM and fetch NARC members by path."""
import functools
import glob
import os

import ndspy.narc
import ndspy.rom

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SUPPORTED = {b"ADAE"}  # Pokemon Diamond (USA). Other regions use different text/file layouts.


def find_rom():
    """ROM path from $DC_ROM, else the first *.nds under the repo (rom/ or 'Diamond NDS/')."""
    if os.environ.get("DC_ROM"):
        return os.environ["DC_ROM"]
    hits = sorted(glob.glob(os.path.join(REPO, "**", "*.nds"), recursive=True))
    if not hits:
        raise FileNotFoundError("No .nds ROM found. Put it in rom/ or set DC_ROM.")
    return hits[0]


class Rom:
    def __init__(self, path):
        self.nds = ndspy.rom.NintendoDSRom.fromFile(path)
        if bytes(self.nds.idCode) not in SUPPORTED:
            raise ValueError(f"Unsupported ROM {self.nds.idCode!r}; expected Diamond USA (ADAE)")
        self.revision = self.nds.version

    def file(self, path):
        return self.nds.getFileByName(path)

    @functools.lru_cache(maxsize=None)
    def narc(self, path):
        return ndspy.narc.NARC(self.file(path)).files

    @functools.cached_property
    def arm9(self):
        return self.nds.loadArm9()

    def overlay(self, i):
        return self.nds.loadArm9Overlays([i])[i].data

    def tree(self):
        out = []

        def walk(folder, prefix):
            for name, sub in folder.folders:
                walk(sub, prefix + name + "/")
            for i, name in enumerate(folder.files):
                fid = folder.firstID + i
                out.append((fid, prefix + name, len(self.nds.files[fid])))

        walk(self.nds.filenames, "")
        return sorted(out)


@functools.lru_cache(maxsize=1)
def load(path=None):
    return Rom(path or find_rom())
