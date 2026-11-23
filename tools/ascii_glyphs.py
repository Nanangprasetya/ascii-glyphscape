from __future__ import annotations

import random
from functools import lru_cache

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

import ascii_core as core

PUA = 0xE000
LEVEL = 0x500
BRAILLE = 0x100
QUAD = 0x200
DOT = 0x300
BRICK = 0x400
STREAK = 0x600
UP = 8

IDS = ('ascii', 'detailed', 'blocks', 'tiles', 'sparse', 'binary', 'braille', 'dots', 'dither',
       'bricks', 'particle', 'film', 'drift', 'code', 'custom')
DIRECTIONS = ('right', 'left', 'down', 'up')

DETAILED = " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"
SPARSE = '        .:+#'
FILM = ' .:-=+ILTJFCSOUZ0QDGB8HNMW#@'
TILES = ' @8%#&WMB$QSZXoxtci+=:-'

BAYER4 = ((0, 8, 2, 10), (12, 4, 14, 6), (3, 11, 1, 9), (15, 7, 13, 5))
THRESH = tuple(tuple((v + 0.5) / 16 for v in row) for row in BAYER4)


def mark(base: int, k: int) -> str:
    return chr(PUA + base + k)


def code(c: str) -> int:
    return ord(c) - PUA


def is_marker(c) -> bool:
    return bool(c) and PUA + LEVEL <= ord(c) < PUA + LEVEL + 64


def is_private(c: str) -> bool:
    return 0xE000 <= ord(c) <= 0xF8FF


def markers(count: int) -> str:
    return ' ' + ''.join(mark(LEVEL, k) for k in range(1, count + 1))


LEVELS = markers(8)


def ramp_for(charset: str, custom: str = '') -> str:
    if charset == 'custom':
        return custom if len(custom) >= 2 else core.CHARSETS['ascii']
    if charset in core.CHARSETS:
        return core.CHARSETS[charset]
    found = SETS.get(charset)
    return found.ramp if found else core.CHARSETS['ascii']


def for_look(look: core.Look) -> 'GlyphSet':
    return SETS.get(look.charset, GlyphSet)(look)


def level_fn(look: core.Look):
    st, lt, masked = look.style, look.light, look.mask
    if st in ('real', 'mesh'):
        if lt:
            return lambda L, m, h: min(1.0, 1.0 - L + h)
        return lambda L, m, h: min(1.0, L + h)
    if not lt:
        if st == 'blue':
            if masked:
                return lambda L, m, h: min(1.0, ((0.18 + 0.82 * min(1.0, L * 1.3)) * m if m > 0.5 else 0.0) + h * 0.9)
            return lambda L, m, h: min(1.0, min(1.0, max(0.0, (L - 0.22) * 1.5)) + h * 0.9)
        return lambda L, m, h: min(1.0, L * m + h)
    if st == 'blue':
        if masked:
            return lambda L, m, h: min(1.0, ((0.2 + 0.8 * (1.0 - L)) * m if m > 0.5 else 0.0) + h * 0.9)
        return lambda L, m, h: min(1.0, min(1.0, max(0.0, (0.85 - L) * 1.4)) + h * 0.9)
    if masked:
        return lambda L, m, h: min(1.0, m * (0.25 + 0.75 * (1.0 - L)) + h * 0.8)
    return lambda L, m, h: min(1.0, min(1.0, (1.0 - L) * 1.15) + h * 0.8)


def _gap(cell: int) -> int:
    return 1 if cell >= 5 else 0


def _blank(cell: int) -> Image.Image:
    return Image.new('L', (cell, cell), 0)


def _reduce(big: Image.Image, cell: int) -> Image.Image:
    return big.resize((cell, cell), Image.Resampling.BOX)


@lru_cache(maxsize=256)
def braille_tile(cell: int, parity: int, k: int) -> Image.Image:
    size = cell * UP
    big = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(big)
    r = max(0.6, 0.13 * cell) * UP
    ys = (0.29, 0.71) if parity == 0 else (0.13, 0.55)
    for bit, (fx, fy) in enumerate(((0.29, ys[0]), (0.71, ys[0]), (0.29, ys[1]), (0.71, ys[1]))):
        if k & (1 << bit):
            cx, cy = fx * size, fy * size
            draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    return _reduce(big, cell)


