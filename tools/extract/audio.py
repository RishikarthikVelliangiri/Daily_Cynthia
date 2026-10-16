"""SDAT audio -> extracted/audio: Pokemon cries (raw SWAV dumps) + BGM/SFX rendered by a small
software Nitro sequencer (SSEQ events + SBNK instruments + SWAR samples). See the
"Audio (SDAT)" section of .claude/skills/nds-graphics-formats/SKILL.md for the semantics."""
import json
import math
import os
import subprocess
import tempfile
import wave

import numpy as np
import ndspy.soundArchive

SR = 32728                                  # output rate (~ DS mixer rate)
FRAME = 64 * 2728 / 33513982                # sound-driver update period (~5.21 ms, ~192 Hz)
SPF = SR * FRAME                            # output samples per driver frame
ARM7_CLOCK = 16756991                       # SWAV.time = ARM7_CLOCK / sampleRate
AMPL_MIN = -723 << 7                        # envelope floor (silence)
GAIN = 0.5                                  # final mix gain (tuned so champion theme peaks < 1)

BGM = {"battle_champion": "SEQ_BA_CHANP", "victory_champion": "SEQ_WINCHAMP",
       "encounter_champion": "SEQ_EYE_CHAMP",
       "champion_room": "SEQ_D_LEAGUE"}     # map header of the Champion/E4 rooms (msg archive 180)
SE = {"hit": "SEQ_SE_DP_KOUKA_M", "hit_super": "SEQ_SE_DP_KOUKA_H", "hit_weak": "SEQ_SE_DP_KOUKA_L",
      "select": "SEQ_SE_DP_DECIDE", "cursor": "SEQ_SE_DP_SELECT", "hp_low": "SEQ_SE_DP_HINSI"}

# --- tables -------------------------------------------------------------------------------
_ATTACK_LUT = [0x00, 0x01, 0x05, 0x0E, 0x1A, 0x26, 0x33, 0x3F, 0x49, 0x54,
               0x5C, 0x64, 0x6D, 0x74, 0x7B, 0x7F, 0x84, 0x89, 0x8F]
_IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55,
             60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
             337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
             1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
             5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500,
             20350, 22385, 24623, 27086, 29794, 32767]
_IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8]
_SIN = np.round(127 * np.sin(np.arange(128) * 2 * np.pi / 128)).astype(np.int64)


def db(x):
    """SNDi_DecibelSquareTable equivalent: 0..127 -> centibels (40*log10(x/127)), 0 -> silence."""
    return -723 if x <= 0 else max(-722, round(400 * math.log10(min(x, 127) / 127)))


def attack_rate(a):
    return _ATTACK_LUT[127 - a] if a >= 109 else 255 - a


def fall_rate(x):
    return 0xFFFF if x == 127 else 0x3C00 if x == 126 else x * 2 + 1 if x < 50 else 0x1E00 // (126 - x)


# --- samples -------------------------------------------------------------------------------
def adpcm(data):
    """DS IMA-ADPCM: 4-byte header (s16 predictor, u8 step index), then low-nibble-first."""
    pred = int.from_bytes(data[0:2], "little", signed=True)
    idx = min(data[2], 88)
    out = np.empty((len(data) - 4) * 2, np.int16)
    k = 0
    for b in data[4:]:
        for n in (b & 15, b >> 4):
            step = _IMA_STEP[idx]
            diff = step >> 3
            if n & 4: diff += step
            if n & 2: diff += step >> 1
            if n & 1: diff += step >> 2
            pred = max(-0x7FFF, pred - diff) if n & 8 else min(0x7FFF, pred + diff)
            idx = min(88, max(0, idx + _IMA_INDEX[n & 7]))
            out[k] = pred
            k += 1
    return out


