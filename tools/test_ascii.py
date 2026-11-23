from __future__ import annotations

import io
import itertools
import json
import os
import random
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from PIL import Image, ImageChops

import ascii_anim as anim
import ascii_cli as cli
import ascii_core as core
import ascii_encode as enc
import ascii_glyphs as glyphs
import ascii_preview as preview
import ascii_raster as ras
import ascii_theme as theme

SAMPLE = os.path.join(ROOT, 'assets', 'samples', 'sample.jpg')
HAVE_FFMPEG = bool(enc.find_ffmpeg() and enc.ffmpeg_has_x264(enc.find_ffmpeg()))


class GoldenPort(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(HERE, 'golden', 'cellstyle.json'), encoding='utf-8') as fh:
            cls.data = json.load(fh)

    def test_charsets_match_the_page(self):
        self.assertEqual(self.data['charsets'], core.CHARSETS)

    def test_cell_style(self):
        for case in self.data['cases']:
            cfg, cell = case['cfg'], case['cell']
            look = core.Look(style=cfg['style'], mode=cfg['mode'], mask=cfg['mask'],
                             chars=self.data['charsets'][cfg['charset']], noise=cfg['noise'],
                             gw=case['gw'], gh=case['gh'])
            ch, col, size = core.cell_style(look, cell['x'], cell['y'], cell['r'], cell['g'], cell['b'],
                                            cell['L'], cell['m'], cell['n'], case['h'])
            with self.subTest(cfg=cfg, h=case['h']):
                self.assertEqual(ch, case['ch'])
                self.assertEqual(list(col), case['col'])
                if case['size'] is None:
                    self.assertIsNone(size)
                else:
                    self.assertAlmostEqual(size, case['size'], places=9)

    def test_adjust(self):
        for case in self.data['adjusts']:
            cfg, px, out = case['cfg'], case['px'], case['out']
            got = core.adjust(px[0], px[1], px[2], case['bc'], cfg['sat'], cfg['contrast'], cfg['bright'], cfg['mask'])
            for value, key in zip(got, 'rgbLm'):
                self.assertAlmostEqual(value, out[key], places=9)

    def test_build_grid_matches_adjust(self):
        pixels = [(10, 20, 30), (200, 100, 50), (255, 255, 255), (0, 0, 0)]
        grid = core.build_grid(pixels, 2, 2, sat=1.3, contrast=1.2, bright=1.1, mask=True, threshold=0.12,
                               softness=0.18, noise=[0, 0, 0, 0])
        for i, p in enumerate(pixels):
            r, g, b, L, m = core.adjust(*p, pixels[0], 1.3, 1.2, 1.1, True)
            self.assertAlmostEqual(grid.r[i], r)
            self.assertAlmostEqual(grid.L[i], L)
            self.assertAlmostEqual(grid.m[i], m)

    def test_overrides_are_off_by_default(self):
        look = core.Look(style='blue', mode='dark')
        self.assertIsNone(look.accent)
        self.assertEqual(look.hot, core.ACC_D)
        look = core.Look(style='real', mode='light', ink=(255, 0, 0), ink_strength=1)
        _, col, _ = core.cell_style(look, 0, 0, 200, 200, 200, 0.8, 1, 0, 0)
        self.assertGreater(col[0], col[1])


