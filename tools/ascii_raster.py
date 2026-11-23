from __future__ import annotations

import os
import shutil
import subprocess
from functools import lru_cache

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

import ascii_core as core
import ascii_glyphs as glyphs

MESH_LEVELS = 16
FONT_FALLBACKS = (
    '/usr/share/fonts/noto/NotoSansMono-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSansMono-Bold.ttf',
    '/usr/share/fonts/liberation/LiberationMono-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf',
)


class RenderError(Exception):
    pass


def find_font(setting: str, chars: str) -> str:
    setting = (setting or '').strip()
    if setting and os.path.isfile(setting):
        return setting
    needed = ' '.join(f'{ord(c):x}' for c in sorted(set(chars)) if not c.isspace() and not glyphs.is_private(c))
    patterns = []
    if setting:
        patterns += [f'{setting}:bold:charset={needed}', f'{setting}:charset={needed}']
    patterns += [f'monospace:bold:charset={needed}', 'monospace:bold']
    fc = shutil.which('fc-match')
    if fc:
        for pattern in patterns:
            try:
                out = subprocess.run([fc, '-f', '%{file}', pattern], capture_output=True, text=True, timeout=10)
            except (OSError, subprocess.SubprocessError):
                break
            path = out.stdout.strip()
            if out.returncode == 0 and path and os.path.isfile(path):
                return path
    for path in FONT_FALLBACKS:
        if os.path.isfile(path):
            return path
    raise RenderError('No monospace font was found. Install DejaVu Sans Mono or Noto Sans Mono, or set ASCII Glyphscape > Font.')


class Atlas:
    def __init__(self, font_path: str, cell: int, chars: str, drawer=None):
        self.cell = cell
        self.font_path = font_path
        self.drawer = drawer
        size = max(3.0, cell * 1.25)
        try:
            self.font = ImageFont.truetype(font_path, size)
        except OSError as error:
            raise RenderError(f'The font {font_path} could not be loaded: {error}') from error
        unique = []
        for c in chars:
            if c not in unique:
                unique.append(c)
        self.chars = unique
        drawn = {}
        if drawer is not None:
            for c in unique:
                if not c.isspace():
                    tile = drawer(c, cell, font_path)
                    if tile is not None:
                        drawn[c] = tile
        top, bottom = 0, 0
        first = True
        for c in unique:
            if c.isspace() or c in drawn:
                continue
            box = self.font.getbbox(c, anchor='ls')
            if box[2] <= box[0] or box[3] <= box[1]:
                continue
            if first:
                top, bottom, first = box[1], box[3], False
            else:
                top, bottom = min(top, box[1]), max(bottom, box[3])
        self.baseline = (cell - (bottom - top)) / 2 - top if not first else cell * 0.8
        self.tiles: dict[str, Image.Image] = {}
        self.empty: set[str] = set()
        for c in unique:
            tile = drawn[c] if c in drawn else self._draw(c)
            if tile.getbbox() is None:
                self.empty.add(c)
            self.tiles[c] = tile
        self.index = {' ': 0}
        self.order: list[Image.Image | None] = [None]
        for c in unique:
            if c in self.index:
                continue
            if c in self.empty:
                self.index[c] = 0
                continue
            self.index[c] = len(self.order)
            self.order.append(self.tiles[c])
        if len(self.order) > 255:
            raise RenderError('A character set may hold at most 254 different characters.')

    def _draw(self, c: str) -> Image.Image:
        cell = self.cell
        tile = Image.new('L', (cell, cell), 0)
        if c.isspace():
            return tile
        if self.drawer is not None:
            own = self.drawer(c, cell, self.font_path)
            if own is not None:
                return own
        if 0x2580 <= ord(c) <= 0x259F:
            return block_tile(c, cell, self.font)
        advance = self.font.getlength(c)
        ImageDraw.Draw(tile).text(((cell - advance) / 2, self.baseline), c, fill=255, font=self.font, anchor='ls')
        return tile

    def tile(self, c: str) -> Image.Image | None:
        if c.isspace():
            return None
        t = self.tiles.get(c)
        if t is None:
            t = self._draw(c)
            self.tiles[c] = t
        return t


SHADES = {'\u2591': 0.25, '\u2592': 0.5, '\u2593': 0.75, '\u2588': 1.0}


