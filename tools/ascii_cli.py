from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from PIL import Image, ImageOps, features

import ascii_anim as anim
import ascii_core as core
import ascii_encode as enc
import ascii_glyphs as glyphs
from ascii_frames import Frames
import ascii_raster as ras
import ascii_theme as theme

USAGE = '''ASCII Glyphscape renderer.

    python3 -I ascii_cli.py render <config.json>   render both variants and write the theme files
    python3 -I ascii_cli.py probe                   what this machine can do, as JSON
'''
IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif'}
VIDEO_EXT = {'.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.gif'}
RESOLUTIONS = {'1920x1080': (1920, 1080), '2560x1440': (2560, 1440), '2560x1600': (2560, 1600),
               '3440x1440': (3440, 1440), '3840x2160': (3840, 2160)}
FALLBACK_SCREEN = (2560, 1440)
MEDIA_RE = re.compile(r'^ascii-(dark|light)-[0-9a-f]{12}\.(webp|mp4)$')


class Cancelled(Exception):
    pass


class Problem(Exception):
    def __init__(self, message: str, code: str = 'render_failed'):
        super().__init__(message)
        self.code = code


class Job:
    def __init__(self, path: str | None):
        self.path = path
        self.last = 0.0
        self.started = time.time()
        self.text = ''
        self.progress = 0.0

    def write(self, state: str, result=None, force=False):
        if not self.path:
            return
        now = time.time()
        if not force and state == 'running' and now - self.last < 0.25:
            return
        self.last = now
        doc = {'state': state, 'pid': os.getpid(), 'progress': round(self.progress, 4), 'text': self.text,
               'result': result, 'startedAt': int(self.started * 1000), 'updatedAt': int(now * 1000)}
        atomic_write(self.path, json.dumps(doc), log=False)

    def step(self, progress: float, text: str | None = None, force=False):
        self.progress = max(0.0, min(1.0, progress))
        if text is not None:
            self.text = text
        self.write('running', force=force)


def atomic_write(path: str, data, log=True):
    folder = os.path.dirname(path) or '.'
    os.makedirs(folder, exist_ok=True)
    tmp = os.path.join(folder, f'.{os.path.basename(path)}.{os.getpid()}.tmp')
    mode = 'wb' if isinstance(data, (bytes, bytearray)) else 'w'
    with open(tmp, mode, **({} if mode == 'wb' else {'encoding': 'utf-8'})) as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _num(cfg, key, default, lo, hi, integer=False):
    v = cfg.get(key, default)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        v = default
    v = max(lo, min(hi, v))
    return int(round(v)) if integer else float(v)


def _pick(cfg, key, allowed, default):
    v = cfg.get(key, default)
    return v if v in allowed else default


