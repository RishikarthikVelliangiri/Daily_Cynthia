"""Audio extraction gates: SWAV decoding, cries, and the software sequencer."""
import numpy as np
import pytest

from tools.extract import audio, rom


def test_ima_adpcm_vector():
    # header: predictor 0, index 0 (step 7). Nibble 7: diff = 0+7+3+1 = 11 -> 11, index 8 (step 16).
    # Nibble 8 (sign, magnitude 0): diff = 16>>3 = 2 -> 9, index 7.
    assert audio.adpcm(bytes([0, 0, 0, 0, 0x87])).tolist() == [11, 9]
    # clamps to +0x7FFF
    assert audio.adpcm(bytes([0xFE, 0x7F, 88, 0, 0x77]))[-1] == 0x7FFF


def test_decibel_table():
    assert [audio.db(x) for x in (0, 1, 2, 3, 64, 127)] == [-723, -722, -721, -651, -119, 0]


try:
    SD = audio.Sdat(rom.load().file("data/sound/sound_data.sdat"))
except FileNotFoundError:
    SD = None
needs_rom = pytest.mark.skipif(SD is None, reason="ROM not available")


@needs_rom
def test_sdat_names():
    for name in [*audio.BGM.values(), *audio.SE.values(), "SEQ_PV001"]:
        assert name in SD.seqs


@needs_rom
def test_cry_garchomp():
    smp, rate = audio.cry(SD, 445)
    assert 0.3 < len(smp) / rate < 3
    assert np.sqrt(np.mean(smp ** 2)) > 0.02


@needs_rom
def test_champion_theme():
    out, ls, le = audio.render(SD, "SEQ_BA_CHANP")
    dur = len(out) / audio.SR
    assert dur > 30 and out.shape[1] == 2
    assert 0 < ls < le <= dur + 1e-6
    rms = np.sqrt(np.mean(out ** 2))
    assert 0.03 < rms < 0.5
    assert np.sum(np.abs(out) >= 0.999) < 10


@needs_rom
def test_se_hit_nonsilent_and_short():
    out, ls, _ = audio.render(SD, "SEQ_SE_DP_KOUKA_M")
    assert ls is None and 0.1 < len(out) / audio.SR < 3 and np.abs(out).max() > 0.05