def block_tile(c: str, cell: int, font) -> Image.Image:
    gap = 1 if cell >= 5 else 0
    inner = cell - gap
    tile = Image.new('L', (cell, cell), 0)
    if c in SHADES:
        level = SHADES[c]
        unit = max(1, round(cell / 6))
        order = ((0, 0), (1, 1), (1, 0), (0, 1))
        lit = {order[i] for i in range(int(round(level * 4)))}
        px = tile.load()
        for y in range(inner):
            for x in range(inner):
                if ((x // unit) % 2, (y // unit) % 2) in lit:
                    px[x, y] = 255
        return tile
    full = font.getbbox('\u2588', anchor='ls')
    w, h = max(1, full[2] - full[0]), max(1, full[3] - full[1])
    big = Image.new('L', (w, h), 0)
    ImageDraw.Draw(big).text((-full[0], -full[1]), c, fill=255, font=font, anchor='ls')
    tile.paste(big.resize((inner, inner), Image.Resampling.BOX), (0, 0))
    return tile


@lru_cache(maxsize=8)
def mesh_tiles(cell: int) -> tuple[Image.Image, ...]:
    tiles = []
    up = 4
    for q in range(MESH_LEVELS):
        size = q / (MESH_LEVELS - 1)
        rr = (0.25 + 0.75 * size) * cell * 0.55 * up
        big = Image.new('L', (cell * up, cell * up), 0)
        c = cell * up / 2
        ImageDraw.Draw(big).polygon([(c, c - rr), (c + rr, c), (c, c + rr), (c - rr, c)], fill=255)
        tiles.append(big.resize((cell, cell), Image.Resampling.LANCZOS))
    return tuple(tiles)


def mesh_index(size: float) -> int:
    q = int(round(max(0.0, min(1.0, size)) * (MESH_LEVELS - 1)))
    return q + 1


class TileCache:
    def __init__(self, width: int, height: int, cell: int, limit: int = 24):
        self.width, self.height, self.cell, self.limit = width, height, cell, limit
        self.cache: dict[int, Image.Image] = {}

    def get(self, key: int, tile: Image.Image) -> Image.Image:
        found = self.cache.get(key)
        if found is not None:
            return found
        cell = self.cell
        cols = self.width // cell
        strip = Image.new('L', (self.width, cell), 0)
        for i in range(cols):
            strip.paste(tile, (i * cell, 0))
        full = Image.new('L', (self.width, self.height), 0)
        for j in range(self.height // cell):
            full.paste(strip, (0, j * cell))
        if len(self.cache) < self.limit:
            self.cache[key] = full
        return full


def compose(idx: Image.Image, colors: Image.Image, tiles, bg, cell: int, size, cache: TileCache) -> Image.Image:
    gw, gh = idx.size
    full = (gw * cell, gh * cell)
    alpha = Image.new('L', full, 0)
    hist = idx.histogram()
    for k in range(1, min(len(tiles), 256)):
        if hist[k] == 0 or tiles[k] is None:
            continue
        lut = [0] * 256
        lut[k] = 255
        where = idx.point(lut).resize(full, Image.Resampling.NEAREST)
        layer = ImageChops.multiply(where, cache.get(k, tiles[k]))
        alpha = ImageChops.lighter(alpha, layer)
    out = Image.new('RGB', full, tuple(bg))
    out.paste(colors.resize(full, Image.Resampling.NEAREST), (0, 0), alpha)
    if full != tuple(size):
        out = out.crop((0, 0, size[0], size[1]))
    return out


def fit_source(image: Image.Image, gw: int, gh: int, fit: str = 'cover', position: str = 'center') -> Image.Image:
    image = image.convert('RGB')
    iw, ih = image.size
    if fit == 'contain':
        k = min(gw / iw, gh / ih)
        w, h = max(1, round(iw * k)), max(1, round(ih * k))
        scaled = image.resize((w, h), Image.Resampling.LANCZOS, reducing_gap=2.0)
        canvas = Image.new('RGB', (gw, gh), image.getpixel((0, 0)))
        x, y = _anchor(gw - w, gh - h, position)
        canvas.paste(scaled, (x, y))
        return canvas
    k = max(gw / iw, gh / ih)
    w, h = max(gw, round(iw * k)), max(gh, round(ih * k))
    scaled = image.resize((w, h), Image.Resampling.LANCZOS, reducing_gap=2.0)
    x, y = _anchor(w - gw, h - gh, position)
    return scaled.crop((x, y, x + gw, y + gh))


def _anchor(free_x: int, free_y: int, position: str) -> tuple[int, int]:
    x = free_x // 2
    y = free_y // 2
    if position == 'top':
        y = 0
    elif position == 'bottom':
        y = free_y
    elif position == 'left':
        x = 0
    elif position == 'right':
        x = free_x
    return x, y


class Painter:
    def __init__(self, look: core.Look, cell: int, size, bg, font_path: str, glitch: bool = True):
        self.look = look
        self.cell = cell
        self.size = (int(size[0]), int(size[1]))
        self.gw = -(-self.size[0] // cell)
        self.gh = -(-self.size[1] // cell)
        look.gw, look.gh = self.gw, self.gh
        self.bg = tuple(bg)
        self.mesh = look.style == 'mesh'
        self.glitch = glitch
        self.set = glyphs.GlyphSet(look) if self.mesh else glyphs.for_look(look)
        self.procedural = self.set.procedural
        self.subgrid = self.set.subgrid
        self.sample_size = (self.gw * 2, self.gh * 2) if self.subgrid else (self.gw, self.gh)
        self.level = glyphs.level_fn(look)
        if self.mesh:
            self.atlas = None
            self.tiles = (None,) + mesh_tiles(cell)
        else:
            if self.set.calibrate:
                look.chars = calibrated(look.chars, font_path, self.set.id)
            self.atlas = Atlas(font_path, cell, look.chars + core.GLITCH + '.' + self.set.extra, drawer=self.set.draw)
            self.tiles = tuple(self.atlas.order)
        self.cache = TileCache(self.gw * cell, self.gh * cell, cell)
        self.set.bind(self)

    def base(self, grid: core.Grid, heat: float = 0.0) -> Image.Image:
        look = self.look
        gw = self.gw
        style = core.cell_style
        idx = bytearray(gw * self.gh)
        col = bytearray(gw * self.gh * 3)
        r, g, b, L, m, n = grid.r, grid.g, grid.b, grid.L, grid.m, grid.n
        index = self.atlas.index if self.atlas else None
        mesh = self.mesh
        if self.procedural:
            count = gw * self.gh
            chs = [None] * count
            cols = [None] * count
            for i in range(count):
                ch, c, _ = style(look, i % gw, i // gw, r[i], g[i], b[i], L[i], m[i], n[i], heat)
                chs[i] = ch
                cols[i] = c
            self.set.arrange(self, chs, cols, grid, heat)
            for i in range(count):
                ch = chs[i]
                idx[i] = index.get(ch, 0) if ch else 0
                c = cols[i]
                j = i * 3
                col[j] = c[0]
                col[j + 1] = c[1]
                col[j + 2] = c[2]
        else:
            for i in range(gw * self.gh):
                x = i % gw
                y = i // gw
                ch, c, size = style(look, x, y, r[i], g[i], b[i], L[i], m[i], n[i], heat)
                if mesh:
                    idx[i] = mesh_index(size)
                else:
                    idx[i] = index.get(ch, 0) if ch is not None else 0
                j = i * 3
                col[j] = c[0]
                col[j + 1] = c[1]
                col[j + 2] = c[2]
        idx_img = Image.frombytes('L', (gw, self.gh), bytes(idx))
        col_img = Image.frombytes('RGB', (gw, self.gh), bytes(col))
        frame = compose(idx_img, col_img, self.tiles, self.bg, self.cell, self.size, self.cache)
        frame = self.set.placed(self, frame)
        if self.mesh and look.mask and not look.light:
            glow = frame.filter(ImageFilter.GaussianBlur(max(1, 6 * self.cell / 4)))
            frame = Image.blend(frame, glow, 0.3)
        return frame

    def finish(self, frame: Image.Image, index: int = 0) -> Image.Image:
        return self.set.finish(self, frame, index)

    def hot(self, frame: Image.Image, grid: core.Grid, cells, rng) -> None:
        look = self.look
        S = self.cell
        gw = self.gw
        draw = ImageDraw.Draw(frame)
        bg = self.bg
        r, g, b, L, m, n = grid.r, grid.g, grid.b, grid.L, grid.m, grid.n
        for i, h, jx, jy in cells:
            x = i % gw
            y = i // gw
            ch, c, size = core.cell_style(look, x, y, r[i], g[i], b[i], L[i], m[i], n[i], h)
            px, py = x * S, y * S
            if self.mesh:
                rr = (0.25 + 0.75 * size) * S * 0.55 * (1 + h * 0.6)
                cx, cy = px + S / 2 + jx, py + S / 2 + jy
                draw.polygon([(cx, cy - rr), (cx + rr, cy), (cx, cy + rr), (cx - rr, cy)], fill=c)
                continue
            px += self.set.offset(y, S)
            draw.rectangle((px, py, px + S - 1, py + S - 1), fill=bg)
            if self.procedural:
                ch, c = self.set.single(self, i, ch, c, grid, h)
            if ch == ' ' or ch is None:
                continue
            if self.glitch and h > 0.25 and rng.random() < h * 0.6:
                ch = core.GLITCH[int(rng.random() * len(core.GLITCH))]
            tile = self.atlas.tile(ch)
            if tile is None:
                continue
            ox, oy = int(round(px + jx)), int(round(py + jy))
            frame.paste(c, (ox, oy, ox + S, oy + S), tile)


@lru_cache(maxsize=1)
def _dither_tile() -> Image.Image:
    import random
    rng = random.Random(1729)
    tile = Image.new('L', (256, 256))
    tile.putdata([max(0, min(255, int(round(128 + rng.gauss(0, 1.2))))) for _ in range(256 * 256)])
    return tile


class Shade:
    def __init__(self, size, light: bool, strength: float):
        self.active = strength > 0
        if not self.active:
            return
        w, h = size
        top, bottom = (0.7, 0.6) if light else (0.5, 0.5)
        column = Image.new('L', (1, h))
        values = []
        for y in range(h):
            t = (y + 0.5) / h
            if t < 0.2:
                a = top * (1 - t / 0.2)
            elif t > 0.82:
                a = bottom * ((t - 0.82) / 0.18)
            else:
                a = 0.0
            values.append(max(0, min(255, int(round(a * min(1.0, strength) * 255)))))
        column.putdata(values)
        mask = column.resize((w, h), Image.Resampling.NEAREST)
        noise = Image.new('L', (w, h))
        tile = _dither_tile()
        for ty in range(0, h, tile.height):
            for tx in range(0, w, tile.width):
                noise.paste(tile, (tx, ty))
        dithered = ImageChops.add(mask, noise, 1.0, -128)
        rows = column.point(lambda v: 255 if v > 0 else 0).resize((w, h), Image.Resampling.NEAREST)
        self.mask = Image.composite(dithered, mask, rows)
        self.tone = Image.new('RGB', (w, h), (255, 255, 255) if light else (0, 0, 0))

    def apply(self, frame: Image.Image) -> Image.Image:
        if not self.active:
            return frame
        return Image.composite(self.tone, frame, self.mask)


@lru_cache(maxsize=32)
def calibrated(ramp: str, font_path: str, set_id: str) -> str:
    unique = []
    for c in ramp:
        if c not in unique:
            unique.append(c)
    probe = glyphs.SETS[set_id](core.Look())
    atlas = Atlas(font_path, 32, ''.join(unique), drawer=probe.draw)

    def ink(c):
        tile = atlas.tiles.get(c)
        return 0 if tile is None or c.isspace() else sum(i * k for i, k in enumerate(tile.histogram()))
    return ''.join(sorted(unique, key=ink))


def sub_levels(image: Image.Image, sat: float, contrast: float, bright: float) -> list:
    if sat != 1:
        image = Image.blend(image.convert('L').convert('RGB'), image, sat)
    lut = [max(0, min(255, int(round(((v - 128) * contrast + 128) * bright)))) for v in range(256)]
    return [v / 255 for v in pixels(image.point(lut * 3).convert('L'))]


def grid_for(fitted: Image.Image, painter: 'Painter', adjust: dict, noise, reference=None) -> core.Grid:
    a = adjust
    small = fitted.resize((painter.gw, painter.gh), Image.Resampling.BOX) if painter.subgrid else fitted
    grid = core.build_grid(pixels(small), painter.gw, painter.gh, sat=a['sat'], contrast=a['contrast'],
                           bright=a['bright'], mask=a['mask'], threshold=a['threshold'], softness=a['softness'],
                           noise=noise, reference=reference)
    if painter.subgrid:
        grid.sub = sub_levels(fitted, a['sat'], a['contrast'], a['bright'])
    return grid


def pixels(image: Image.Image) -> list:
    flat = getattr(image, 'get_flattened_data', None)
    return list(flat() if flat else image.getdata())