def normalize(cfg: dict) -> dict:
    out = dict(cfg)
    out['style'] = _pick(cfg, 'style', core.STYLES, 'real')
    out['charset'] = _pick(cfg, 'charset', glyphs.IDS, 'ascii')
    out['driftDirection'] = _pick(cfg, 'driftDirection', glyphs.DIRECTIONS, 'right')
    out['fit'] = _pick(cfg, 'fit', ('cover', 'contain'), 'cover')
    out['position'] = _pick(cfg, 'position', ('center', 'top', 'bottom', 'left', 'right'), 'center')
    out['animation'] = _pick(cfg, 'animation', anim.KINDS, 'off')
    out['quality'] = _pick(cfg, 'quality', tuple(enc.QUALITY), 'high')
    out['wallpaperSize'] = _pick(cfg, 'wallpaperSize', ('cover', 'contain', 'tile'), 'cover')
    out['sidebarTone'] = _pick(cfg, 'sidebarTone', ('match', 'deep', 'contrast'), 'match')
    out['resolution'] = cfg.get('resolution') if cfg.get('resolution') in RESOLUTIONS else 'auto'
    out['cell'] = _num(cfg, 'cell', 6, 2, 48, True)
    out['saturation'] = _num(cfg, 'saturation', 1.25, 0, 2)
    out['contrast'] = _num(cfg, 'contrast', 1.1, 0.5, 2)
    out['brightness'] = _num(cfg, 'brightness', 1.25, 0.4, 1.8)
    out['noise'] = _num(cfg, 'noise', 0.25, 0, 0.8)
    out['maskThreshold'] = _num(cfg, 'maskThreshold', 0.12, 0, 0.9)
    out['inkStrength'] = _num(cfg, 'inkStrength', 0, 0, 1)
    out['vignette'] = _num(cfg, 'vignette', 1, 0, 1)
    out['effect'] = _num(cfg, 'effect', 0.6, 0, 1)
    out['animationIntensity'] = _num(cfg, 'animationIntensity', 0.8, 0, 1)
    out['hoverRadius'] = _num(cfg, 'hoverRadius', 110, 10, 400)
    out['trail'] = _num(cfg, 'trail', 0.93, 0.8, 0.98)
    out['fps'] = _num(cfg, 'fps', 24, 10, 30, True)
    out['duration'] = _num(cfg, 'duration', 8, 2, 20)
    out['videoStart'] = _num(cfg, 'videoStart', 0, 0, 86400)
    out['videoEnd'] = _num(cfg, 'videoEnd', 0, 0, 86400)
    out['wallpaperOpacity'] = _num(cfg, 'wallpaperOpacity', 1, 0, 1)
    out['sidebarTint'] = _num(cfg, 'sidebarTint', 0, 0, 0.35)
    out['seed'] = _num(cfg, 'seed', 7, 0, 2 ** 31 - 1, True)
    out['mask'] = cfg.get('mask') is True
    out['glitchChars'] = cfg.get('glitchChars') is not False
    custom = cfg.get('customCharset') if isinstance(cfg.get('customCharset'), str) else ''
    out['customCharset'] = ''.join(ch for ch in custom if ch.isprintable() and ch not in '\t\r\n')[:64]
    for key in ('inkColor', 'backgroundColor', 'accentColor', 'font', 'source', 'ffmpeg'):
        out[key] = cfg.get(key) if isinstance(cfg.get(key), str) else ''
    return out


def chars_for(cfg) -> str:
    return glyphs.ramp_for(cfg['charset'], cfg['customCharset'])


def detect_screen() -> tuple[int, int] | None:
    tool = shutil.which('kscreen-doctor')
    if tool:
        try:
            out = subprocess.run([tool, '-j'], capture_output=True, text=True, timeout=8)
            data = json.loads(out.stdout or '{}')
            best = None
            for o in data.get('outputs', []):
                if not o.get('enabled') or not o.get('connected', True):
                    continue
                for m in o.get('modes', []):
                    if m.get('id') == o.get('currentModeId'):
                        s = m.get('size') or {}
                        w, h = int(s.get('width', 0)), int(s.get('height', 0))
                        if o.get('rotation') in (2, 8):
                            w, h = h, w
                        if w and h and (best is None or w * h > best[0] * best[1]):
                            best = (w, h)
            if best:
                return best
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
    tool = shutil.which('xrandr')
    if tool:
        try:
            out = subprocess.run([tool, '--current'], capture_output=True, text=True, timeout=8)
            found = re.search(r'current (\d+) x (\d+)', out.stdout)
            if found:
                return int(found.group(1)), int(found.group(2))
        except (OSError, subprocess.SubprocessError):
            pass
    return None