class Raster(unittest.TestCase):
    def setUp(self):
        self.font = ras.find_font('', core.CHARSETS['ascii'] + core.CHARSETS['blocks'] + core.CHARSETS['dots'] + core.GLITCH)

    def test_every_charset_glyph_is_drawn(self):
        for name, chars in core.CHARSETS.items():
            atlas = ras.Atlas(self.font, 10, chars + core.GLITCH)
            for c in chars[1:]:
                with self.subTest(charset=name, char=c):
                    self.assertIsNotNone(atlas.tiles[c].getbbox())
            self.assertEqual(atlas.index[' '], 0)

    def test_block_elements_keep_the_character_grid(self):
        atlas = ras.Atlas(self.font, 12, core.CHARSETS['blocks'])
        self.assertEqual(atlas.tiles['\u2588'].getbbox(), (0, 0, 11, 11), 'a gutter separates cells')
        cover = [sum(ras.pixels(atlas.tiles[c])) / (255 * 121) for c in core.CHARSETS['blocks'][1:]]
        for got, want in zip(cover, (0.25, 0.5, 0.75, 1.0)):
            self.assertAlmostEqual(got, want, delta=0.06)
        tiny = ras.Atlas(self.font, 4, core.CHARSETS['blocks'])
        self.assertEqual(tiny.tiles['\u2588'].getbbox(), (0, 0, 4, 4), 'no gutter in tiny cells')

    def test_layers_equal_cell_by_cell_drawing(self):
        for style in ('real', 'mesh'):
            look = core.Look(style=style, mode='dark', chars=core.CHARSETS['ascii'])
            bg = core.background(style, 'dark')
            painter = ras.Painter(look, 8, (96, 64), bg, self.font)
            img = Image.open(SAMPLE)
            grid = core.build_grid(ras.pixels(ras.fit_source(img, painter.gw, painter.gh)), painter.gw, painter.gh,
                                   sat=1.25, contrast=1.1, bright=1.25, mask=False, threshold=0.12, softness=0.18,
                                   noise=core.noise_field(painter.gw * painter.gh, 3))
            fast = painter.base(grid)
            slow = Image.new('RGB', (painter.gw * 8, painter.gh * 8), bg)
            for i in range(painter.gw * painter.gh):
                x, y = i % painter.gw, i // painter.gw
                ch, col, size = core.cell_style(look, x, y, grid.r[i], grid.g[i], grid.b[i], grid.L[i], grid.m[i], grid.n[i], 0)
                tile = painter.tiles[ras.mesh_index(size)] if style == 'mesh' else (
                    painter.tiles[painter.atlas.index.get(ch, 0)] if ch else None)
                if tile is not None:
                    slow.paste(col, (x * 8, y * 8, x * 8 + 8, y * 8 + 8), tile)
            slow = slow.crop((0, 0, 96, 64))
            with self.subTest(style=style):
                self.assertEqual(ras.pixels(fast), ras.pixels(slow))

    def test_fit_source_cover_and_contain(self):
        img = Image.new('RGB', (400, 100), (255, 0, 0))
        self.assertEqual(ras.fit_source(img, 40, 30).size, (40, 30))
        self.assertEqual(ras.fit_source(img, 40, 30, 'contain').size, (40, 30))

    def test_shade_darkens_edges_only(self):
        frame = Image.new('RGB', (200, 100), (200, 200, 200))
        out = ras.Shade((200, 100), False, 1.0).apply(frame)
        self.assertLess(out.getpixel((100, 0))[0], 120)
        self.assertEqual(out.getpixel((100, 50)), (200, 200, 200))
        self.assertIs(ras.Shade((200, 100), False, 0).apply(frame), frame)


class Encode(unittest.TestCase):
    def test_still_sizes(self):
        self.assertEqual(enc.clamp_still_size(7680, 4320), (4096, 2304))
        self.assertEqual(enc.clamp_still_size(320, 180), (640, 360))
        w, h = enc.video_size(3840, 2160)
        self.assertLessEqual(w * h, enc.VIDEO_MAX_PIXELS)
        self.assertEqual((w % 2, h % 2), (0, 0))
        self.assertAlmostEqual(w / h, 16 / 9, places=2)

    def test_still_fits_budget_or_reports(self):
        img = Image.effect_noise((900, 600), 90).convert('RGB')
        data, q = enc.encode_still(img, 'high', budget=200_000)
        if data is None:
            self.assertGreater(q, 200_000)
            smaller = enc.next_size((900, 600), q, budget=200_000)
            self.assertTrue(smaller is None or smaller[0] < 900)
        else:
            self.assertLessEqual(len(data), 200_000)
        flat = Image.new('RGB', (1000, 600), (10, 20, 30))
        data, q = enc.encode_still(flat)
        self.assertEqual(q, 100, 'a flat picture stays lossless')
        self.assertEqual(Image.open(io.BytesIO(data)).format, 'WEBP')


