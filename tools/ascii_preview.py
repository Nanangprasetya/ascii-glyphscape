from __future__ import annotations

import base64
import io
import json
import os
import shutil
import sys
import tempfile
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from PIL import Image, ImageOps

from ascii_frames import Frames

import ascii_anim as anim
import ascii_cli as cli
import ascii_core as core
import ascii_encode as enc
import ascii_glyphs as glyphs
import ascii_raster as ras

PREVIEW_MAX = (1920, 1200)
DETAIL_MAX = (1600, 1000)
MOTION_MAX = (960, 600)
MOTION_FRAMES_MAX = 96
MOTION_CLIP_SECONDS = 4.0
MOTION_FPS = 12
MOTION_WORKERS = max(1, min(16, (os.cpu_count() or 2) - 1))
TILE_MAX = (320, 200)
SOURCES_KEPT = 3
FULL_KEPT = 2


def encoded(image: Image.Image, fmt: str = 'WEBP', **options) -> str:
    buf = io.BytesIO()
    image.save(buf, fmt, **options)
    return base64.b64encode(buf.getvalue()).decode('ascii')


def webp(image: Image.Image, quality: int = 88) -> str:
    return encoded(image, 'WEBP', quality=quality, method=2)


def jpeg(image: Image.Image, quality: int = 92) -> str:
    return encoded(image, 'JPEG', quality=quality, subsampling=0)


def size_arg(value, limit, minimum=(64, 36)) -> tuple[int, int]:
    try:
        w, h = int(value[0]), int(value[1])
    except (TypeError, ValueError, IndexError):
        raise cli.Problem('A size is missing.', 'invalid_request')
    return max(minimum[0], min(limit[0], w)), max(minimum[1], min(limit[1], h))


def focus_arg(value) -> tuple[float, float]:
    try:
        return max(0.0, min(1.0, float(value[0]))), max(0.0, min(1.0, float(value[1])))
    except (TypeError, ValueError, IndexError):
        return 0.5, 0.5


class Helper(cli.Renderer):
    def __init__(self, cfg: dict, session: 'Session'):
        self.cfg = cli.normalize(cfg)
        self.job = cli.Job(None)
        self.notes = []
        self.tmp = session.tmp
        self.cancel_hooks = []
        self.workers = 1
        self.ffmpeg = session.ffmpeg
        self.session = session

    def sizes(self):
        cfg = self.cfg
        if cfg['resolution'] == 'auto':
            screen = self.session.screen()
        else:
            screen = cli.RESOLUTIONS[cfg['resolution']]
        still = enc.clamp_still_size(*screen)
        return still, enc.video_size(*still)

    def still(self, img, mode, size, font):
        look = self.look(mode)
        bg = core.background(self.cfg['style'], mode, core.parse_hex(self.cfg['backgroundColor']))
        painter = ras.Painter(look, self.cell_for(size[1]), size, bg, font, self.cfg['glitchChars'])
        frame = painter.finish(painter.base(self.session.grid(self, img, painter)))
        return self.session.shade(size, look.light, self.cfg['vignette']).apply(frame)