class Renderer:
    def __init__(self, cfg: dict, job: Job):
        self.cfg = cfg
        self.job = job
        self.notes: list[str] = []
        self.tmp = tempfile.mkdtemp(prefix='orca-ascii-')
        self.cancel_hooks = []
        self.workers = max(1, min(16, (os.cpu_count() or 2) - 1))

    def note(self, text):
        if text not in self.notes:
            self.notes.append(text)

    def cleanup(self):
        for hook in self.cancel_hooks:
            try:
                hook()
            except Exception:
                pass
        shutil.rmtree(self.tmp, ignore_errors=True)


    def load_source(self):
        cfg = self.cfg
        path = cfg['source']
        if not path:
            raise Problem('No source picture or video.', 'source_missing')
        if not os.path.isfile(path):
            raise Problem(f'The source file was not found: {path}. Choose another with "ASCII Glyphscape: Choose image or video".', 'source_missing')
        ext = os.path.splitext(path)[1].lower()
        if ext in IMAGE_EXT:
            try:
                img = Image.open(path)
                frames = getattr(img, 'n_frames', 1)
                if ext == '.gif' and frames > 1:
                    img.close()
                    return 'video', path
                img = ImageOps.exif_transpose(img)
                img.load()
                return 'image', img.convert('RGB')
            except (OSError, ValueError) as error:
                if ext not in VIDEO_EXT:
                    raise Problem(f'The picture could not be opened: {error}', 'source_unreadable') from error
        if ext in VIDEO_EXT:
            return 'video', path
        raise Problem(f'Unsupported file type {ext or "(none)"}. Use a picture (JPG, PNG, WebP, BMP, GIF) or a video (MP4, MOV, WebM, MKV).', 'source_unsupported')


    def sizes(self):
        cfg = self.cfg
        if cfg['resolution'] == 'auto':
            screen = detect_screen()
            if screen is None:
                screen = FALLBACK_SCREEN
                self.note(f'The screen size could not be read; rendered at {screen[0]}x{screen[1]}.')
        else:
            screen = RESOLUTIONS[cfg['resolution']]
        still = enc.clamp_still_size(*screen)
        video = enc.video_size(*still)
        return still, video

    def cell_for(self, height: int) -> int:
        return max(2, int(round(self.cfg['cell'] * height / 1080)))


    def look(self, mode, gw=1, gh=1):
        cfg = self.cfg
        return core.Look(style=cfg['style'], mode=mode, mask=cfg['mask'], chars=chars_for(cfg), noise=cfg['noise'],
                         gw=gw, gh=gh, accent=core.parse_hex(cfg['accentColor']), ink=core.parse_hex(cfg['inkColor']),
                         ink_strength=cfg['inkStrength'], charset=cfg['charset'], effect=cfg['effect'],
                         direction=cfg['driftDirection'], seed=cfg['seed'])

    def look_args(self, look):
        return {'style': look.style, 'mode': look.mode, 'mask': look.mask, 'chars': look.chars, 'noise': look.noise,
                'gw': look.gw, 'gh': look.gh, 'accent': look.accent, 'ink': look.ink, 'ink_strength': look.ink_strength,
                'charset': look.charset, 'effect': look.effect, 'direction': look.direction, 'seed': look.seed}

    def adjust_args(self):
        cfg = self.cfg
        return {'sat': cfg['saturation'], 'contrast': cfg['contrast'], 'bright': cfg['brightness'], 'mask': cfg['mask'],
                'threshold': cfg['maskThreshold'], 'softness': 0.18}

    def grid_from(self, img: Image.Image, painter: ras.Painter):
        fitted = ras.fit_source(img, *painter.sample_size, self.cfg['fit'], self.cfg['position'])
        return ras.grid_for(fitted, painter, self.adjust_args(), core.noise_field(painter.gw * painter.gh, self.cfg['seed']))

    def still(self, img, mode, size, font):
        look = self.look(mode)
        bg = core.background(self.cfg['style'], mode, core.parse_hex(self.cfg['backgroundColor']))
        painter = ras.Painter(look, self.cell_for(size[1]), size, bg, font, self.cfg['glitchChars'])
        frame = painter.finish(painter.base(self.grid_from(img, painter)))
        return ras.Shade(size, look.light, self.cfg['vignette']).apply(frame)

    def still_fitted(self, img, mode, size, font):
        wanted = size
        for _ in range(6):
            self.check()
            still = self.still(img, mode, size, font)
            data, q = enc.encode_still(still, self.cfg['quality'])
            if data is not None:
                if size != wanted:
                    self.note(f'Rendered at {size[0]}x{size[1]} instead of {wanted[0]}x{wanted[1]} to stay under Orca\'s 2 MB picture limit; Orca scales it to the window.')
                if q < 100 and q < enc.QUALITY.get(self.cfg['quality'], enc.QUALITY['high'])['q']:
                    self.note(f'{mode.capitalize()}: saved at WebP quality {q} to stay under 2 MB.')
                return still, data, size
            smaller = enc.next_size(size, q)
            if smaller is None:
                break
            size = smaller
        raise Problem('The picture does not fit in Orca\'s 2 MB limit even at the smallest size. Use a larger cell size, less noise, or the "small" quality.', 'still_too_large')

    def check(self):
        if CANCELLED[0]:
            raise Cancelled()

    def animate(self, mode, size, font, img=None, video=None, span=(0.0, 1.0), clip=None):
        cfg = self.cfg
        ffmpeg = self.ffmpeg
        look = self.look(mode)
        cell = self.cell_for(size[1])
        bg = core.background(cfg['style'], mode, core.parse_hex(cfg['backgroundColor']))
        probe_painter = ras.Painter(self.look(mode), cell, size, bg, font, cfg['glitchChars'])
        gw, gh = probe_painter.gw, probe_painter.gh
        look.gw, look.gh = gw, gh
        if video is None:
            fps = cfg['fps']
            count = max(2, int(round(cfg['duration'] * fps)))
        else:
            fps = clip['fps']
            count = max(1, int(round(clip['length'] * fps)))
        seconds = count / fps
        spec = {'look': self.look_args(look), 'cell': cell, 'size': size, 'bg': bg, 'font': font,
                'glitch': cfg['glitchChars'], 'vignette': cfg['vignette'], 'seed': cfg['seed'],
                'adjust': self.adjust_args(), 'grid': None}
        if img is not None:
            g = self.grid_from(img, probe_painter)
            spec['grid'] = (g.gw, g.gh, g.r, g.g, g.b, g.L, g.m, g.n, g.sub)

        def motion():
            return anim.Motion(cfg['animation'], gw=gw, gh=gh, cell=cell, width=size[0], height=size[1], fps=fps,
                               frames=count, intensity=cfg['animationIntensity'], radius=cfg['hoverRadius'],
                               trail=cfg['trail'], seed=cfg['seed'])
        lo, hi = span
        out = os.path.join(self.tmp, f'{mode}.mp4')
        rate = 1.0
        for attempt in range(3):
            frames = Frames(spec, self.workers)
            reader = None
            writer = enc.VideoWriter(ffmpeg, out, size, fps, seconds, cfg['quality'], rate_scale=rate)
            self.cancel_hooks = [writer.abort, frames.close]
            try:
                if video is not None:
                    reader = enc.VideoReader(ffmpeg, video, probe_painter.sample_size, fps, clip['start'], clip['length'],
                                             cfg['fit'], cfg['position'])
                    self.cancel_hooks.append(reader.close)
                    raws = iter(reader)
                else:
                    raws = None

                def tasks():
                    for index, heat in enumerate(motion().frames()):
                        self.check()
                        raw = None
                        if raws is not None:
                            raw = next(raws, None)
                            if raw is None:
                                return
                        kind, value = heat
                        yield (index, raw, value if kind == 'uniform' else 0.0, value if kind == 'cells' else None)

                written = 0
                for data in frames.map(tasks()):
                    self.check()
                    writer.write(data)
                    written += 1
                    self.job.step(lo + (hi - lo) * 0.92 * written / count,
                                  f'{mode.capitalize()}: frame {written} of {count}')
                if written == 0:
                    raise Problem(f'No frames could be read from the video. {reader.error() if reader else ""}'.strip(), 'video_unreadable')
                self.job.step(lo + (hi - lo) * 0.95, f'{mode.capitalize()}: finishing the video', force=True)
                bytes_ = writer.close()
            except BaseException:
                writer.abort()
                raise
            finally:
                frames.close()
                if reader is not None:
                    reader.close()
            if bytes_ <= enc.VIDEO_BUDGET:
                if attempt:
                    self.note('Lowered the video bit rate to stay under 8 MB.')
                return out
            rate *= 0.75 * enc.VIDEO_BUDGET / bytes_
        raise Problem('The video does not fit in 8 MB. Shorten it, lower the fps, or use a larger cell size.', 'video_too_large')


    def run(self):
        cfg = self.cfg
        job = self.job
        job.step(0.01, 'Preparing', force=True)
        out_dir = cfg.get('outDir') or ''
        if not out_dir or not os.path.isdir(out_dir):
            raise Problem(f'The output folder does not exist: {out_dir}', 'output_missing')
        if not os.access(out_dir, os.W_OK):
            raise Problem(f'The output folder is read-only: {out_dir}', 'output_readonly')
        kind, source = self.load_source()
        self.ffmpeg = enc.find_ffmpeg(cfg.get('ffmpeg'))
        moving = kind == 'video' or cfg['animation'] != 'off'
        if moving and (not self.ffmpeg or not enc.ffmpeg_has_x264(self.ffmpeg)):
            if kind == 'video':
                raise Problem('A video source needs ffmpeg with libx264. Install ffmpeg, or pick a picture.', 'no_ffmpeg')
            self.note('Animation is off because ffmpeg with libx264 was not found.')
            moving = False
        font = ras.find_font(cfg['font'], chars_for(cfg) + core.GLITCH + '.') if cfg['style'] != 'mesh' else ''
        still_size, video_size = self.sizes()
        clip = None
        first = source
        if kind == 'video':
            info = enc.probe_video(self.ffmpeg, source)
            start = min(cfg['videoStart'], max(0.0, info['duration'] - 0.5)) if info['duration'] else cfg['videoStart']
            end = cfg['videoEnd'] if cfg['videoEnd'] > start else (info['duration'] or start + enc.VIDEO_MAX_SECONDS)
            length = min(end - start, enc.VIDEO_MAX_SECONDS)
            if end - start > enc.VIDEO_MAX_SECONDS:
                self.note('Used the first 60 seconds of the clip (Orca plays at most 60).')
            fps = min(cfg['fps'], info['fps'] or cfg['fps'])
            clip = {'start': start, 'length': max(0.1, length), 'fps': max(1, int(round(fps)))}
            first = self.first_frame(source, start)
        results = {}
        modes = ('dark', 'light')
        for n, mode in enumerate(modes):
            lo, hi = n / len(modes), (n + 1) / len(modes)
            self.check()
            job.step(lo + 0.02 * (hi - lo), f'{mode.capitalize()}: drawing the picture', force=True)
            still, data, fitted = self.still_fitted(first, mode, still_size, font)
            still_size = fitted
            mean = still.resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))
            video_path = None
            if moving:
                span = (lo + 0.1 * (hi - lo), hi)
                if kind == 'video':
                    video_path = self.animate(mode, video_size, font, video=source, span=span, clip=clip)
                else:
                    video_path = self.animate(mode, video_size, font, img=source, span=span)
            results[mode] = {'still': data, 'video': video_path, 'mean': mean}
            job.step(hi, f'{mode.capitalize()}: done', force=True)
        self.check()
        return self.publish(results, still_size, video_size if moving else None)

    def first_frame(self, path, start):
        target = os.path.join(self.tmp, 'first.png')
        args = [self.ffmpeg, '-v', 'error', '-y', '-nostdin']
        if start > 0:
            args += ['-ss', f'{start:.3f}']
        args += ['-i', path, '-frames:v', '1', target]
        result = subprocess.run(args, capture_output=True, text=True, timeout=120)
        if result.returncode != 0 or not os.path.isfile(target):
            raise Problem(f'The video could not be read: {result.stderr.strip()[-300:]}', 'video_unreadable')
        with Image.open(target) as im:
            return im.convert('RGB')

    def publish(self, results, still_size, video_size):
        cfg = self.cfg
        out_dir = cfg['outDir']
        images = os.path.join(out_dir, 'images')
        os.makedirs(images, exist_ok=True)
        written = {}
        for mode, r in results.items():
            digest = hashlib.sha256(r['still']).hexdigest()[:12]
            still_name = f'ascii-{mode}-{digest}.webp'
            write_new(os.path.join(images, still_name), r['still'])
            video_name = None
            if r['video']:
                with open(r['video'], 'rb') as fh:
                    video = fh.read()
                video_name = f'ascii-{mode}-{hashlib.sha256(video).hexdigest()[:12]}.mp4'
                write_new(os.path.join(images, video_name), video)
            written[mode] = (still_name, video_name)
        for mode, r in results.items():
            accent = core.parse_hex(cfg['accentColor']) or (core.ACC_L if mode == 'light' else core.ACC_D)
            bg = core.background(cfg['style'], mode, core.parse_hex(cfg['backgroundColor']))
            palette = theme.ui_palette(mode, bg, accent, r['mean'], cfg['sidebarTone'], cfg['sidebarTint'])
            tokens = theme.tokens_for(palette)
            problems = theme.validate(tokens)
            if problems:
                raise Problem('Theme colours failed Orca\'s checks: ' + '; '.join(problems[:3]), 'theme_invalid')
            still_name, video_name = written[mode]
            doc = theme.theme_document(mode, tokens, f'images/{still_name}',
                                       f'images/{video_name}' if video_name else None,
                                       cfg['wallpaperOpacity'], cfg['wallpaperSize'])
            terminal = theme.terminal_for(palette, mode)
            if theme.validate_terminal(terminal):
                raise Problem('Terminal colours failed Orca\'s checks.', 'theme_invalid')
            write_if_changed(os.path.join(out_dir, 'terminal', f'ascii-{mode}.json'), theme.dumps(terminal))
            write_if_changed(os.path.join(out_dir, 'themes', f'ascii-{mode}.json'), theme.dumps(doc))
        removed = prune(images, {name for pair in written.values() for name in pair if name})
        return {
            'ok': True,
            'themes': {mode: {'image': f'images/{s}', 'video': f'images/{v}' if v else None} for mode, (s, v) in written.items()},
            'size': list(still_size),
            'videoSize': list(video_size) if video_size else None,
            'notes': self.notes,
            'removed': removed,
        }