@lru_cache(maxsize=256)
def quad_tile(cell: int, k: int) -> Image.Image:
    big = Image.new('L', (cell * UP, cell * UP), 0)
    draw = ImageDraw.Draw(big)
    half = (cell - _gap(cell)) * UP / 2
    for bit, (qx, qy) in enumerate(((0, 0), (1, 0), (0, 1), (1, 1))):
        if k & (1 << bit):
            draw.rectangle((round(qx * half), round(qy * half), round((qx + 1) * half) - 1, round((qy + 1) * half) - 1), fill=255)
    return _reduce(big, cell)


DOT_RADII = (0.11, 0.17, 0.25)


@lru_cache(maxsize=256)
def dot_tile(cell: int, s: int, j: int) -> Image.Image:
    size = cell * UP
    big = Image.new('L', (size, size), 0)
    r = max(0.6, DOT_RADII[s] * cell) * UP
    room = max(0.0, 0.5 * size - r - 0.06 * size)
    cx = size / 2 + (j % 3 - 1) * room
    cy = size / 2 + (j // 3 - 1) * room
    ImageDraw.Draw(big).ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    return _reduce(big, cell)


@lru_cache(maxsize=64)
def brick_tile(cell: int, k: int) -> Image.Image:
    big = Image.new('L', (cell * UP, cell * UP), 0)
    draw = ImageDraw.Draw(big)
    inner = (cell - _gap(cell)) * UP
    w = max(UP, round(0.13 * inner))
    rad = round(0.1 * inner)
    if k == 1:
        a, b = inner * 0.25, inner * 0.75
        draw.rounded_rectangle((a, a, b - 1, b - 1), radius=rad // 2, outline=255, width=max(UP, round(w * 0.8)))
    elif k in (2, 3):
        draw.rounded_rectangle((0, 0, inner - 1, inner - 1), radius=rad, outline=255, width=w)
        if k == 3:
            a, b = inner * 0.32, inner * 0.68
            draw.rectangle((a, a, b - 1, b - 1), fill=255)
    else:
        draw.rounded_rectangle((0, 0, inner - 1, inner - 1), radius=rad, fill=255)
    return _reduce(big, cell)


STREAK_WIDTHS = (0.16, 0.32, 0.5, 0.7)


@lru_cache(maxsize=64)
def streak_tile(cell: int, axis: int, k: int) -> Image.Image:
    size = cell * UP
    big = Image.new('L', (size, size), 0)
    thick = max(UP, STREAK_WIDTHS[k - 1] * (cell - _gap(cell)) * UP)
    a = (size - _gap(cell) * UP - thick) / 2
    box = (0, a, size - 1, a + thick - 1) if axis == 0 else (a, 0, a + thick - 1, size - 1)
    ImageDraw.Draw(big).rectangle(box, fill=255)
    return _reduce(big, cell)


@lru_cache(maxsize=16)
def _font(path: str, size: int):
    return ImageFont.truetype(path, size)


@lru_cache(maxsize=512)
def letter_tile(cell: int, c: str, font_path: str) -> Image.Image:
    size = cell * UP
    inner = (cell - _gap(cell)) * UP
    big = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(big)
    if c == '.':
        a, b = inner * 0.32, inner * 0.68
        draw.rounded_rectangle((a, a, b - 1, b - 1), radius=round(inner * 0.08), fill=255)
        return _reduce(big, cell)
    draw.rounded_rectangle((0, 0, inner - 1, inner - 1), radius=round(inner * 0.2), fill=255)
    font = _font(font_path, max(4, round(inner * 0.74)))
    glyph = Image.new('L', (size, size), 0)
    ImageDraw.Draw(glyph).text((size / 2, size / 2), c, fill=255, font=font, anchor='mm')
    box = glyph.getbbox()
    if box:
        dx = round(inner / 2 - (box[0] + box[2]) / 2)
        dy = round(inner / 2 - (box[1] + box[3]) / 2)
        glyph = ImageChops.offset(glyph, dx, dy)
        big = ImageChops.subtract(big, glyph)
    return _reduce(big, cell)


class GlyphSet:
    id = 'page'
    ramp = ''
    extra = ''
    calibrate = False
    subgrid = False
    procedural = False

    def __init__(self, look: core.Look):
        self.look = look

    def draw(self, c: str, cell: int, font_path: str):
        if is_marker(c):
            return _blank(cell)
        return None

    def bind(self, painter) -> None:
        pass

    def arrange(self, painter, chs: list, cols: list, grid: core.Grid, heat: float) -> None:
        pass

    def single(self, painter, i: int, ch, col, grid: core.Grid, heat: float):
        return ch, col

    def offset(self, y: int, cell: int) -> int:
        return 0

    def placed(self, painter, frame: Image.Image) -> Image.Image:
        return frame

    def finish(self, painter, frame: Image.Image, index: int = 0) -> Image.Image:
        return frame


class Detailed(GlyphSet):
    id = 'detailed'
    ramp = DETAILED
    calibrate = True


class Sparse(GlyphSet):
    id = 'sparse'
    ramp = SPARSE


class Tiles(GlyphSet):
    id = 'tiles'
    ramp = TILES
    calibrate = True

    def draw(self, c, cell, font_path):
        if c.isspace():
            return None
        if is_marker(c):
            return _blank(cell)
        return letter_tile(cell, c, font_path)


class _Sampled(GlyphSet):
    ramp = LEVELS
    subgrid = True
    procedural = True

    def tile(self, y: int, k: int) -> str:
        raise NotImplementedError

    def pattern(self, painter, i: int, grid: core.Grid, heat: float) -> int:
        gw = painter.gw
        x, y = i % gw, i // gw
        lv = painter.level
        m = grid.m[i]
        sub = grid.sub
        if sub is None:
            a = b = c = d = lv(grid.L[i], m, heat)
        else:
            sw = gw * 2
            o = 2 * y * sw + 2 * x
            a, b = lv(sub[o], m, heat), lv(sub[o + 1], m, heat)
            c, d = lv(sub[o + sw], m, heat), lv(sub[o + sw + 1], m, heat)
        t0, t1 = THRESH[(2 * y) & 3], THRESH[(2 * y + 1) & 3]
        cx = (2 * x) & 3
        return (a > t0[cx]) | ((b > t0[cx + 1]) << 1) | ((c > t1[cx]) << 2) | ((d > t1[cx + 1]) << 3)

    def arrange(self, painter, chs, cols, grid, heat):
        gw = painter.gw
        for i, ch in enumerate(chs):
            if is_marker(ch):
                k = self.pattern(painter, i, grid, heat)
                chs[i] = self.tile(i // gw, k) if k else None
            elif ch == ' ':
                chs[i] = None

    def single(self, painter, i, ch, col, grid, heat):
        if not is_marker(ch):
            return ch, col
        k = self.pattern(painter, i, grid, heat)
        return (self.tile(i // painter.gw, k) if k else None), col


class Braille(_Sampled):
    id = 'braille'
    extra = ''.join(mark(BRAILLE, p * 16 + k) for p in (0, 1) for k in range(1, 16))

    def tile(self, y, k):
        return mark(BRAILLE, (y & 1) * 16 + k)

    def draw(self, c, cell, font_path):
        n = code(c) - BRAILLE
        if 0 < n < 32 and n % 16:
            return braille_tile(cell, n // 16, n % 16)
        return super().draw(c, cell, font_path)


class Dither(_Sampled):
    id = 'dither'
    extra = ''.join(mark(QUAD, k) for k in range(1, 16))

    def tile(self, y, k):
        return mark(QUAD, k)

    def draw(self, c, cell, font_path):
        n = code(c) - QUAD
        if 0 < n < 16:
            return quad_tile(cell, n)
        return super().draw(c, cell, font_path)


class Bricks(GlyphSet):
    id = 'bricks'
    ramp = markers(4)
    procedural = True
    extra = ''.join(mark(BRICK, k) for k in range(1, 5))

    def draw(self, c, cell, font_path):
        n = code(c) - BRICK
        if 0 < n < 5:
            return brick_tile(cell, n)
        return super().draw(c, cell, font_path)

    def arrange(self, painter, chs, cols, grid, heat):
        for i, ch in enumerate(chs):
            if is_marker(ch):
                chs[i] = mark(BRICK, code(ch) - LEVEL)
            elif ch == ' ':
                chs[i] = None

    def single(self, painter, i, ch, col, grid, heat):
        return (mark(BRICK, code(ch) - LEVEL) if is_marker(ch) else ch), col

    def offset(self, y, cell):
        return cell // 2 if y & 1 else 0

    def placed(self, painter, frame):
        S = painter.cell
        half = S // 2
        if half == 0:
            return frame
        W, H = frame.size
        out = frame.copy()
        for j in range(1, painter.gh, 2):
            top = j * S
            if top >= H:
                break
            strip = frame.crop((0, top, W, min(H, top + S)))
            out.paste(strip, (half - S, top))
            out.paste(strip, (half, top))
        return out


class Particle(GlyphSet):
    id = 'particle'
    ramp = LEVELS
    procedural = True
    extra = ''.join(mark(DOT, s * 9 + j) for s in range(3) for j in range(9))

    def draw(self, c, cell, font_path):
        n = code(c) - DOT
        if 0 <= n < 27:
            return dot_tile(cell, n // 9, n % 9)
        return super().draw(c, cell, font_path)

    def bind(self, painter):
        rng = random.Random(self.look.seed * 7919 + 17)
        self.rand = [(rng.random(), rng.random(), rng.random()) for _ in range(painter.gw * painter.gh)]
        self.density = 0.45 + 1.1 * self.look.effect

    def choose(self, i: int, t: float):
        if t <= 0.02:
            return None
        a, b, c = self.rand[i]
        if a >= min(1.0, t * self.density):
            return None
        s = min(2, int(t * 2.4 + b * 0.7))
        return mark(DOT, s * 9 + int(c * 9))

    def arrange(self, painter, chs, cols, grid, heat):
        lv, L, m = painter.level, grid.L, grid.m
        for i, ch in enumerate(chs):
            if is_marker(ch):
                chs[i] = self.choose(i, lv(L[i], m[i], heat))
            elif ch == ' ':
                chs[i] = None

    def single(self, painter, i, ch, col, grid, heat):
        if not is_marker(ch):
            return ch, col
        return self.choose(i, painter.level(grid.L[i], grid.m[i], heat)), col


class Drift(GlyphSet):
    id = 'drift'
    ramp = LEVELS
    procedural = True
    extra = ''.join(mark(STREAK, a * 8 + k) for a in (0, 1) for k in range(1, 5)) + mark(DOT, 4) + mark(DOT, 13)

    def draw(self, c, cell, font_path):
        n = code(c)
        if STREAK < n < STREAK + 16 and n % 8:
            return streak_tile(cell, (n - STREAK) // 8, n % 8)
        if DOT <= n < DOT + 27:
            return dot_tile(cell, (n - DOT) // 9, (n - DOT) % 9)
        return super().draw(c, cell, font_path)

    def head(self, t: float) -> str:
        axis = 1 if self.look.direction in ('down', 'up') else 0
        return mark(STREAK, axis * 8 + 1 + min(3, int(t * 4)))

    def bind(self, painter):
        gw, gh = painter.gw, painter.gh
        direction = self.look.direction
        if direction in ('down', 'up'):
            lines = [list(range(x, gw * gh, gw)) for x in range(gw)]
        else:
            lines = [list(range(y * gw, y * gw + gw)) for y in range(gh)]
        if direction in ('left', 'up'):
            lines = [line[::-1] for line in lines]
        self.lines = lines
        self.decay = 0.8 + 0.17 * self.look.effect

    def arrange(self, painter, chs, cols, grid, heat):
        lv, L, m = painter.level, grid.L, grid.m
        bg = painter.bg
        decay = self.decay
        small, large = mark(DOT, 4), mark(DOT, 13)
        for line in self.lines:
            trail = top = 0.0
            tcol = None
            for i in line:
                ch = chs[i]
                marker = is_marker(ch)
                t = lv(L[i], m[i], heat) if marker else 0.0
                if t > 0.05 and t >= trail:
                    chs[i] = self.head(t)
                    trail = top = t
                    tcol = cols[i]
                elif trail > 0.1:
                    chs[i] = large if trail > 0.45 else small
                    cols[i] = core.rgb(core.mix(bg, tcol, 0.15 + 0.85 * trail / top))
                elif marker or ch == ' ':
                    chs[i] = None
                trail *= decay

    def single(self, painter, i, ch, col, grid, heat):
        if not is_marker(ch):
            return ch, col
        t = painter.level(grid.L[i], grid.m[i], heat)
        return (self.head(t) if t > 0.05 else None), col


class Film(GlyphSet):
    id = 'film'
    ramp = FILM
    calibrate = True
    procedural = True

    def bind(self, painter):
        self.assets = {}
        chars = self.look.chars
        self.at = {c: k for k, c in enumerate(chars)}
        rng = random.Random(self.look.seed * 31337 + 5)
        self.shift = [rng.choice((-1, 0, 0, 1)) for _ in range(painter.gw * painter.gh)]

    def vary(self, i: int, ch):
        k = self.at.get(ch)
        if not k:
            return ch
        chars = self.look.chars
        return chars[max(1, min(len(chars) - 1, k + self.shift[i]))]

    def arrange(self, painter, chs, cols, grid, heat):
        for i, ch in enumerate(chs):
            chs[i] = self.vary(i, ch)

    def single(self, painter, i, ch, col, grid, heat):
        return self.vary(i, ch), col

    def _assets(self, painter, size):
        found = self.assets.get(size)
        if found:
            return found
        e = self.look.effect
        light = self.look.light
        lut = []
        for ch in range(3):
            for x in range(256):
                t = x / 255
                if light:
                    fade = (1 - t) ** 2 * e
                    y = x + (30, 24, 16)[ch] * fade
                else:
                    shadows = max(0.0, 1 - t / 0.45) ** 2 * min(1.0, t / 0.06)
                    highs = max(0.0, (t - 0.5) / 0.5) ** 1.5
                    y = x + (-10, 3, 9)[ch] * shadows * e + (14, 3, -16)[ch] * highs * e
                lut.append(max(0, min(255, int(round(y)))))
        w, h = size
        small = Image.new('L', (64, 36))
        corner = 0.28 * e if not light else 0.12 * e
        small.putdata([max(0, min(255, int(round(255 * (1 - corner * min(1.0, (((x + 0.5) / 32 - 1) ** 2 + ((y + 0.5) / 18 - 1) ** 2) / 2) ** 1.4 * 2)))))
                       for y in range(36) for x in range(64)])
        vig = small.resize((w, h), Image.Resampling.BICUBIC)
        if light:
            vignette = Image.merge('RGB', [vig.point(lambda v, f=f: max(0, int(round(255 - (255 - v) * f)))) for f in (1.0, 1.3, 1.8)])
        else:
            vignette = Image.merge('RGB', (vig, vig, vig))
        rng = random.Random(self.look.seed * 104729 + 3)
        amp = 5 + 9 * e
        tile = Image.new('L', (128, 128))
        tile.putdata([max(0, min(255, int(round(128 + rng.gauss(0, amp))))) for _ in range(128 * 128)])
        tile = tile.resize((256, 256), Image.Resampling.BILINEAR)
        grain = Image.new('L', size)
        for gy in range(0, h, 256):
            for gx in range(0, w, 256):
                grain.paste(tile, (gx, gy))
        found = {'lut': lut, 'vignette': vignette, 'grain': Image.merge('RGB', (grain, grain, grain))}
        self.assets[size] = found
        return found

    def finish(self, painter, frame, index=0):
        A = self._assets(painter, frame.size)
        e = self.look.effect
        out = frame.point(A['lut'])
        lum = out.convert('L')
        if not self.look.light and e > 0:
            hi = lum.point(lambda v: 0 if v < 135 else min(255, (v - 135) * 3))
            w, h = out.size
            small = hi.resize((max(1, w // 4), max(1, h // 4)), Image.Resampling.BOX)
            small = small.filter(ImageFilter.GaussianBlur(max(1.0, painter.cell * 0.45)))
            glow = small.resize((w, h), Image.Resampling.BILINEAR)
            k = 0.45 + 0.65 * e
            halo = Image.merge('RGB', (glow.point(lambda v: int(v * k)), glow.point(lambda v: int(v * k * 0.32)),
                                      glow.point(lambda v: int(v * k * 0.1))))
            out = ImageChops.screen(out, halo)
        out = ImageChops.multiply(out, A['vignette'])
        if e > 0:
            if self.look.light:
                ink = lum.point(lambda v: 0 if v > 225 else min(255, (225 - v) * 3))
            else:
                ink = lum.point(lambda v: 0 if v < 24 else min(255, (v - 24) * 3))
            out = Image.composite(ImageChops.add(out, A['grain'], 1.0, -128), out, ink)
        return out


SETS = {cls.id: cls for cls in (Detailed, Sparse, Tiles, Braille, Dither, Bricks, Particle, Drift, Film)}