class Session:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix='orca-ascii-preview-')
        self.ffmpeg = enc.find_ffmpeg()
        self.x264 = bool(self.ffmpeg and enc.ffmpeg_has_x264(self.ffmpeg))
        self._screen = None
        self.sources: dict = {}
        self.full: list = []
        self.fitted: dict = {}
        self.fonts: dict = {}
        self.grids: dict = {}
        self.shades: dict = {}

    def close(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def screen(self):
        if self._screen is None:
            self._screen = cli.detect_screen() or cli.FALLBACK_SCREEN
        return self._screen

    def font(self, cfg) -> str:
        if cfg['style'] == 'mesh':
            return ''
        key = (cfg['font'], cli.chars_for(cfg))
        if key not in self.fonts:
            self.fonts[key] = ras.find_font(cfg['font'], key[1] + core.GLITCH + '.')
        return self.fonts[key]

    def source(self, helper: Helper) -> tuple[str, Image.Image]:
        cfg = helper.cfg
        path = cfg['source']
        try:
            st = os.stat(path)
        except OSError:
            raise cli.Problem(f'The source file was not found: {path}', 'source_missing')
        key = (path, st.st_size, st.st_mtime_ns, cfg['videoStart'])
        found = self.sources.get(key)
        if found:
            return found
        kind, src = helper.load_source()
        if kind == 'video':
            if not self.ffmpeg:
                raise cli.Problem('A video source needs ffmpeg.', 'no_ffmpeg')
            src = helper.first_frame(src, cfg['videoStart'])
        if max(src.size) > 4096:
            src = src.copy()
            src.thumbnail((4096, 4096), Image.Resampling.LANCZOS)
        if len(self.sources) >= SOURCES_KEPT:
            self.sources.pop(next(iter(self.sources)))
        self.sources[key] = (kind, src)
        self.fitted.clear()
        self.grids.clear()
        return kind, src

    def grid(self, helper, img, painter):
        cfg = helper.cfg
        a = helper.adjust_args()
        key = (id(img), painter.sample_size, painter.subgrid, cfg['fit'], cfg['position'], cfg['seed'],
               tuple(sorted(a.items())))
        found = self.grids.get(key)
        if found is None:
            if len(self.grids) >= 4:
                self.grids.pop(next(iter(self.grids)))
            fitted = self.fit(helper, img, painter.sample_size)
            found = ras.grid_for(fitted, painter, a, core.noise_field(painter.gw * painter.gh, cfg['seed']))
            self.grids[key] = found
        return found

    def shade(self, size, light, strength):
        key = (tuple(size), light, strength)
        found = self.shades.get(key)
        if found is None:
            if len(self.shades) >= 4:
                self.shades.pop(next(iter(self.shades)))
            found = ras.Shade(size, light, strength)
            self.shades[key] = found
        return found

    def fit(self, helper, img, size):
        key = (id(img), size, helper.cfg['fit'], helper.cfg['position'])
        found = self.fitted.get(key)
        if found is None:
            if len(self.fitted) >= 6:
                self.fitted.clear()
            found = ras.fit_source(img, *size, helper.cfg['fit'], helper.cfg['position'])
            self.fitted[key] = found
        return found


    def op_info(self, req):
        helper = Helper(req.get('cfg') or {}, self)
        still, _ = helper.sizes()
        return {'output': list(still), 'cell': helper.cell_for(still[1]), 'ffmpeg': self.x264,
                'screen': list(self.screen())}

    def op_preview(self, req):
        helper = Helper(req['cfg'], self)
        mode = 'light' if req.get('mode') == 'light' else 'dark'
        size = size_arg(req.get('size'), PREVIEW_MAX)
        _, img = self.source(helper)
        still = helper.still(img, mode, size, self.font(helper.cfg))
        output, _ = helper.sizes()
        return {'image': jpeg(still), 'type': 'image/jpeg', 'size': list(size), 'output': list(output),
                'cell': helper.cell_for(output[1])}

    def full_render(self, helper, mode):
        output, _ = helper.sizes()
        key = json.dumps([helper.cfg, mode, output], sort_keys=True, default=str)
        for k, image in self.full:
            if k == key:
                return image, output
        _, img = self.source(helper)
        image = helper.still(img, mode, output, self.font(helper.cfg))
        self.full = [(key, image)] + self.full[:FULL_KEPT - 1]
        return image, output

    def op_detail(self, req):
        helper = Helper(req['cfg'], self)
        mode = 'light' if req.get('mode') == 'light' else 'dark'
        w, h = size_arg(req.get('size'), DETAIL_MAX)
        fx, fy = focus_arg(req.get('focus'))
        image, output = self.full_render(helper, mode)
        w, h = min(w, output[0]), min(h, output[1])
        x = int(round(fx * output[0] - w / 2))
        y = int(round(fy * output[1] - h / 2))
        x, y = max(0, min(output[0] - w, x)), max(0, min(output[1] - h, y))
        return {'image': encoded(image.crop((x, y, x + w, y + h)), 'PNG', compress_level=1), 'type': 'image/png',
                'rect': [x, y, w, h],
                'output': list(output), 'cell': helper.cell_for(output[1])}

    def op_gallery(self, req):
        base = Helper(req['cfg'], self)
        mode = 'light' if req.get('mode') == 'light' else 'dark'
        tw, th = size_arg(req.get('tile'), TILE_MAX, (32, 24))
        fx, fy = focus_arg(req.get('focus'))
        output, _ = base.sizes()
        cell = base.cell_for(output[1])
        gw, gh = -(-output[0] // cell), -(-output[1] // cell)
        _, img = self.source(base)
        whole = self.fit(base, img, (gw, gh))
        reference = whole.getpixel((0, 0))
        tiles = []
        ids = [c for c in glyphs.IDS if c != 'custom' or len(base.cfg['customCharset']) >= 2]
        for charset in ids:
            helper = Helper({**base.cfg, 'charset': charset}, self)
            look = helper.look(mode)
            bg = core.background(helper.cfg['style'], mode, core.parse_hex(helper.cfg['backgroundColor']))
            painter = ras.Painter(look, cell, (tw, th), bg, self.font(helper.cfg), helper.cfg['glitchChars'])
            k = 2 if painter.subgrid else 1
            source = self.fit(base, img, (gw * k, gh * k))
            cols, rows = painter.sample_size
            x = max(0, min(gw * k - cols, int(fx * gw * k - cols / 2)))
            y = max(0, min(gh * k - rows, int(fy * gh * k - rows / 2)))
            part = source.crop((x, y, x + cols, y + rows))
            grid = ras.grid_for(part, painter, helper.adjust_args(),
                                core.noise_field(painter.gw * painter.gh, helper.cfg['seed']), reference=reference)
            frame = painter.finish(painter.base(grid))
            tiles.append({'id': charset, 'image': encoded(frame, 'PNG', compress_level=1)})
        return {'tiles': tiles, 'cell': cell, 'mesh': base.cfg['style'] == 'mesh'}

    def op_motion(self, req):
        helper = Helper(req['cfg'], self)
        cfg = helper.cfg
        mode = 'light' if req.get('mode') == 'light' else 'dark'
        w, h = size_arg(req.get('size'), MOTION_MAX, (160, 90))
        kind, img = self.source(helper)
        if kind != 'video' and cfg['animation'] == 'off':
            raise cli.Problem('Motion is off: choose an animation under Motion first.', 'motion_off')
        if kind == 'video' and not self.x264:
            raise cli.Problem('A video source needs ffmpeg to preview.', 'no_ffmpeg')
        font = self.font(cfg)
        look = helper.look(mode)
        bg = core.background(cfg['style'], mode, core.parse_hex(cfg['backgroundColor']))
        cell = helper.cell_for(h)
        painter = ras.Painter(look, cell, (w, h), bg, font, cfg['glitchChars'])
        fps = min(cfg['fps'], MOTION_FPS)
        if kind == 'video':
            info = enc.probe_video(self.ffmpeg, cfg['source'])
            length = MOTION_CLIP_SECONDS
            if info['duration']:
                length = max(0.5, min(length, info['duration'] - min(cfg['videoStart'], info['duration'] - 0.5)))
            count = max(2, min(MOTION_FRAMES_MAX, int(round(length * fps))))
        else:
            count = max(2, int(round(cfg['duration'] * fps)))
            if count > MOTION_FRAMES_MAX:
                fps = max(4, int(MOTION_FRAMES_MAX / cfg['duration']))
                count = max(2, int(round(cfg['duration'] * fps)))
        motion = anim.Motion(cfg['animation'], gw=painter.gw, gh=painter.gh, cell=cell, width=w, height=h, fps=fps,
                             frames=count, intensity=cfg['animationIntensity'], radius=cfg['hoverRadius'],
                             trail=cfg['trail'], seed=cfg['seed'])
        spec = {'look': helper.look_args(look), 'cell': cell, 'size': (w, h), 'bg': bg, 'font': font,
                'glitch': cfg['glitchChars'], 'vignette': cfg['vignette'], 'seed': cfg['seed'],
                'adjust': helper.adjust_args(), 'grid': None}
        reader = None
        if kind == 'video':
            reader = iter(enc.VideoReader(self.ffmpeg, cfg['source'], painter.sample_size, fps, cfg['videoStart'],
                                          count / fps, cfg['fit'], cfg['position']))
        else:
            g = self.grid(helper, img, painter)
            spec['grid'] = (g.gw, g.gh, g.r, g.g, g.b, g.L, g.m, g.n, g.sub)

        def tasks():
            for index, (heat_kind, value) in enumerate(motion.frames()):
                raw = None
                if reader is not None:
                    raw = next(reader, None)
                    if raw is None:
                        return
                yield (index, raw, value if heat_kind == 'uniform' else 0.0, value if heat_kind == 'cells' else None)

        pool = Frames(spec, MOTION_WORKERS)
        try:
            frames = [Image.frombytes('RGB', (w, h), data) for data in pool.map(tasks())]
        finally:
            pool.close()
        if not frames:
            raise cli.Problem('No frames could be read from the video.', 'video_unreadable')
        buf = io.BytesIO()
        frames[0].save(buf, 'WEBP', save_all=True, append_images=frames[1:], duration=int(round(1000 / fps)),
                       loop=0, quality=72, method=1)
        return {'image': base64.b64encode(buf.getvalue()).decode('ascii'), 'frames': len(frames), 'fps': fps,
                'size': [w, h]}

    def op_thumb(self, req):
        w, h = size_arg(req.get('size'), (640, 400), (32, 24))
        path = str(req.get('path') or '')
        helper = Helper({'source': path}, self)
        kind, img = self.source(helper)
        thumb = ImageOps.fit(img, (w, h), Image.Resampling.LANCZOS)
        return {'image': encoded(thumb, 'JPEG', quality=84), 'kind': kind, 'pixels': list(img.size)}


def main() -> int:
    out = os.fdopen(os.dup(1), 'w', encoding='utf-8')
    os.dup2(2, 1)
    session = Session()
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            started = time.time()
            rid = None
            try:
                req = json.loads(line)
                rid = req.get('id')
                handler = getattr(session, f"op_{req.get('op')}", None)
                if not isinstance(req.get('op'), str) or handler is None:
                    raise cli.Problem('Unknown request.', 'invalid_request')
                answer = {'id': rid, 'ok': True, **handler(req)}
            except (cli.Problem, ras.RenderError, enc.EncodeError) as error:
                answer = {'id': rid, 'ok': False, 'error': str(error), 'code': getattr(error, 'code', 'render_failed')}
            except Exception as error:
                traceback.print_exc()
                answer = {'id': rid, 'ok': False, 'error': f'Unexpected error: {error}', 'code': 'render_failed'}
            answer['ms'] = int((time.time() - started) * 1000)
            out.write(json.dumps(answer) + '\n')
            out.flush()
    finally:
        session.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