def write_new(path, data):
    if os.path.isfile(path) and os.path.getsize(path) == len(data):
        return False
    atomic_write(path, data)
    return True


def write_if_changed(path, text):
    try:
        with open(path, encoding='utf-8') as fh:
            if fh.read() == text:
                return False
    except OSError:
        pass
    atomic_write(path, text)
    return True


def prune(images: str, keep: set) -> int:
    removed = 0
    now = time.time()
    for name in os.listdir(images):
        path = os.path.join(images, name)
        try:
            if MEDIA_RE.match(name) and name not in keep:
                os.remove(path)
                removed += 1
            elif name.startswith('.') and name.endswith('.tmp') and now - os.path.getmtime(path) > 600:
                os.remove(path)
        except OSError:
            pass
    return removed


CANCELLED = [False]
MAIN_PID = [os.getpid()]


def _on_term(signum, frame):
    if CANCELLED[0]:
        return
    CANCELLED[0] = True
    if os.getpid() != MAIN_PID[0]:
        os._exit(1)
    raise Cancelled()


def render(config_path: str) -> int:
    with open(config_path, encoding='utf-8') as fh:
        raw = json.load(fh)
    job = Job(raw.get('jobFile'))
    MAIN_PID[0] = os.getpid()
    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)
    cfg = normalize(raw)
    renderer = Renderer(cfg, job)
    started = time.time()
    try:
        result = renderer.run()
        result['elapsedMs'] = int((time.time() - started) * 1000)
        job.progress = 1.0
        job.text = 'Done'
        job.write('done', result, force=True)
        print(json.dumps(result))
        return 0
    except Cancelled:
        job.text = 'Cancelled'
        job.write('done', {'ok': False, 'cancelled': True, 'error': 'Cancelled.', 'code': 'cancelled'}, force=True)
        renderer.cleanup()
        os._exit(2)
    except (Problem, ras.RenderError, enc.EncodeError) as error:
        code = getattr(error, 'code', 'render_failed')
        job.text = 'Failed'
        job.write('done', {'ok': False, 'error': str(error), 'code': code}, force=True)
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:
        traceback.print_exc()
        job.text = 'Failed'
        job.write('done', {'ok': False, 'error': f'Unexpected error: {error}', 'code': 'render_failed'}, force=True)
        return 1
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        renderer.cleanup()
        cleanup = raw.get('cleanup')
        if cleanup and os.path.basename(cleanup).startswith('cfg-'):
            try:
                os.remove(cleanup)
            except OSError:
                pass


def probe(ffmpeg_setting: str = '') -> dict:
    ffmpeg = enc.find_ffmpeg(ffmpeg_setting)
    try:
        font = ras.find_font('', core.CHARSETS['ascii'] + core.CHARSETS['blocks'] + core.CHARSETS['dots'])
    except ras.RenderError:
        font = None
    import PIL
    return {'ok': True, 'python': sys.version.split()[0], 'pillow': PIL.__version__, 'webp': bool(features.check('webp')),
            'ffmpeg': ffmpeg, 'x264': bool(ffmpeg and enc.ffmpeg_has_x264(ffmpeg)), 'font': font,
            'screen': detect_screen()}


def main(argv) -> int:
    if len(argv) >= 3 and argv[1] == 'render':
        return render(argv[2])
    if len(argv) >= 2 and argv[1] == 'probe':
        print(json.dumps(probe(argv[2] if len(argv) > 2 else '')))
        return 0
    print(USAGE, file=sys.stderr)
    return 64


if __name__ == '__main__':
    sys.exit(main(sys.argv))
