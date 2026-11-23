from __future__ import annotations

import io
import json
import math
import os
import shutil
import subprocess
import threading

from PIL import Image

STILL_BUDGET = 2_000_000
VIDEO_BUDGET = 7_600_000
VIDEO_MAX_PIXELS = 2_304_000
VIDEO_MAX_SECONDS = 60
MIN_SIZE = (640, 360)
MAX_SIDE = 4096
QUALITY = {
    'high': {'q': 92, 'floor': 72, 'crf': 17},
    'balanced': {'q': 86, 'floor': 64, 'crf': 21},
    'small': {'q': 76, 'floor': 55, 'crf': 25},
}


class EncodeError(Exception):
    pass


def clamp_still_size(width: int, height: int) -> tuple[int, int]:
    k = min(1.0, MAX_SIDE / max(width, height))
    w, h = int(width * k), int(height * k)
    if w < MIN_SIZE[0] or h < MIN_SIZE[1]:
        k = max(MIN_SIZE[0] / w, MIN_SIZE[1] / h)
        w, h = math.ceil(w * k), math.ceil(h * k)
    return w, h


def video_size(width: int, height: int) -> tuple[int, int]:
    k = min(1.0, math.sqrt(VIDEO_MAX_PIXELS / (width * height)))
    w, h = int(width * k) // 2 * 2, int(height * k) // 2 * 2
    while w * h > VIDEO_MAX_PIXELS:
        w -= 2
        h = int(w * height / width) // 2 * 2
    if w < MIN_SIZE[0] or h < MIN_SIZE[1]:
        k = max(MIN_SIZE[0] / w, MIN_SIZE[1] / h)
        w, h = math.ceil(w * k / 2) * 2, math.ceil(h * k / 2) * 2
    return w, h


def _webp(img: Image.Image, **options) -> bytes:
    buf = io.BytesIO()
    img.save(buf, 'WEBP', **options)
    return buf.getvalue()


def encode_still(img: Image.Image, quality: str = 'high', budget: int = STILL_BUDGET):
    pref = QUALITY.get(quality, QUALITY['high'])
    img = img.convert('RGB')
    quick = _webp(img, lossless=True, quality=0, method=0)
    if len(quick) <= budget:
        best = _webp(img, lossless=True, quality=90, method=4)
        return (best if len(best) <= len(quick) else quick), 100
    lo, hi = pref['floor'], pref['q']
    smallest = _webp(img, quality=lo, method=4)
    if len(smallest) > budget:
        return None, len(smallest)
    top = _webp(img, quality=hi, method=4)
    if len(top) <= budget:
        return top, hi
    found, found_q = smallest, lo
    while hi - lo > 2:
        mid = (lo + hi) // 2
        data = _webp(img, quality=mid, method=4)
        if len(data) <= budget:
            found, found_q, lo = data, mid, mid
        else:
            hi = mid
    return found, found_q


def next_size(size, too_big: int, budget: int = STILL_BUDGET):
    w, h = size
    k = min(0.92, math.sqrt(budget / max(1, too_big)) * 0.95)
    nw, nh = int(w * k), int(h * k)
    if nw < MIN_SIZE[0] or nh < MIN_SIZE[1]:
        return None
    return nw, nh


