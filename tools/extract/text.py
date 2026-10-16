r"""Gen 4 (DP) message archive decoder.

Archive layout (msgdata/msg.narc member):
  u16 count, u16 seed
  count x (u32 offset, u32 length_in_chars), each XOR'd with key2 = k | k<<16,
      k = (seed * 0x2FD * (i+1)) & 0xFFFF
  string i: u16 chars XOR'd with a rolling key starting (0x91BD3 * (i+1)) & 0xFFFF,
      key += 0x493D per char.
Chars: 0xFFFF end, 0xE000 newline, 0x25BC \r (scroll), 0x25BD \f (page),
0xFFFE <cmd u16> <argc u16> <args...> = text command (rendered {cmd:args}),
0xF100 = 9-bit packed string (Japanese-era names; decoded too).
"""
import struct

_CHARS = {0x0121 + i: c for i, c in enumerate("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")}
_CHARS.update({0x015F + i: c for i, c in enumerate("ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿŒœŞşªº¹²³$¡")})
_CHARS.update({0x01AA + i: c for i, c in enumerate("¿!?,.…·/‘’“”„«»()♂♀+-*#=&~:;♠♣♥♦★◉●■▲◆@♪%☀☁☂☃☺♚♛☹↗↘☽ ")})
_CHARS.update({0x01E8: "°", 0x01E9: "_", 0xE000: "\n", 0x25BC: "\r", 0x25BD: "\f", 0x01E2: " "})
_ENCODE = {c: k for k, c in _CHARS.items() if c not in "\n\r\f" and k != 0x01E2}
_ENCODE.update({"\n": 0xE000, "\r": 0x25BC, "\f": 0x25BD})


def _decode_chars(chars):
    out, i = [], 0
    if chars and chars[0] == 0xF100:  # 9-bit packed
        bits, n, unpacked = 0, 0, []
        for c in chars[1:]:
            bits |= c << n
            n += 15
            while n >= 9:
                v = bits & 0x1FF
                bits >>= 9
                n -= 9
                if v == 0x1FF:
                    break
                unpacked.append(v)
        chars = unpacked
    while i < len(chars):
        c = chars[i]
        if c == 0xFFFF:
            break
        if c == 0xFFFE:
            cmd, argc = chars[i + 1], chars[i + 2]
            args = chars[i + 3 : i + 3 + argc]
            out.append("{%04X:%s}" % (cmd, ",".join(map(str, args))))
            i += 3 + argc
            continue
        out.append(_CHARS.get(c, "[%04X]" % c))
        i += 1
    return "".join(out)


def decode_archive(data):
    count, seed = struct.unpack_from("<HH", data, 0)
    strings = []
    for i in range(count):
        k = (seed * 0x2FD * (i + 1)) & 0xFFFF
        k2 = k | (k << 16)
        off, ln = struct.unpack_from("<II", data, 4 + 8 * i)
        off ^= k2
        ln ^= k2
        key = (0x91BD3 * (i + 1)) & 0xFFFF
        chars = []
        for j in range(ln):
            chars.append(struct.unpack_from("<H", data, off + 2 * j)[0] ^ key)
            key = (key + 0x493D) & 0xFFFF
        strings.append(_decode_chars(chars))
    return strings


def encode(s):
    """English text -> list of DP char codes (used by tests and to search the ROM)."""
    return [_ENCODE[c] for c in s]


class Messages:
    """Index of msg.narc. Archive numbers for DP (USA), verified by tests."""

    SPECIES = 362
    MOVES = 588
    ABILITIES = 552
    ITEMS = 344
    TRAINER_CLASSES = 560
    TRAINER_NAMES = 559
    TYPES = 565
    MOVE_DESCRIPTIONS = 587
    TRAINER_MESSAGES = 558
    CHAMPION_ROOM = 180
    BATTLE = 324

    def __init__(self, rom):
        self.narc = rom.narc("msgdata/msg.narc")

    def archive(self, n):
        return decode_archive(self.narc[n])
