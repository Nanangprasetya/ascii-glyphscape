from __future__ import annotations

import json
import math
import re

PUBLIC_TOKENS = frozenset('''
--accent --accent-foreground --background --border --card --card-foreground --chart-1 --chart-2 --chart-3
--chart-4 --chart-5 --chat-bold-foreground --chat-code-block --chat-inline-code --chat-inline-code-foreground
--chat-muted-foreground --chat-selection --chat-selection-foreground --chat-user-message --diff-added
--diff-added-background --diff-added-emphasis --diff-added-gutter --diff-removed --diff-removed-background
--diff-removed-emphasis --diff-removed-gutter --editor-selection --editor-surface --foreground
--git-decoration-added --git-decoration-copied --git-decoration-deleted --git-decoration-ignored
--git-decoration-modified --git-decoration-renamed --git-decoration-untracked --host-badge --host-badge-foreground
--input --muted --muted-foreground --popover --popover-foreground --primary --primary-foreground --ring --secondary
--secondary-foreground --sidebar --sidebar-accent --sidebar-accent-foreground --sidebar-border --sidebar-foreground
--sidebar-primary --sidebar-primary-foreground --sidebar-ring --split-divider --split-divider-hover --tab-active
--tab-active-foreground --tab-active-indicator --tab-bar --tab-inactive --tab-inactive-foreground --text-link
--worktree-sidebar --worktree-sidebar-accent --worktree-sidebar-accent-foreground --worktree-sidebar-active
--worktree-sidebar-active-border --worktree-sidebar-border --worktree-sidebar-foreground --worktree-sidebar-ring
'''.split())

PAIRS = (
    ('--background', '--foreground', 4.5),
    ('--background', '--muted-foreground', 4.5),
    ('--editor-surface', '--foreground', 4.5),
    ('--editor-surface', '--muted-foreground', 4.5),
    ('--card', '--card-foreground', 4.5),
    ('--popover', '--popover-foreground', 4.5),
    ('--primary', '--primary-foreground', 4.5),
    ('--secondary', '--secondary-foreground', 4.5),
    ('--muted', '--muted-foreground', 4.5),
    ('--accent', '--accent-foreground', 4.5),
    ('--sidebar', '--sidebar-foreground', 4.5),
    ('--sidebar-primary', '--sidebar-primary-foreground', 4.5),
    ('--sidebar-accent', '--sidebar-accent-foreground', 4.5),
    ('--worktree-sidebar', '--worktree-sidebar-foreground', 4.5),
    ('--worktree-sidebar-accent', '--worktree-sidebar-accent-foreground', 4.5),
    ('--worktree-sidebar-active', '--worktree-sidebar-foreground', 4.5),
    ('--host-badge', '--host-badge-foreground', 4.5),
    ('--tab-active', '--tab-active-foreground', 4.5),
    ('--tab-inactive', '--tab-inactive-foreground', 4.5),
    ('--tab-inactive', '--tab-active-foreground', 4.5),
    ('--editor-surface', '--text-link', 4.5),
    ('--editor-selection', '--foreground', 4.5),
)
RINGS = (
    ('--ring', '--background'),
    ('--sidebar-ring', '--sidebar'),
    ('--worktree-sidebar-ring', '--worktree-sidebar'),
    ('--tab-active-indicator', '--tab-active'),
    ('--tab-active-indicator', '--sidebar'),
)
THEME_MAX_BYTES = 16 * 1024
TERMINAL_KEYS = ('foreground', 'background', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground',
                 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
                 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta',
                 'brightCyan', 'brightWhite')
_HEX = re.compile(r'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$')
_HEX6 = re.compile(r'^#(?:[0-9a-fA-F]{3}){1,2}$')


def _lin(c: float) -> float:
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _gam(c: float) -> float:
    c = c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055
    return max(0.0, min(255.0, c * 255))


def luminance(c) -> float:
    return 0.2126 * _lin(c[0]) + 0.7152 * _lin(c[1]) + 0.0722 * _lin(c[2])


def contrast(a, b) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def to_oklch(c):
    r, g, b = _lin(c[0]), _lin(c[1]), _lin(c[2])
    l_ = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m_ = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s_ = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return L, math.hypot(A, B), math.degrees(math.atan2(B, A)) % 360