class Motion(unittest.TestCase):
    def make(self, kind, **kw):
        return anim.Motion(kind, gw=80, gh=45, cell=8, width=640, height=360, fps=20, frames=60, **kw)

    def test_loops_seamlessly(self):
        for kind in ('hover', 'ripple', 'scan', 'glitch'):
            m = self.make(kind)
            frames = list(m.frames())
            self.assertEqual(len(frames), 60)
            again = list(m.frames())
            first = dict((i, h) for i, h, _, _ in frames[0][1])
            later = dict((i, h) for i, h, _, _ in again[0][1])
            keys = set(first) | set(later)
            diff = max((abs(first.get(k, 0) - later.get(k, 0)) for k in keys), default=0)
            with self.subTest(kind=kind):
                self.assertLess(diff, 0.03)
                self.assertTrue(any(f[1] for f in frames), 'something moves')

    def test_breathe_and_off(self):
        frames = list(self.make('breathe', intensity=1).frames())
        self.assertEqual(frames[0], ('uniform', 0.0))
        self.assertGreater(max(v for _, v in frames), 0.2)
        self.assertTrue(all(v == 0 for _, v in self.make('off').frames()))

    def test_hover_pushes_cells_away_from_cursor(self):
        m = self.make('hover')
        cells = list(m.frames())[10][1]
        self.assertTrue(any(dx or dy for _, _, dx, dy in cells))
        self.assertTrue(all(0 < h <= 1 for _, h, _, _ in cells))


class Theme(unittest.TestCase):
    def test_tokens_pass_orca_rules_everywhere(self):
        accents = [None, (255, 255, 0), (0, 0, 0), (255, 255, 255), (128, 128, 128)]
        means = [(30, 30, 30), (240, 240, 240), (40, 90, 220)]
        for style, mode, acc, mean, tone, tint in itertools.product(core.STYLES, core.MODES, accents, means,
                                                                     ('match', 'deep', 'contrast'), (0, 0.35)):
            accent = acc or (core.ACC_L if mode == 'light' else core.ACC_D)
            p = theme.ui_palette(mode, core.BGS[style][mode], accent, mean, tone, tint)
            tokens = theme.tokens_for(p)
            with self.subTest(style=style, mode=mode, acc=acc, mean=mean, tone=tone, tint=tint):
                self.assertEqual(theme.validate(tokens), [])
                self.assertEqual(theme.validate_terminal(theme.terminal_for(p, mode)), [])
                self.assertTrue(set(tokens) <= theme.PUBLIC_TOKENS)

    def test_validator_catches_what_orca_drops(self):
        good = {'--background': '#101010', '--foreground': '#f0f0f0'}
        self.assertEqual(theme.validate(good), [])
        self.assertTrue(theme.validate({**good, '--sidebar': '#10101080', '--sidebar-foreground': '#ffffff'}))
        self.assertTrue(theme.validate({**good, '--foreground': '#202020'}))
        self.assertTrue(theme.validate({**good, '--sidebar-blur': '#000000'}))
        self.assertTrue(theme.validate({**good, '--card': 'color-mix(in srgb, red, blue)'}))

    def test_document_shape(self):
        p = theme.ui_palette('dark', core.BGS['real']['dark'], core.ACC_D, (90, 100, 110))
        doc = theme.theme_document('dark', theme.tokens_for(p), 'images/a.webp', 'images/a.mp4', 0.8, 'cover')
        self.assertEqual(set(doc), {'schemaVersion', 'base', 'tokens', 'background'})
        self.assertEqual(doc['background'], {'path': 'images/a.webp', 'videoPath': 'images/a.mp4', 'opacity': 0.8,
                                             'size': 'cover', 'position': 'center'})
        self.assertLess(len(theme.dumps(doc).encode()), theme.THEME_MAX_BYTES)


class Config(unittest.TestCase):
    def test_normalize_clamps_and_defaults(self):
        cfg = cli.normalize({'style': 'nope', 'cell': 999, 'fps': 2.4, 'mask': 'yes', 'charset': 'custom',
                             'customCharset': ' .o\nO@', 'saturation': float('nan')})
        self.assertEqual(cfg['style'], 'real')
        self.assertEqual(cfg['cell'], 48)
        self.assertEqual(cfg['fps'], 10)
        self.assertFalse(cfg['mask'])
        self.assertEqual(cfg['saturation'], 1.25)
        self.assertEqual(cli.chars_for(cfg), ' .oO@')
        self.assertEqual(cli.chars_for(cli.normalize({'charset': 'custom', 'customCharset': 'x'})), core.CHARSETS['ascii'])


