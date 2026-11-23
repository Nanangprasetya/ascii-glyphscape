from __future__ import annotations

import math
import random

KINDS = ('off', 'hover', 'ripple', 'scan', 'glitch', 'breathe')


class Motion:
    def __init__(self, kind: str, *, gw: int, gh: int, cell: int, width: int, height: int, fps: int,
                 frames: int, intensity: float = 0.8, radius: float = 110, trail: float = 0.93, seed: int = 7):
        if kind not in KINDS:
            raise ValueError(f'unknown animation {kind}')
        self.kind = kind
        self.gw, self.gh, self.S = gw, gh, cell
        self.W, self.H = width, height
        self.fps = fps
        self.N = max(1, frames)
        self.intensity = max(0.0, min(1.0, intensity))
        self.scale = height / 1080
        self.k = 60 / fps
        self.R = max(cell * 1.5, radius * self.scale)
        self.trail = max(0.0, min(0.999, trail)) ** self.k
        self.seed = seed
        self.heat: dict[int, float] = {}
        self.ripples: list[list[float]] = []
        self.mouse = None
        self.prev = None
        self.frame = 0
        self.ring = max(cell * 2, 14 * self.scale)
        self.ripple_speed = 9 * self.scale * self.k
        self.ripple_fade = 0.95 ** self.k
        self.glitch_decay = 0.55 ** self.k
        self._spawns = self._ripple_schedule()


    @property
    def stateless(self) -> bool:
        return self.kind in ('off', 'breathe')

    def frames(self):
        if not self.stateless:
            for f in range(self.N):
                self._step(f)
                self._snapshot()
        for f in range(self.N):
            if self.kind == 'off':
                yield ('uniform', 0.0)
            elif self.kind == 'breathe':
                t = f / self.N
                yield ('uniform', self.intensity * 0.24 * (0.5 - 0.5 * math.cos(2 * math.pi * t)))
            else:
                self._step(f)
                yield ('cells', self._snapshot())


    def cursor(self, t: float) -> tuple[float, float]:
        a = 2 * math.pi * t
        x = self.W * (0.5 + 0.36 * math.sin(a) + 0.06 * math.sin(3 * a + 1.3))
        y = self.H * (0.5 + 0.27 * math.sin(2 * a + 0.6) + 0.06 * math.cos(3 * a))
        return x, y

    def _ripple_schedule(self):
        rng = random.Random(self.seed * 7919 + 17)
        spawns = {}
        if self.kind == 'hover':
            for t in (0.18, 0.62):
                spawns[int(t * self.N) % self.N] = None
        elif self.kind == 'ripple':
            seconds = self.N / self.fps
            count = max(2, round(seconds / 1.1))
            for j in range(count):
                f = int((j + rng.random() * 0.6) * self.N / count) % self.N
                spawns[f] = (self.W * (0.1 + 0.8 * rng.random()), self.H * (0.12 + 0.76 * rng.random()))
        return spawns


    def _step(self, f: int) -> None:
        t = f / self.N
        if self.kind == 'hover':
            pos = self.cursor(t)
            prev = self.prev if self.prev is not None else self.cursor((f - 1) / self.N)
            self._stamp_path(prev, pos, self.intensity)
            self.prev = pos
            self.mouse = pos
        elif self.kind == 'scan':
            self._stamp_scan(t)
        elif self.kind == 'glitch':
            self._stamp_glitch(f)
        if f in self._spawns:
            at = self._spawns[f] or self.mouse or self.cursor(t)
            self.ripples.append([at[0], at[1], 0.0, self.intensity])
        self._advance_ripples()

    def _stamp_path(self, a, b, amp):
        S, R, gw, gh = self.S, self.R, self.gw, self.gh
        heat = self.heat
        steps = max(1, math.ceil(math.hypot(b[0] - a[0], b[1] - a[1]) / S))
        for k in range(steps + 1):
            mx = a[0] + (b[0] - a[0]) * k / steps
            my = a[1] + (b[1] - a[1]) * k / steps
            x0 = max(0, int((mx - R) / S))
            x1 = min(gw - 1, int((mx + R) / S))
            y0 = max(0, int((my - R) / S))
            y1 = min(gh - 1, int((my + R) / S))
            for y in range(y0, y1 + 1):
                cy = y * S + S / 2 - my
                for x in range(x0, x1 + 1):
                    dd = math.hypot(x * S + S / 2 - mx, cy)
                    if dd > R:
                        continue
                    v = (1 - dd / R) ** 2 * amp
                    i = y * gw + x
                    if v > heat.get(i, 0.0):
                        heat[i] = v

    def _advance_ripples(self):
        S, gw, gh, ring = self.S, self.gw, self.gh, self.ring
        heat = self.heat
        alive = []
        for rp in self.ripples:
            rp[2] += self.ripple_speed
            rp[3] *= self.ripple_fade
            if rp[3] < 0.02:
                continue
            alive.append(rp)
            px, py, r, a = rp
            x0 = max(0, int((px - r - ring) / S))
            x1 = min(gw - 1, int((px + r + ring) / S))
            y0 = max(0, int((py - r - ring) / S))
            y1 = min(gh - 1, int((py + r + ring) / S))
            inner = max(0.0, r - ring)
            for y in range(y0, y1 + 1):
                dy = y * S - py
                if abs(dy) > r + ring:
                    continue
                span_out = math.sqrt(max(0.0, (r + ring) ** 2 - dy * dy))
                span_in = math.sqrt(max(0.0, inner ** 2 - dy * dy)) if abs(dy) < inner else 0.0
                for lo, hi in ((px - span_out, px - span_in), (px + span_in, px + span_out)):
                    for x in range(max(x0, int(lo / S)), min(x1, int(hi / S)) + 1):
                        d = abs(math.hypot(x * S - px, dy) - r)
                        if d < ring:
                            i = y * gw + x
                            v = a * (1 - d / ring)
                            if v > heat.get(i, 0.0):
                                heat[i] = v
        self.ripples = alive

    def _stamp_scan(self, t):
        S, gw, gh = self.S, self.gw, self.gh
        band = max(S * 2, self.H * 0.05)
        travel = self.H + 4 * band
        yc = t * travel - 2 * band
        heat = self.heat
        y0 = max(0, int((yc - 2.5 * band) / S))
        y1 = min(gh - 1, int((yc + 2.5 * band) / S))
        for y in range(y0, y1 + 1):
            d = (y * S + S / 2 - yc) / band
            v = self.intensity * math.exp(-d * d)
            if v < 0.01:
                continue
            row = y * gw
            for x in range(gw):
                tex = 0.75 + 0.25 * (((x * 73856093) ^ (y * 19349663)) % 97) / 96
                i = row + x
                w = v * tex
                if w > heat.get(i, 0.0):
                    heat[i] = w

    def _stamp_glitch(self, f):
        per_tick = max(1, round(self.fps / 12))
        if f % per_tick:
            return
        tick = (f // per_tick) % max(1, self.N // per_tick)
        rng = random.Random(self.seed * 100003 + tick)
        gw, gh = self.gw, self.gh
        heat = self.heat
        for _ in range(rng.randint(2, 6)):
            w = rng.randint(3, max(4, gw // 6))
            h = rng.randint(1, 3)
            x0 = rng.randrange(0, max(1, gw - w))
            y0 = rng.randrange(0, max(1, gh - h))
            v = self.intensity * (0.5 + 0.5 * rng.random())
            for y in range(y0, min(gh, y0 + h)):
                for x in range(x0, min(gw, x0 + w)):
                    i = y * gw + x
                    if v > heat.get(i, 0.0):
                        heat[i] = v

    def _snapshot(self):
        heat = self.heat
        S = self.S
        out = []
        decay = self.glitch_decay if self.kind == 'glitch' else self.trail
        mouse = self.mouse if self.kind == 'hover' else None
        R2 = max(self.R, 1)
        gw = self.gw
        dead = []
        for i in sorted(heat):
            h = heat[i]
            if h < 0.01:
                dead.append(i)
                continue
            dx = dy = 0.0
            if mouse is not None:
                ddx = (i % gw) * S - mouse[0]
                ddy = (i // gw) * S - mouse[1]
                dd = math.hypot(ddx, ddy) or 1
                push = max(0.0, 1 - dd / R2) * S * 0.8
                dx, dy = ddx / dd * push, ddy / dd * push
            out.append((i, min(1.0, h), dx, dy))
            heat[i] = h * decay
        for i in dead:
            del heat[i]
        return out
