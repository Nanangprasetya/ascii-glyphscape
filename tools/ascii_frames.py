from __future__ import annotations

import multiprocessing
import os
import random
import sys
from collections import deque
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from PIL import Image

import ascii_core as core
import ascii_raster as ras

_W: dict = {}


def init(spec):
    look = core.Look(**spec['look'])
    painter = ras.Painter(look, spec['cell'], spec['size'], spec['bg'], spec['font'], spec['glitch'])
    _W.clear()
    _W.update(spec=spec, painter=painter, shade=ras.Shade(spec['size'], look.light, spec['vignette']),
              noise=core.noise_field(painter.gw * painter.gh, spec['seed']), static=None, base=None)
    if spec.get('grid') is not None:
        _W['static'] = core.Grid(*spec['grid'])
        _W['base'] = painter.base(_W['static'])


def frame(task):
    index, raw, uniform, cells = task
    spec, painter = _W['spec'], _W['painter']
    if raw is not None:
        img = Image.frombytes('RGB', painter.sample_size, raw)
        grid = ras.grid_for(img, painter, spec['adjust'], _W['noise'])
        out = painter.base(grid, uniform)
    else:
        grid = _W['static']
        out = _W['base'].copy() if uniform == 0 else painter.base(grid, uniform)
    if cells:
        painter.hot(out, grid, cells, random.Random(spec['seed'] * 1_000_003 + index))
    return _W['shade'].apply(painter.finish(out, index)).tobytes()


class Frames:
    def __init__(self, spec, workers: int):
        self.pool = None
        self.window = 1
        if workers > 1:
            try:
                method = 'forkserver' if 'forkserver' in multiprocessing.get_all_start_methods() else 'spawn'
                self.pool = ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context(method),
                                                initializer=init, initargs=(spec,))
                self.window = workers * 2
            except (OSError, ValueError, NotImplementedError):
                self.pool = None
        if self.pool is None:
            init(spec)

    def map(self, tasks):
        if self.pool is None:
            for t in tasks:
                yield frame(t)
            return
        pending = deque()
        for t in tasks:
            pending.append(self.pool.submit(frame, t))
            if len(pending) >= self.window:
                yield pending.popleft().result()
        while pending:
            yield pending.popleft().result()

    def close(self):
        pool, self.pool = self.pool, None
        if pool is None:
            return
        for process in list((getattr(pool, '_processes', None) or {}).values()):
            if process.is_alive():
                process.terminate()
        pool.shutdown(wait=False, cancel_futures=True)
