"""Graphics decoder checks (structure + known pixel facts); visual check via extracted/contact-sheets."""
import numpy as np
import pytest

from tools.extract import gfx, rom, text

try:
    ROM = rom.load()
except FileNotFoundError:
    pytest.skip("ROM not available", allow_module_level=True)


def test_dp_sprite_decrypt_garchomp():
    img = np.array(gfx.pokemon_sprite(ROM, 445, "front"))
    assert img.shape == (80, 160, 4)
    opaque = img[:, :80, 3] > 0
    assert 1500 < opaque.sum() < 5000  # a solid, mostly-filled 80x80 frame, not noise
    # undecrypted data would be noise: neighbouring opaque pixels mostly share colors in real art
    rgb = img[:, :80, :3].astype(int)
    same = (np.abs(np.diff(rgb, axis=1)).sum(-1) == 0)[opaque[:, 1:]]
    assert same.mean() > 0.4


def test_female_only_species_have_sprites():
    assert gfx.pokemon_sprite(ROM, 113, "front") is None  # Chansey: male slot empty
    assert gfx.pokemon_sprite(ROM, 113, "front", female=True) is not None


def test_font_glyphs():
    glyphs, widths = gfx.font(ROM.narc("graphic/font.narc")[0])
    assert glyphs.shape == (509, 16, 16)
    i, W = text.encode("i")[0] - 1, text.encode("W")[0] - 1
    assert widths[i] == 3 and widths[W] == 6  # proportional font; DP uppercase advances 6px
    # 'i' is a single vertical stroke; 'W' spans 5 columns
    assert len(np.nonzero((glyphs[i] == 1).any(0))[0]) == 1
    assert len(np.nonzero((glyphs[W] == 1).any(0))[0]) == 5


def test_nscr_block_order():
    bg = ROM.narc_lz("battle/graphic/batt_bg.narc")
    s = gfx.nscr(bg[2])
    assert s.shape == (32, 64)
    assert list(s[1, :4] & 0x3FF) == [32, 33, 34, 35]  # identity layout within the first 32x32 block