def find_ffmpeg(setting: str | None = None) -> str | None:
    for candidate in (setting, shutil.which('ffmpeg'), '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def ffmpeg_has_x264(ffmpeg: str) -> bool:
    try:
        out = subprocess.run([ffmpeg, '-hide_banner', '-encoders'], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return False
    return ' libx264 ' in out.stdout


def ffprobe_for(ffmpeg: str) -> str | None:
    sibling = os.path.join(os.path.dirname(ffmpeg), 'ffprobe')
    for candidate in (sibling, shutil.which('ffprobe')):
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def probe_video(ffmpeg: str, path: str) -> dict:
    ffprobe = ffprobe_for(ffmpeg)
    if not ffprobe:
        raise EncodeError('ffprobe was not found next to ffmpeg.')
    out = subprocess.run(
        [ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries',
         'stream=width,height,avg_frame_rate,r_frame_rate,duration:format=duration', '-of', 'json', path],
        capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise EncodeError(f'The video could not be read: {out.stderr.strip()[-300:]}')
    info = json.loads(out.stdout or '{}')
    streams = info.get('streams') or []
    if not streams:
        raise EncodeError('The file has no video stream.')
    s = streams[0]

    def rate(text):
        try:
            a, b = str(text).split('/')
            return float(a) / float(b) if float(b) else 0.0
        except (ValueError, ZeroDivisionError):
            return 0.0

    duration = 0.0
    for v in (s.get('duration'), (info.get('format') or {}).get('duration')):
        try:
            duration = float(v)
            break
        except (TypeError, ValueError):
            continue
    return {'width': int(s.get('width') or 0), 'height': int(s.get('height') or 0),
            'fps': rate(s.get('avg_frame_rate')) or rate(s.get('r_frame_rate')) or 24.0, 'duration': duration}


class VideoReader:
    def __init__(self, ffmpeg: str, path: str, size, fps: float, start: float, length: float,
                 fit: str = 'cover', position: str = 'center'):
        gw, gh = size
        self.frame_bytes = gw * gh * 3
        if fit == 'contain':
            vf = (f'scale={gw}:{gh}:force_original_aspect_ratio=decrease:flags=lanczos,'
                  f'pad={gw}:{gh}:(ow-iw)/2:(oh-ih)/2:color=black')
        else:
            x = {'left': '0', 'right': 'in_w-out_w'}.get(position, '(in_w-out_w)/2')
            y = {'top': '0', 'bottom': 'in_h-out_h'}.get(position, '(in_h-out_h)/2')
            vf = f'scale={gw}:{gh}:force_original_aspect_ratio=increase:flags=lanczos,crop={gw}:{gh}:{x}:{y}'
        args = [ffmpeg, '-v', 'error', '-nostdin']
        if start > 0:
            args += ['-ss', f'{start:.3f}']
        args += ['-i', path, '-t', f'{length:.3f}', '-an', '-vf', f'fps={fps},{vf},format=rgb24',
                 '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self._err = []
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        for line in self.proc.stderr:
            if len(self._err) < 50:
                self._err.append(line.decode('utf-8', 'replace'))

    def __iter__(self):
        n = self.frame_bytes
        read = self.proc.stdout.read
        while True:
            chunk = read(n)
            if not chunk or len(chunk) < n:
                break
            yield chunk
        self.proc.wait()

    def error(self) -> str:
        return ''.join(self._err).strip()[-400:]

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()


class VideoWriter:
    def __init__(self, ffmpeg: str, path: str, size, fps: int, seconds: float, quality: str = 'high',
                 budget: int = VIDEO_BUDGET, rate_scale: float = 1.0):
        self.path = path
        self.size = size
        pref = QUALITY.get(quality, QUALITY['high'])
        seconds = max(0.5, seconds)
        maxrate = int(budget * 8 * 0.88 * rate_scale / seconds)
        self.maxrate = maxrate
        args = [ffmpeg, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{size[0]}x{size[1]}',
                '-r', str(fps), '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'slow', '-tune', 'animation',
                '-crf', str(pref['crf']), '-maxrate', f'{maxrate // 1000}k', '-bufsize', f'{maxrate // 1000}k',
                '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-g', str(max(1, fps * 2)), '-movflags', '+faststart',
                path]
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        self._err = []
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        for line in self.proc.stderr:
            if len(self._err) < 50:
                self._err.append(line.decode('utf-8', 'replace'))

    def write(self, frame) -> None:
        data = frame.tobytes() if isinstance(frame, Image.Image) else frame
        try:
            self.proc.stdin.write(data)
        except BrokenPipeError as error:
            raise EncodeError(f'ffmpeg stopped: {"".join(self._err).strip()[-400:]}') from error

    def close(self) -> int:
        try:
            self.proc.stdin.close()
        except BrokenPipeError:
            pass
        code = self.proc.wait()
        if code != 0:
            raise EncodeError(f'ffmpeg failed ({code}): {"".join(self._err).strip()[-400:]}')
        return os.path.getsize(self.path)

    def abort(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