class GlyphSets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.font = ras.find_font('', core.CHARSETS['ascii'] + glyphs.DETAILED + glyphs.FILM + glyphs.TILES + core.GLITCH)
        cls.img = Image.open(SAMPLE).convert('RGB')
        cls.adjust = {'sat': 1.25, 'contrast': 1.1, 'bright': 1.25, 'mask': False, 'threshold': 0.12, 'softness': 0.18}

    def painter(self, charset, style='real', mode='dark', size=(96, 64), cell=8, **look):
        lk = core.Look(style=style, mode=mode, chars=glyphs.ramp_for(charset), charset=charset, **look)
        return ras.Painter(lk, cell, size, core.background(style, mode), self.font)

    def frame(self, p, heat=0.0):
        g = ras.grid_for(ras.fit_source(self.img, *p.sample_size), p, self.adjust, core.noise_field(p.gw * p.gh, 7))
        return p.finish(p.base(g, heat))

    def flat(self, p, L):
        n = p.gw * p.gh
        v = L * 255
        return core.Grid(p.gw, p.gh, [v] * n, [v] * n, [v] * n, [L] * n, [1.0] * n, [0.0] * n,
                         [L] * (4 * n) if p.subgrid else None)

    def test_settings_offer_every_set(self):
        with open(os.path.join(ROOT, 'orca-plugin.json'), encoding='utf-8') as fh:
            settings = {s['key']: s for s in json.load(fh)['contributes']['settings']}
        self.assertEqual(settings['charset']['enum'], list(glyphs.IDS))
        self.assertEqual(settings['driftDirection']['enum'], list(glyphs.DIRECTIONS))
        for charset in glyphs.IDS:
            self.assertEqual(cli.normalize({'charset': charset})['charset'], charset)
        for name in core.CHARSETS:
            self.assertEqual(glyphs.ramp_for(name), core.CHARSETS[name], 'the page sets are untouched')
        self.assertEqual(cli.normalize({'effect': 7})['effect'], 1)
        self.assertEqual(cli.normalize({'driftDirection': 'sideways'})['driftDirection'], 'right')

    def test_every_set_draws_in_every_style_and_mode(self):
        for charset in glyphs.SETS:
            for style in core.STYLES:
                for mode in core.MODES:
                    with self.subTest(charset=charset, style=style, mode=mode):
                        a = self.frame(self.painter(charset, style, mode))
                        b = self.frame(self.painter(charset, style, mode))
                        self.assertEqual(a.size, (96, 64))
                        self.assertEqual(a.tobytes(), b.tobytes(), 'the same settings give the same bytes')
                        self.assertGreater(len(set(ras.pixels(a))), 4, 'something was drawn')

    def test_calibrated_ramps_rise_in_ink(self):
        for charset in ('detailed', 'film', 'tiles'):
            p = self.painter(charset, cell=32)
            ink = [sum(i * k for i, k in enumerate(p.atlas.tiles[c].histogram())) if c != ' ' else 0
                   for c in p.look.chars]
            with self.subTest(charset=charset):
                self.assertEqual(p.look.chars[0], ' ')
                self.assertEqual(ink, sorted(ink))
                self.assertEqual(sorted(p.look.chars), sorted(set(glyphs.ramp_for(charset))))

    def test_sampled_sets_follow_brightness(self):
        for charset in ('braille', 'dither'):
            p = self.painter(charset)
            counts = []
            for L in (0.0, 0.2, 0.4, 0.6, 0.8, 1.0):
                chs = [glyphs.mark(glyphs.LEVEL, 1)] * (p.gw * p.gh)
                p.set.arrange(p, chs, [(0, 0, 0)] * len(chs), self.flat(p, L), 0.0)
                counts.append(sum(bin(glyphs.code(c) % 16).count('1') for c in chs if c))
            with self.subTest(charset=charset):
                self.assertEqual(counts[0], 0)
                self.assertEqual(counts[-1], 4 * p.gw * p.gh)
                self.assertEqual(counts, sorted(counts))

    def test_bricks_lay_odd_rows_half_a_cell_over(self):
        p = self.painter('bricks', size=(64, 32), cell=8)
        frame = p.base(self.flat(p, 0.5))
        even = frame.crop((0, 0, 48, 8)).tobytes()
        odd = frame.crop((4, 8, 52, 16)).tobytes()
        self.assertEqual(even, odd)
        self.assertNotEqual(frame.crop((0, 8, 48, 16)).tobytes(), even)
        self.assertEqual(p.set.offset(1, 8), 4)

    def test_drift_trails_run_in_its_direction(self):
        for direction, step in (('right', 1), ('left', -1), ('down', 'row'), ('up', '-row')):
            p = self.painter('drift', size=(160, 160), cell=8, direction=direction, effect=0.6)
            grid = self.flat(p, 0.0)
            centre = (p.gh // 2) * p.gw + p.gw // 2
            for arr in (grid.r, grid.g, grid.b):
                arr[centre] = 255.0
            grid.L[centre] = 1.0
            chs = [glyphs.mark(glyphs.LEVEL, 1)] * (p.gw * p.gh)
            cols = [(0, 0, 0)] * len(chs)
            cols[centre] = (255, 255, 255)
            p.set.arrange(p, chs, cols, grid, 0.0)
            d = {'row': p.gw, '-row': -p.gw}.get(step, step)
            with self.subTest(direction=direction):
                self.assertTrue(glyphs.code(chs[centre]) > glyphs.STREAK, 'the bright cell is a streak')
                self.assertTrue(chs[centre + d] and glyphs.code(chs[centre + d]) < glyphs.BRICK, 'a dot follows it')
                self.assertGreater(sum(cols[centre + d]), sum(cols[centre + 3 * d]), 'the trail fades')
                self.assertIsNone(chs[centre - d], 'nothing runs against the drift')

    def test_particles_thicken_with_light_and_effect(self):
        def count(L, effect):
            p = self.painter('particle', size=(320, 320), cell=8, effect=effect)
            chs = [glyphs.mark(glyphs.LEVEL, 1)] * (p.gw * p.gh)
            p.set.arrange(p, chs, [(0, 0, 0)] * len(chs), self.flat(p, L), 0.0)
            return sum(1 for c in chs if c)
        self.assertLess(count(0.2, 0.6), count(0.8, 0.6))
        self.assertLess(count(0.5, 0.1), count(0.5, 0.9))
        self.assertEqual(count(0.0, 1.0), 0)

    def test_film_grades_the_frame_and_spares_the_background(self):
        p = self.painter('film', size=(160, 96), effect=1.0)
        g = ras.grid_for(ras.fit_source(self.img, *p.sample_size), p, self.adjust, core.noise_field(p.gw * p.gh, 7))
        raw = p.base(g)
        done = p.finish(raw)
        self.assertNotEqual(raw.tobytes(), done.tobytes())
        self.assertLessEqual(max(abs(a - b) for a, b in zip(done.getpixel((80, 48)), p.bg)), 40)
        off = self.painter('film', size=(160, 96), effect=0.0)
        self.assertEqual(off.finish(raw).getpixel((80, 48)), raw.getpixel((80, 48)))

    def test_hot_cells_are_drawn_by_the_set(self):
        for charset in ('braille', 'bricks', 'particle', 'drift', 'tiles'):
            p = self.painter(charset)
            p.glitch = False
            frame = Image.new('RGB', (96, 64), p.bg)
            row, col = 3, 3
            p.hot(frame, self.flat(p, 0.0), [(row * p.gw + col, 1.0, 0, 0)], random.Random(1))
            x0 = col * 8 + p.set.offset(row, 8)
            cell = frame.crop((x0, row * 8, x0 + 8, row * 8 + 8))
            with self.subTest(charset=charset):
                self.assertIsNotNone(ImageChops.difference(cell, Image.new('RGB', cell.size, p.bg)).getbbox())


class PreviewDaemon(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.session = preview.Session()
        cls.cfg = {'source': SAMPLE, 'resolution': '1920x1080', 'charset': 'braille', 'style': 'real'}

    @classmethod
    def tearDownClass(cls):
        cls.session.close()

    def decode(self, text):
        import base64
        return Image.open(io.BytesIO(base64.b64decode(text)))

    def test_preview_draws_what_a_render_draws(self):
        for charset in ('ascii', 'braille', 'film', 'bricks'):
            cfg = {**self.cfg, 'charset': charset}
            helper = preview.Helper(cfg, self.session)
            _, img = self.session.source(helper)
            font = self.session.font(helper.cfg)
            fast = helper.still(img, 'dark', (480, 270), font)
            real = cli.Renderer(cli.normalize(cfg), cli.Job(None))
            try:
                slow = real.still(img, 'dark', (480, 270), font)
            finally:
                real.cleanup()
            with self.subTest(charset=charset):
                self.assertEqual(fast.tobytes(), slow.tobytes())

    def test_operations_answer_in_shape(self):
        out = self.session.op_preview({'cfg': self.cfg, 'mode': 'light', 'size': [640, 360]})
        self.assertEqual(self.decode(out['image']).size, (640, 360))
        self.assertEqual(out['output'], [1920, 1080])
        detail = self.session.op_detail({'cfg': self.cfg, 'mode': 'dark', 'focus': [1, 1], 'size': [400, 250]})
        self.assertEqual(detail['rect'], [1520, 830, 400, 250], 'the window stays inside the picture')
        self.assertEqual(self.decode(detail['image']).size, (400, 250))
        gallery = self.session.op_gallery({'cfg': self.cfg, 'mode': 'dark', 'tile': [120, 68]})
        self.assertEqual([t['id'] for t in gallery['tiles']], [c for c in glyphs.IDS if c != 'custom'])
        self.assertTrue(all(self.decode(t['image']).size == (120, 68) for t in gallery['tiles']))
        thumb = self.session.op_thumb({'path': SAMPLE, 'size': [160, 100]})
        self.assertEqual((self.decode(thumb['image']).format, thumb['kind']), ('JPEG', 'image'))
        with self.assertRaises(cli.Problem):
            self.session.op_motion({'cfg': {**self.cfg, 'animation': 'off'}, 'mode': 'dark', 'size': [320, 180]})

    def test_motion_loops_as_animated_webp(self):
        out = self.session.op_motion({'cfg': {**self.cfg, 'animation': 'breathe', 'duration': 2, 'fps': 10},
                                      'mode': 'dark', 'size': [320, 180]})
        im = self.decode(out['image'])
        self.assertEqual((im.format, im.size, out['frames']), ('WEBP', (320, 180), 20))
        self.assertTrue(getattr(im, 'is_animated', False))

    def test_protocol_keeps_stdout_to_answers(self):
        lines = '\n'.join(json.dumps(r) for r in (
            {'id': 1, 'op': 'info', 'cfg': self.cfg},
            {'id': 2, 'op': 'nope'},
            {'id': 3, 'op': 'preview', 'cfg': {**self.cfg, 'source': '/nope/missing.png'}, 'size': [320, 180]},
        )) + '\n'
        proc = subprocess.run([sys.executable, '-I', '-B', os.path.join(HERE, 'ascii_preview.py')], input=lines,
                              capture_output=True, text=True, timeout=120)
        answers = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual([a['id'] for a in answers], [1, 2, 3])
        self.assertEqual([a['ok'] for a in answers], [True, False, False])
        self.assertEqual(answers[2]['code'], 'source_missing')
        self.assertEqual(proc.returncode, 0)


class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='ascii-test-')
        self.out = os.path.join(self.tmp, 'plugin')
        os.makedirs(os.path.join(self.out, 'images'))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_render(self, **cfg):
        job = os.path.join(self.tmp, 'job.json')
        path = os.path.join(self.tmp, 'cfg.json')
        with open(path, 'w') as fh:
            json.dump({'jobFile': job, 'outDir': self.out, 'source': SAMPLE, 'resolution': '1920x1080', **cfg}, fh)
        proc = subprocess.run([sys.executable, '-I', '-B', os.path.join(HERE, 'ascii_cli.py'), 'render', path],
                              capture_output=True, text=True, timeout=600)
        with open(job) as fh:
            return proc, json.load(fh)

    def test_still_render_writes_valid_themes(self):
        stale = os.path.join(self.out, 'images', 'ascii-dark-000000000000.webp')
        keep = os.path.join(self.out, 'images', 'default-dark.webp')
        for path in (stale, keep):
            with open(path, 'wb') as fh:
                fh.write(b'x')
        proc, job = self.run_render(style='mesh', mask=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(job['state'], 'done')
        self.assertTrue(job['result']['ok'])
        self.assertFalse(os.path.exists(stale), 'earlier renders are pruned')
        self.assertTrue(os.path.exists(keep), 'files the renderer did not name are kept')
        for mode in ('dark', 'light'):
            with open(os.path.join(self.out, 'themes', f'ascii-{mode}.json')) as fh:
                doc = json.load(fh)
            self.assertEqual(doc['base'], mode)
            self.assertEqual(theme.validate(doc['tokens']), [])
            image = os.path.join(self.out, doc['background']['path'])
            self.assertLessEqual(os.path.getsize(image), enc.STILL_BUDGET)
            with Image.open(image) as im:
                self.assertEqual(im.format, 'WEBP')
                self.assertGreaterEqual(im.size[0], 640)
            self.assertNotIn('videoPath', doc['background'])
            with open(os.path.join(self.out, 'terminal', f'ascii-{mode}.json')) as fh:
                self.assertEqual(theme.validate_terminal(json.load(fh)), [])

    @unittest.skipUnless(HAVE_FFMPEG, 'needs ffmpeg with libx264')
    def test_a_sampled_set_renders_motion(self):
        proc, job = self.run_render(charset='braille', animation='hover', duration=2, fps=10, cell=10)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(job['result']['ok'])
        with open(os.path.join(self.out, 'themes', 'ascii-light.json')) as fh:
            doc = json.load(fh)
        self.assertLessEqual(os.path.getsize(os.path.join(self.out, doc['background']['videoPath'])), enc.VIDEO_BUDGET)

    def test_missing_source_is_reported(self):
        proc, job = self.run_render(source='/nope/missing.png')
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(job['result']['code'], 'source_missing')

    @unittest.skipUnless(HAVE_FFMPEG, 'needs ffmpeg with libx264')
    def test_animated_render_and_cancel(self):
        proc, job = self.run_render(animation='glitch', duration=2, fps=10, resolution='1920x1080', cell=10)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(os.path.join(self.out, 'themes', 'ascii-dark.json')) as fh:
            doc = json.load(fh)
        video = os.path.join(self.out, doc['background']['videoPath'])
        self.assertLessEqual(os.path.getsize(video), enc.VIDEO_BUDGET)
        info = enc.probe_video(enc.find_ffmpeg(), video)
        self.assertLessEqual(info['width'] * info['height'], enc.VIDEO_MAX_PIXELS)
        self.assertAlmostEqual(info['duration'], 2.0, delta=0.2)

        job_path = os.path.join(self.tmp, 'job2.json')
        cfg_path = os.path.join(self.tmp, 'cfg2.json')
        with open(cfg_path, 'w') as fh:
            json.dump({'jobFile': job_path, 'outDir': self.out, 'source': SAMPLE, 'animation': 'hover', 'duration': 20,
                       'fps': 30, 'resolution': '1920x1080'}, fh)
        child = subprocess.Popen([sys.executable, '-I', '-B', os.path.join(HERE, 'ascii_cli.py'), 'render', cfg_path],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 120
        while time.time() < deadline:
            try:
                with open(job_path) as fh:
                    if 'frame' in json.load(fh).get('text', ''):
                        break
            except (OSError, ValueError):
                pass
            time.sleep(0.2)
        child.send_signal(signal.SIGTERM)
        self.assertEqual(child.wait(timeout=60), 2)
        with open(job_path) as fh:
            result = json.load(fh)['result']
        self.assertTrue(result['cancelled'])
        time.sleep(0.5)
        left = subprocess.run(['pgrep', '-f', cfg_path], capture_output=True, text=True).stdout.split()
        self.assertEqual(left, [], 'no frame workers or encoders are left behind')


if __name__ == '__main__':
    unittest.main(verbosity=1)