def from_oklch(L, C, H):
    for _ in range(40):
        a = C * math.cos(math.radians(H))
        b = C * math.sin(math.radians(H))
        l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
        m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
        s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
        r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
        g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
        bb = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_
        if min(r, g, bb) >= -1e-4 and max(r, g, bb) <= 1 + 1e-4 or C < 1e-4:
            return (round(_gam(max(0, r))), round(_gam(max(0, g))), round(_gam(max(0, bb))))
        C *= 0.9
    return (round(_gam(max(0, r))), round(_gam(max(0, g))), round(_gam(max(0, bb))))


def tone(c, lightness=None, chroma_max=None, chroma=None):
    L, C, H = to_oklch(c)
    if lightness is not None:
        L = lightness
    if chroma is not None:
        C = chroma
    if chroma_max is not None:
        C = min(C, chroma_max)
    return from_oklch(max(0.0, min(1.0, L)), C, H)


def shift(c, dl):
    L, C, H = to_oklch(c)
    return from_oklch(max(0.0, min(1.0, L + dl)), C, H)


def mixc(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def hexc(c) -> str:
    return '#%02x%02x%02x' % tuple(max(0, min(255, int(round(v)))) for v in c[:3])


def parse(value: str):
    t = value.strip().lstrip('#')
    if len(t) in (3, 4):
        t = ''.join(ch * 2 for ch in t)
    r, g, b = int(t[0:2], 16), int(t[2:4], 16), int(t[4:6], 16)
    a = int(t[6:8], 16) / 255 if len(t) == 8 else 1.0
    return (r, g, b, a)


def readable(text, surface, minimum=4.5, prefer_light=None):
    if contrast(text, surface) >= minimum:
        return tuple(text)
    L, C, H = to_oklch(text)
    if prefer_light is None:
        prefer_light = luminance(surface) < 0.18
    step = 0.01 if prefer_light else -0.01
    for _ in range(120):
        L = max(0.0, min(1.0, L + step))
        cand = from_oklch(L, C, H)
        if contrast(cand, surface) >= minimum:
            return cand
        if L in (0.0, 1.0):
            break
    best = (255, 255, 255) if prefer_light else (0, 0, 0)
    other = (0, 0, 0) if prefer_light else (255, 255, 255)
    return best if contrast(best, surface) >= contrast(other, surface) else other


def visible_ring(ring, surface, minimum=2.0):
    if contrast(ring, surface) >= minimum:
        return tuple(ring)
    return readable(ring, surface, minimum)


def ui_palette(mode: str, style_bg, accent, image_mean, sidebar_tone: str = 'match', sidebar_tint: float = 0.0):
    dark = mode == 'dark'
    _, bc, bh = to_oklch(style_bg)
    _, mc, mh = to_oklch(image_mean)
    hue_src = style_bg if bc > 0.02 else image_mean
    hue_chroma = min(0.05 if dark else 0.025, max(bc, mc) * 0.35)
    if dark:
        base_l = max(0.18, min(0.24, to_oklch(style_bg)[0]))
    else:
        base_l = max(0.955, min(0.985, to_oklch(style_bg)[0]))
    base = from_oklch(base_l, hue_chroma, to_oklch(hue_src)[2])
    step = 1 if dark else -1

    def lvl(dl):
        return shift(base, step * dl)

    accent = tuple(accent)
    fg = readable(tone(base, 0.94 if dark else 0.22, chroma=min(0.015, hue_chroma)), base, 7.0)
    muted_fg = readable(tone(base, 0.74 if dark else 0.45, chroma=min(0.02, hue_chroma)), lvl(0.07), 4.6)

    if sidebar_tone == 'deep':
        sidebar = shift(base, -0.045 if dark else 0.012)
    elif sidebar_tone == 'contrast':
        sidebar = lvl(0.045)
    else:
        sidebar = base
    if sidebar_tint > 0:
        sidebar = mixc(sidebar, accent, min(0.35, sidebar_tint))
        sidebar = tone(sidebar, max(0.12, min(0.3, to_oklch(sidebar)[0])) if dark else max(0.9, to_oklch(sidebar)[0]))

    primary = tone(accent, 0.8 if dark else 0.55) if to_oklch(accent)[1] > 0.02 else tone(accent, 0.8 if dark else 0.45)
    primary_fg = readable(tone(primary, 0.2 if dark else 0.98, chroma_max=0.04), primary, 4.6, prefer_light=not dark)
    link = readable(tone(accent, 0.8 if dark else 0.5), base, 4.6)

    p = {
        'base': base, 'fg': fg, 'muted_fg': muted_fg, 'accent': accent, 'primary': primary, 'primary_fg': primary_fg,
        'card': lvl(0.025), 'popover': lvl(0.04), 'secondary': lvl(0.06), 'muted': lvl(0.07), 'hover': lvl(0.09),
        'border': lvl(0.13), 'input': lvl(0.15), 'sidebar': sidebar, 'link': link,
        'selection': mixc(base, primary, 0.28 if dark else 0.22),
    }
    p['sidebar_accent'] = shift(sidebar, step * 0.07)
    p['sidebar_active'] = mixc(sidebar, primary, 0.2 if dark else 0.14)
    p['sidebar_border'] = shift(sidebar, step * 0.1)
    p['tab_bar'] = shift(base, -0.02 if dark else -0.015)
    p['tab_active'] = base
    p['tab_inactive'] = p['tab_bar']
    p['divider'] = lvl(0.1)
    p['divider_hover'] = primary
    p['charts'] = [tone(accent, 0.75 if dark else 0.58)] + [
        from_oklch(0.75 if dark else 0.58, 0.13, (to_oklch(accent)[2] + d) % 360) for d in (72, 144, 216, 288)
    ]
    return p


def tokens_for(p) -> dict[str, str]:
    t = {}

    def put(name, color):
        t[name] = hexc(color)

    base = p['base']
    put('--background', base)
    put('--editor-surface', base)
    put('--foreground', p['fg'])
    mf = p['muted_fg']
    for s in (base, p['muted']):
        mf = readable(mf, s, 4.6)
    put('--muted-foreground', mf)
    for name, key in (('--card', 'card'), ('--popover', 'popover'), ('--secondary', 'secondary'), ('--accent', 'hover')):
        put(name, p[key])
        put(name + '-foreground', readable(p['fg'], p[key], 4.6))
    put('--muted', p['muted'])
    put('--primary', p['primary'])
    put('--primary-foreground', p['primary_fg'])
    put('--border', p['border'])
    put('--input', p['input'])
    put('--ring', visible_ring(p['primary'], base))
    for i, c in enumerate(p['charts'], 1):
        put(f'--chart-{i}', c)

    sb = p['sidebar']
    sfg = readable(p['fg'], sb, 4.6)
    for prefix in ('--sidebar', '--worktree-sidebar'):
        put(prefix, sb)
        put(prefix + '-foreground', sfg)
        put(prefix + '-accent', p['sidebar_accent'])
        put(prefix + '-accent-foreground', readable(p['fg'], p['sidebar_accent'], 4.6))
        put(prefix + '-border', p['sidebar_border'])
        put(prefix + '-ring', visible_ring(p['primary'], sb))
    put('--sidebar-primary', p['primary'])
    put('--sidebar-primary-foreground', p['primary_fg'])
    active = p['sidebar_active']
    if contrast(sfg, active) < 4.6:
        active = mixc(sb, p['primary'], 0.08)
    put('--worktree-sidebar-active', active if contrast(sfg, active) >= 4.6 else sb)
    put('--worktree-sidebar-active-border', p['primary'])

    put('--tab-bar', p['tab_bar'])
    put('--tab-active', p['tab_active'])
    put('--tab-inactive', p['tab_inactive'])
    tfg = readable(readable(p['fg'], p['tab_active'], 4.6), p['tab_inactive'], 4.6)
    put('--tab-active-foreground', tfg)
    put('--tab-inactive-foreground', readable(p['muted_fg'], p['tab_inactive'], 4.6))
    ind = visible_ring(visible_ring(p['primary'], p['tab_active']), sb)
    put('--tab-active-indicator', ind)
    put('--split-divider', p['divider'])
    put('--split-divider-hover', p['divider_hover'])
    put('--text-link', readable(p['link'], base, 4.6))
    sel = p['selection']
    if contrast(p['fg'], sel) < 4.6:
        sel = mixc(base, p['primary'], 0.12)
    put('--editor-selection', sel if contrast(p['fg'], sel) >= 4.6 else p['secondary'])
    return t


def terminal_for(p, mode: str) -> dict:
    dark = mode == 'dark'
    bg = p['base']
    hue = to_oklch(p['accent'])[2]
    if dark:
        ansi = {
            'black': (40, 42, 48), 'red': (255, 107, 107), 'green': (126, 231, 135), 'yellow': (255, 213, 102),
            'blue': (110, 168, 255), 'magenta': (214, 140, 255), 'cyan': (102, 224, 238), 'white': (214, 218, 224),
            'brightBlack': (110, 116, 128), 'brightRed': (255, 145, 145), 'brightGreen': (160, 245, 168),
            'brightYellow': (255, 230, 150), 'brightBlue': (150, 195, 255), 'brightMagenta': (230, 178, 255),
            'brightCyan': (150, 238, 248), 'brightWhite': (246, 248, 250),
        }
    else:
        ansi = {
            'black': (36, 41, 47), 'red': (200, 30, 40), 'green': (26, 127, 55), 'yellow': (154, 103, 0),
            'blue': (9, 105, 218), 'magenta': (130, 80, 223), 'cyan': (0, 120, 140), 'white': (110, 119, 129),
            'brightBlack': (87, 96, 106), 'brightRed': (164, 14, 38), 'brightGreen': (17, 99, 41),
            'brightYellow': (125, 78, 0), 'brightBlue': (5, 80, 174), 'brightMagenta': (102, 57, 186),
            'brightCyan': (0, 95, 112), 'brightWhite': (60, 66, 74),
        }
    out = {'background': hexc(bg), 'foreground': hexc(readable(p['fg'], bg, 7.0))}
    for name, c in ansi.items():
        need = 1.6 if name in ('black',) else 3.0
        out[name] = hexc(readable(c, bg, need))
    out['cursor'] = hexc(visible_ring(p['primary'], bg, 3.0))
    out['cursorAccent'] = hexc(bg)
    sel = mixc(bg, from_oklch(0.6, 0.12, hue), 0.35 if dark else 0.25)
    out['selectionBackground'] = hexc(sel)
    out['selectionForeground'] = hexc(readable(p['fg'], sel, 4.5))
    return {'schemaVersion': 1, 'mode': mode, 'terminal': {k: out[k] for k in TERMINAL_KEYS if k in out}}


def _over(c, under):
    a = c[3]
    return tuple(c[i] * a + under[i] * (1 - a) for i in range(3)) + (1.0,)


def validate(tokens: dict[str, str], defaults: dict[str, str] | None = None) -> list[str]:
    problems = []
    for name, value in tokens.items():
        if name not in PUBLIC_TOKENS:
            problems.append(f'{name} is not a public theme token')
        elif not isinstance(value, str) or len(value) > 64 or not _HEX.match(value):
            problems.append(f'{name} has an unsupported value {value!r}')
    if '--background' not in tokens or '--foreground' not in tokens:
        problems.append('--background and --foreground are required')
    if problems:
        return problems
    defaults = defaults or {}

    def get(name):
        v = tokens.get(name, defaults.get(name))
        return parse(v) if v else None

    for surface, text, minimum in PAIRS:
        if surface not in tokens and text not in tokens:
            continue
        s, t = get(surface), get(text)
        if s is None or t is None:
            continue
        if surface == '--worktree-sidebar-active' and s[3] < 1:
            under = get('--worktree-sidebar')
            s = _over(s, under) if under else s
        if surface == '--editor-selection' and s[3] < 1:
            under = get('--editor-surface')
            s = _over(s, under) if under else s
        if s[3] < 1 or t[3] < 1:
            problems.append(f'{surface}/{text} is see-through, Orca drops it')
        elif contrast(s, t) < minimum:
            problems.append(f'{surface}/{text} contrast {contrast(s, t):.2f} < {minimum}')
    for ring, surface in RINGS:
        if ring not in tokens:
            continue
        r, s = get(ring), get(surface)
        if r is None or s is None:
            continue
        if contrast(_over(r, s), s) < 2:
            problems.append(f'{ring} is invisible on {surface}')
    return problems


def validate_terminal(doc: dict) -> list[str]:
    problems = []
    term = doc.get('terminal', {})
    for key in ('background', 'foreground'):
        if key not in term:
            problems.append(f'terminal.{key} is required')
    for key, value in term.items():
        if key not in TERMINAL_KEYS and key != 'bold':
            problems.append(f'terminal.{key} is not allowed')
        elif not isinstance(value, str) or not _HEX6.match(value):
            problems.append(f'terminal.{key} must be a 3 or 6 digit hex colour')
    return problems


def theme_document(mode: str, tokens: dict, image_path: str, video_path: str | None, opacity: float, size: str) -> dict:
    background = {'path': image_path}
    if video_path:
        background['videoPath'] = video_path
    background.update({'opacity': round(max(0.0, min(1.0, opacity)), 3), 'size': size, 'position': 'center'})
    return {'schemaVersion': 1, 'base': mode, 'tokens': tokens, 'background': background}


def dumps(doc) -> str:
    text = json.dumps(doc, indent=2, ensure_ascii=False) + '\n'
    if len(text.encode('utf-8')) > THEME_MAX_BYTES:
        raise ValueError('theme file would exceed 16 KiB')
    return text
