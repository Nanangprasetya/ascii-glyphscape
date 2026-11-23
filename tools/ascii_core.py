from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

CHARSETS = {
    'ascii': ' .:-=+*#%@',
    'dots': ' .·:•●',
    'binary': ' 01',
    'blocks': ' ░▒▓█',
    'code': ' .-=/<>[]{}#',
}
GLITCH = '01<>/\\|=+*#@$%&{}'
STYLES = ('real', 'blue', 'dark', 'mesh')
MODES = ('dark', 'light')
BGS = {
    'real': {'dark': (6, 6, 8), 'light': (246, 245, 242)},
    'blue': {'dark': (38, 84, 222), 'light': (236, 241, 255)},
    'dark': {'dark': (10, 10, 12), 'light': (244, 242, 238)},
    'mesh': {'dark': (4, 6, 14), 'light': (240, 243, 250)},
}
ACC_D = (120, 240, 255)
ACC_L = (255, 50, 95)
BLUE_DARK_HOT = (200, 255, 255)
DARK_DARK_ADD = (60, 230, 255)
MESH_DARK_ADD = (120, 200, 255)


def mix(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def _byte(v: float) -> int:
    if v != v:
        return 0
    if v <= 0:
        return 0
    if v >= 255:
        return 255
    return int(v)


def rgb(a) -> tuple[int, int, int]:
    return (_byte(a[0]), _byte(a[1]), _byte(a[2]))


def luma(c) -> float:
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def pick(chars: str, v: float, minimum: int = 0) -> str:
    n = len(chars)
    try:
        i = int(v * n)
    except (OverflowError, ValueError):
        i = 0
    return chars[max(minimum, min(n - 1, i))]


@dataclass
class Look:
    style: str = 'real'
    mode: str = 'dark'
    mask: bool = False
    chars: str = CHARSETS['ascii']
    noise: float = 0.25
    gw: int = 1
    gh: int = 1
    accent: tuple[int, int, int] | None = None
    ink: tuple[int, int, int] | None = None
    ink_strength: float = 0.0
    charset: str = 'ascii'
    effect: float = 0.6
    direction: str = 'right'
    seed: int = 7
    light: bool = field(init=False)

    def __post_init__(self):
        self.light = self.mode == 'light'

    @property
    def hot(self) -> tuple[int, int, int]:
        if self.accent is not None:
            return self.accent
        return ACC_L if self.light else ACC_D


def background(style: str, mode: str, override=None) -> tuple[int, int, int]:
    return tuple(override) if override else BGS[style][mode]


def adjust(r, g, b, bc, sat, contrast, bright, mask, threshold=0.12, softness=0.18):
    if mask:
        dist = math.sqrt((r - bc[0]) ** 2 + (g - bc[1]) ** 2 + (b - bc[2]) ** 2) / 255
        m = min(1.0, max(0.0, (dist - threshold) / softness)) if softness > 0 else (1.0 if dist > threshold else 0.0)
    else:
        m = 1.0
    l0 = 0.299 * r + 0.587 * g + 0.114 * b
    out = []
    for c in (r, g, b):
        v = ((l0 + (c - l0) * sat) - 128) * contrast + 128
        v *= bright
        out.append(0.0 if v < 0 else (255.0 if v > 255 else v))
    rr, gg, bb = out
    return rr, gg, bb, (0.299 * rr + 0.587 * gg + 0.114 * bb) / 255, m


def cell_style(look: Look, x, y, r, g, b, L, m, n, h):
    masked = look.mask
    lt = look.light
    grain = 1 - look.noise * n
    st = look.style
    chars = look.chars
    acc = look.accent
    if st == 'real':
        if masked and m < 0.5:
            return _ink(look, (' ' if (x + y) % 3 else '.', rgb((205, 205, 200) if lt else (40, 40, 44)), None))
        v = 1 - L if lt else L
        col = (r * grain, g * grain, b * grain)
        if lt:
            col = (col[0] * 0.92, col[1] * 0.92, col[2] * 0.92)
        col = mix(col, look.hot, h)
        return _ink(look, (pick(chars, min(1, 0.55 + v * 0.45 + h), 1), rgb(col), None))
    if not lt:
        if st == 'blue':
            if masked:
                v = (0.18 + 0.82 * min(1, L * 1.3)) * m if m > 0.5 else 0
            else:
                v = min(1, max(0, (L - 0.22) * 1.5))
            v = min(1, v + h * 0.9) * (0.85 + 0.15 * grain)
            ch = pick(chars, v)
            if ch == ' ':
                ch = ' ' if (x + y) % 2 else '.'
                col = (60, 108, 236)
            else:
                col = mix((38, 84, 222), (255, 255, 255), 0.35 + 0.65 * v)
            if h > 0.15:
                col = mix(col, acc if acc is not None else BLUE_DARK_HOT, h)
            return _ink(look, (ch, rgb(col), None))
        if st == 'dark':
            k = ((0.15) * (1 - m) + (0.55 + 1.1 * L) * m if masked else 0.2 + 0.85 * math.pow(L, 1.6)) * grain
            base = mix((120, 30, 40), (r, g, b), m)
            col = (base[0] * k, base[1] * k, base[2] * k)
            add = _additive(acc, DARK_DARK_ADD)
            col = (col[0] + h * add[0], col[1] + h * add[1], col[2] + h * add[2])
            ch = pick(chars, min(1, L * m + h))
            if ch == ' ':
                ch = '.'
            return _ink(look, (ch, rgb(col), None))
        fx = x / look.gw
        fy = y / look.gh
        a = max(0.15, 1.1 - fx - fy * 0.3)
        w = max(0, 0.6 - fx - fy * 0.4)
        bg = (30 * a + 190 * w, 70 * a + 200 * w, 150 * a + 210 * w)
        sc = (0.7 + 0.9 * L if masked else 0.35 + 0.75 * math.pow(L, 1.4)) * grain
        col = mix(bg, (r * sc, g * sc, b * sc), m)
        add = _additive(acc, MESH_DARK_ADD)
        col = (col[0] + h * add[0], col[1] + h * add[1], col[2] + h * add[2])
        return _ink(look, (None, rgb(col), min(1, (col[0] * 0.3 + col[1] * 0.59 + col[2] * 0.11) / 255)))
    D = 1 - L
    hot = look.hot
    if st == 'blue':
        if masked:
            v = (0.2 + 0.8 * D) * m if m > 0.5 else 0
        else:
            v = min(1, max(0, (D - 0.15) * 1.4))
        v = min(1, v + h * 0.9) * (0.85 + 0.15 * grain)
        ch = pick(chars, v)
        if ch == ' ':
            ch = ' ' if (x + y) % 2 else '.'
            col = (200, 214, 250)
        else:
            col = mix((236, 241, 255), (30, 70, 215), 0.4 + 0.6 * v)
        if h > 0.15:
            col = mix(col, hot, h)
        return _ink(look, (ch, rgb(col), None))
    if st == 'dark':
        v = m * (0.25 + 0.75 * D) if masked else min(1, D * 1.15)
        v = min(1, v + h * 0.8)
        ch = pick(chars, v)
        if ch == ' ' or (masked and m < 0.5):
            ch = ' ' if (x + y) % 3 else '.'
            col = (200, 195, 190)
        else:
            q = (0.55 + 0.25 * L) * grain
            col = (r * q, g * q, b * q)
        return _ink(look, (ch, rgb(mix(col, hot, h)), None))
    bg = mix((226, 232, 245), (250, 250, 252), min(1, x / look.gw * 0.8 + y / look.gh * 0.3))
    q = 0.9 * grain
    col = mix(bg, (r * q, g * q, b * q), m)
    return _ink(look, (None, rgb(mix(col, hot, h)), 0.25 if masked and m < 0.5 else 0.25 + 0.75 * D))


def _additive(accent, default):
    return accent if accent is not None else default


def _ink(look: Look, out):
    if look.ink is None or look.ink_strength <= 0:
        return out
    ch, col, size = out
    lum = luma(col) / 255
    ink = look.ink
    tinted = (ink[0] * lum * 1.2, ink[1] * lum * 1.2, ink[2] * lum * 1.2)
    return ch, rgb(mix(col, tinted, look.ink_strength)), size


@dataclass
class Grid:
    gw: int
    gh: int
    r: list[float]
    g: list[float]
    b: list[float]
    L: list[float]
    m: list[float]
    n: list[float]
    sub: list[float] | None = None


def noise_field(count: int, seed: int) -> list[float]:
    rng = random.Random(seed)
    return [rng.random() for _ in range(count)]


def build_grid(pixels, gw: int, gh: int, *, sat, contrast, bright, mask, threshold, softness, noise,
               reference=None) -> Grid:
    bc = reference if reference is not None else pixels[0]
    rs, gs, bs, ls, ms = [], [], [], [], []
    ra, ga, ba, la, ma = rs.append, gs.append, bs.append, ls.append, ms.append
    b0, b1, b2 = bc[0], bc[1], bc[2]
    for (r, g, b) in pixels:
        if mask:
            dist = math.sqrt((r - b0) ** 2 + (g - b1) ** 2 + (b - b2) ** 2) / 255
            if softness > 0:
                m = (dist - threshold) / softness
                m = 0.0 if m < 0 else (1.0 if m > 1 else m)
            else:
                m = 1.0 if dist > threshold else 0.0
        else:
            m = 1.0
        l0 = 0.299 * r + 0.587 * g + 0.114 * b
        rr = (((l0 + (r - l0) * sat) - 128) * contrast + 128) * bright
        gg = (((l0 + (g - l0) * sat) - 128) * contrast + 128) * bright
        bb = (((l0 + (b - l0) * sat) - 128) * contrast + 128) * bright
        rr = 0.0 if rr < 0 else (255.0 if rr > 255 else rr)
        gg = 0.0 if gg < 0 else (255.0 if gg > 255 else gg)
        bb = 0.0 if bb < 0 else (255.0 if bb > 255 else bb)
        ra(rr)
        ga(gg)
        ba(bb)
        la((0.299 * rr + 0.587 * gg + 0.114 * bb) / 255)
        ma(m)
    return Grid(gw, gh, rs, gs, bs, ls, ms, noise)


def parse_hex(text) -> tuple[int, int, int] | None:
    if not isinstance(text, str):
        return None
    t = text.strip().lstrip('#')
    if len(t) == 3:
        t = ''.join(c * 2 for c in t)
    if len(t) != 6:
        return None
    try:
        return (int(t[0:2], 16), int(t[2:4], 16), int(t[4:6], 16))
    except ValueError:
        return None