def decode_swav(w):
    """SWAV -> (float32 samples in [-1,1], loop start sample or None)."""
    t = int(w.waveType)
    if t == 0:
        s, per_word, hdr = np.frombuffer(w.data, np.int8).astype(np.float32) / 128, 4, 0
    elif t == 1:
        s, per_word, hdr = np.frombuffer(w.data[:len(w.data) // 2 * 2], "<i2").astype(np.float32) / 32768, 2, 0
    else:
        s, per_word, hdr = adpcm(w.data).astype(np.float32) / 32768, 8, 8
    s = s[:max(1, w.totalLength * per_word - hdr)] if w.totalLength else s
    return s, (w.loopOffset * per_word - hdr if w.isLooped else None)


def psg_wave(kind, duty):
    if kind == 2:  # square, 8 steps per period; duty 0..6 = 1/8..7/8 high, 7 = silent
        return np.where(np.arange(8) < (duty + 1) % 8, 1.0, -1.0).astype(np.float32), 0
    lfsr, out = 0x7FFF, []
    for _ in range(32767):
        bit = lfsr & 1
        lfsr = (lfsr >> 1) ^ (0x6000 if bit else 0)
        out.append(1.0 if bit else -1.0)
    return np.array(out, np.float32), 0


# --- sequencer -----------------------------------------------------------------------------
class Track:
    def __init__(self, pc, frame):
        self.pc, self.f0, self.wait, self.calls, self.loops = pc, frame, 0, [], []
        self.mono, self.prg, self.vol, self.expr, self.pan = True, 0, 127, 127, 64
        self.bend, self.brange, self.transpose, self.adsr, self.sweep = 0, 2, 0, [255] * 4, 0
        self.mod = [0, 16, 0, 1, 0]  # depth, speed, type, range, delay
        self.done, self.seen, self.loop, self.hist = False, {}, None, []


def _varlen(d, pc):
    v = 0
    while True:
        b = d[pc]
        pc += 1
        v = (v << 7) | (b & 0x7F)
        if not b & 0x80:
            return v, pc


def simulate(data, seq_volume, max_frames=192 * 600):
    """Run the SSEQ bytecode on the driver's frame clock.
    Returns notes, {track: hist array}, tick->frame list, loop (startTick, endTick) or None."""
    d = bytes(data)
    tr = {0: Track(0, 0)}
    notes, tick_frames = [], []
    g = {"tempo": 120, "master": 127}
    counter = tick = frame = 0

    def step(t):
        if t.wait > 0:
            t.wait -= 1
            if t.wait > 0:
                return
        while t.wait == 0 and not t.done:
            pc = t.pc
            t.seen.setdefault(pc, tick)
            c = d[pc]
            pc += 1
            if c < 0x80:
                dur, pc = _varlen(d, pc + 1)
                notes.append(dict(track=t, tick=tick, frame=frame, dur=dur, key=c + t.transpose,
                                  vel=d[t.pc + 1] & 0x7F, prg=t.prg, adsr=list(t.adsr),
                                  mod=list(t.mod), sweep=t.sweep))
                if t.mono:
                    t.wait = dur
            elif c == 0x80:
                t.wait, pc = _varlen(d, pc)
            elif c == 0x81:
                t.prg, pc = _varlen(d, pc)
            elif c == 0x93:
                tr.setdefault(d[pc], Track(int.from_bytes(d[pc + 1:pc + 4], "little"), frame))
                pc += 4
            elif c == 0x94:
                dest = int.from_bytes(d[pc:pc + 3], "little")
                if dest in t.seen and t.loop is None:
                    t.loop = (t.seen[dest], tick)
                pc = dest
            elif c == 0x95:
                t.calls.append(pc + 3)
                pc = int.from_bytes(d[pc:pc + 3], "little")
            elif c == 0xFD:
                pc = t.calls.pop()
            elif c == 0xD4:
                t.loops.append([pc + 1, d[pc]])
                pc += 1
            elif c == 0xFC:
                ent = t.loops[-1]
                if ent[1] == 0:  # infinite loop: treat like a backward jump
                    if t.loop is None:
                        t.loop = (t.seen[ent[0]], tick)
                    pc = ent[0]
                else:
                    ent[1] -= 1
                    if ent[1] > 0:
                        pc = ent[0]
                    else:
                        t.loops.pop()
            elif c == 0xFF:
                t.done = True
            elif c == 0xFE:
                pc += 2
            elif c in (0xE0, 0xE1, 0xE3):
                v = int.from_bytes(d[pc:pc + 2], "little", signed=c == 0xE3)
                pc += 2
                if c == 0xE0: t.mod[4] = v
                elif c == 0xE1: g["tempo"] = v
                else: t.sweep = v
            elif 0xC0 <= c <= 0xD6:
                v = d[pc]
                pc += 1
                sv = v - 256 if v > 127 else v
                if c == 0xC0: t.pan = v
                elif c == 0xC1: t.vol = v
                elif c == 0xC2: g["master"] = v
                elif c == 0xC3: t.transpose = sv
                elif c == 0xC4: t.bend = sv
                elif c == 0xC5: t.brange = v
                elif c == 0xC7: t.mono = v == 1
                elif 0xCA <= c <= 0xCD: t.mod[c - 0xCA] = v
                elif 0xD0 <= c <= 0xD3: t.adsr[c - 0xD0] = v
                elif c == 0xD5: t.expr = v
                elif c in (0xC8, 0xC9, 0xCE) and v:
                    # ponytail: tie/portamento unused by the sequences we render; add if needed
                    raise NotImplementedError(f"SSEQ opcode {c:#x} {v} at {t.pc:#x}")
                # C6 priority, CF porta time, D6 print: ignored
            else:
                raise NotImplementedError(f"SSEQ opcode {c:#x} at {t.pc:#x}")  # A0-BD var/rand/if
            t.pc = pc

    while frame < max_frames:
        counter += g["tempo"]
        while counter >= 240:
            counter -= 240
            tick_frames.append(frame)
            for n in range(16):
                if n in tr and not tr[n].done:
                    step(tr[n])
            tick += 1
        base = db(seq_volume) + db(g["master"])
        for t in tr.values():
            t.hist.append((base + db(t.vol) + db(t.expr), t.pan, (t.bend * t.brange) >> 1,
                           t.mod[0], t.mod[3]))
        frame += 1
        if all(t.done or t.loop for t in tr.values()):
            break
    looping = [t.loop for t in tr.values() if t.loop]
    loop = max(looping, key=lambda x: x[1]) if looping else None
    if loop:
        notes = [n for n in notes if n["tick"] < loop[1]]
    return notes, tick_frames, g["tempo"], loop


def tick_to_frame(tick, tick_frames, tempo):
    if tick < len(tick_frames):
        return tick_frames[tick]
    return tick_frames[-1] + (tick - len(tick_frames) + 1) * 240 / tempo


# --- renderer ------------------------------------------------------------------------------
class Sdat:
    def __init__(self, sdat_bytes):
        self.a = ndspy.soundArchive.SDAT(sdat_bytes)
        self.seqs = {n: s for n, s in self.a.sequences if n}
        self.banks = {n: b for n, b in self.a.banks if n}
        self._waves = {}

    def wave(self, bank, nd):
        if nd.type != 1:  # PSG square / noise
            key = ("psg", int(nd.type), nd.waveID)
            if key not in self._waves:
                s, ls = psg_wave(int(nd.type), nd.waveID)
                self._waves[key] = (s, ls, 8 * 440.0)  # 8 steps/period; key 69 plays A440
            return self._waves[key]
        key = (bank.waveArchiveIDs[nd.waveArchiveIDID], nd.waveID)
        if key not in self._waves:
            w = self.a.waveArchives[key[0]][1].waves[nd.waveID]
            s, ls = decode_swav(w)
            self._waves[key] = (s, ls, ARM7_CLOCK / w.time if w.time else w.sampleRate)
        return self._waves[key]


def note_def(inst, key):
    if inst is None:
        return None
    if hasattr(inst, "noteDefinition"):
        return inst.noteDefinition
    if hasattr(inst, "firstPitch"):
        i = key - inst.firstPitch
        return inst.noteDefinitions[i] if 0 <= i < len(inst.noteDefinitions) else None
    return next((r.noteDefinition for r in inst.regions if key <= r.lastPitch), None)


def envelope(n, nd, keyoff, cap):
    """Per-frame envelope level (<<7 centibels), DS driver ADSR."""
    a, dcy, s, r = (o if o != 255 else v for o, v in
                    zip(n["adsr"], (nd.attack, nd.decay, nd.sustain, nd.release)))
    a, dcy, s, r = attack_rate(a), fall_rate(dcy), db(s) << 7, fall_rate(r)
    lvl, state, env = AMPL_MIN, 0, []
    for i in range(cap):
        if keyoff is not None and i >= keyoff:
            state = 3
        if state == 0:
            lvl = -((-lvl * a) >> 8)
            if lvl == 0:
                state = 1
        elif state == 1:
            lvl -= dcy
            if lvl <= s:
                lvl, state = s, 2
        elif state == 3:
            lvl -= r
            if lvl <= AMPL_MIN:
                break
        env.append(lvl)
    return np.array(env, np.int64)


def render_note(out, sd, bank, n, hist, keyoff_frame):
    nd = note_def(bank.instruments[n["prg"]] if n["prg"] < len(bank.instruments) else None, n["key"])
    if nd is None:
        return
    smp, ls, rate = sd.wave(bank, nd)
    keyoff = None if keyoff_frame is None else max(1, int(round(keyoff_frame - n["frame"])))
    cap = int(10 / FRAME)
    if ls is None:  # one-shot: never longer than the sample at 4x slower than base pitch
        cap = min(cap, int(len(smp) / rate * 4 / FRAME) + 2)
    env = envelope(n, nd, keyoff, cap)
    N = len(env)
    if N == 0:
        return
    f = np.minimum(n["frame"] - n["track"].f0 + np.arange(N), len(hist) - 1)
    h = hist[f]
    depth, mrange = h[:, 3], h[:, 4]
    _, speed, mtype, _, delay = n["mod"]
    lfo = np.cumsum((np.arange(N) >= delay) * (speed << 6)) & 0x7FFF
    mod = _SIN[lfo >> 8] * mrange * depth
    pitch = (n["key"] - (nd.pitch if nd.type == 1 else 69)) * 64 + h[:, 2] + (mod >> 8 if mtype == 0 else 0)
    if n["sweep"]:
        pitch = pitch + (n["sweep"] * np.clip(1 - np.arange(N) / max(1, keyoff or N), 0, 1)).astype(np.int64)
    cb = h[:, 0] + db(n["vel"]) + (env >> 7) + ((mod * 60) >> 14 if mtype == 1 else 0)
    amp = np.where(cb <= -723, 0.0, 10.0 ** (np.maximum(cb, -723) / 200))
    pan = np.clip(h[:, 1] + nd.pan - 64 + (mod >> 8 if mtype == 2 else 0), 0, 127)
    step = rate * 2.0 ** (pitch / 768) / SR

    ns = int(N * SPF)
    fi = (np.arange(ns) / SPF).astype(np.int64)
    pos = np.cumsum(step[fi]) - step[0]
    i0 = pos.astype(np.int64)
    L = len(smp)
    if ls is None:
        ns = int(np.searchsorted(i0, L - 1))
        i0, pos, fi = i0[:ns], pos[:ns], fi[:ns]
        i1 = i0 + 1
    else:
        span = max(1, L - ls)
        wrap = lambda i: np.where(i >= L, ls + (i - ls) % span, i)
        i0, i1 = wrap(i0), wrap(i0 + 1)
    frac = (pos - np.floor(pos)).astype(np.float32)
    s = smp[i0] * (1 - frac) + smp[np.minimum(i1, L - 1)] * frac
    a = np.interp(np.arange(ns) / SPF, np.arange(N), amp).astype(np.float32)
    p = pan[fi] / 127.0
    start = int(round(n["frame"] * SPF))
    end = min(start + ns, len(out))
    k = end - start
    if k > 0:
        out[start:end, 0] += (s * a * (1 - p))[:k]
        out[start:end, 1] += (s * a * p)[:k]


def render(sd, name):
    """Render a sequence -> (float32 stereo array, loopStart s, loopEnd s)."""
    seq = sd.seqs[name]
    bank = sd.a.banks[seq.bankID][1]
    notes, tick_frames, tempo, loop = simulate(seq.eventsData, seq.volume)
    hist = {}
    total_frames = (tick_frames[-1] if tick_frames else 0) + int(12 / FRAME)
    out = np.zeros((int(total_frames * SPF) + 1, 2), np.float32)
    for n in notes:
        t = n["track"]
        if id(t) not in hist:
            hist[id(t)] = np.array(t.hist, np.int64)
        ko = tick_to_frame(n["tick"] + n["dur"], tick_frames, tempo) if n["dur"] else None
        render_note(out, sd, bank, n, hist[id(t)], ko)
    out *= GAIN
    if loop:
        ls, le = (int(round(tick_to_frame(x, tick_frames, tempo) * SPF)) for x in loop)
        tail = out[le:le + (le - ls)]
        out[ls:ls + len(tail)] += tail  # fold release tails over the loop seam
        out = out[:le]
        loop_s = (ls / SR, le / SR)
    else:
        nz = np.nonzero(np.abs(out).max(axis=1) > 1e-4)[0]
        out = out[:(nz[-1] + 1 if len(nz) else 1)]
        loop_s = (None, None)
    peak = float(np.abs(out).max()) if len(out) else 0
    if peak > 0.99:
        out *= 0.99 / peak
    return out, *loop_s


# --- output --------------------------------------------------------------------------------
def write_wav(path, samples, rate, width=2):
    """samples: float array (n,) or (n, ch) in [-1, 1]; width 1 = unsigned 8-bit (lossless for PCM8)."""
    x = np.asarray(samples)
    s = (np.clip(x * 128 + 128, 0, 255).astype(np.uint8) if width == 1
         else np.clip(x * 32767, -32768, 32767).astype("<i2"))
    with wave.open(path, "wb") as w:
        w.setnchannels(1 if s.ndim == 1 else s.shape[1])
        w.setsampwidth(width)
        w.setframerate(int(round(rate)))
        w.writeframes(s.tobytes())


def write_ogg(path_noext, samples):
    """Encode via ffmpeg/libvorbis; fall back to WAV. Returns the written file name."""
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        write_wav(tmp, samples, SR)
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-c:a", "libvorbis",
                            "-q:a", "6", path_noext + ".ogg"], capture_output=True)
        if r.returncode == 0:
            return os.path.basename(path_noext) + ".ogg"
        os.replace(tmp, path_noext + ".wav")
        return os.path.basename(path_noext) + ".wav"
    except FileNotFoundError:  # no ffmpeg
        os.replace(tmp, path_noext + ".wav")
        return os.path.basename(path_noext) + ".wav"
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def cry(sd, species):
    """(samples, rate) for a species cry: SEQ_PV001 (key 60) played with bank *index* = dex no.
    Bank/wave-archive names for 387-493 are dev numbers (e.g. index 445 is BANK_PV493)."""
    bank = sd.a.banks[species][1]
    nd = bank.instruments[0].noteDefinition
    smp, _, rate = sd.wave(bank, nd)
    return smp, rate * 2 ** ((60 - nd.pitch) / 12)


def extract(rom, out_dir):
    base = os.path.join(out_dir, "audio")
    os.makedirs(os.path.join(base, "cry"), exist_ok=True)
    sd = Sdat(rom.file("data/sound/sound_data.sdat"))
    for i in range(1, 494):
        smp, rate = cry(sd, i)
        write_wav(os.path.join(base, "cry", f"{i:03d}.wav"), smp, rate, width=1)  # all DP cries are PCM8
    manifest = {"bgm": {}, "se": {}, "cryFormat": "wav"}
    for key, name in BGM.items():
        out, ls, le = render(sd, name)
        f = write_ogg(os.path.join(base, "bgm_" + key), out)
        manifest["bgm"][key] = {"file": f, "seq": name, "loopStart": ls and round(ls, 6),
                                "loopEnd": le and round(le, 6), "duration": round(len(out) / SR, 6)}
    for key, name in SE.items():
        out, _, _ = render(sd, name)
        manifest["se"][key] = write_ogg(os.path.join(base, "se_" + key), out)
    with open(os.path.join(base, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    return manifest
