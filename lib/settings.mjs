export const SETTINGS = Object.freeze([
  { key: 'source', title: 'Source: picture or video', type: 'string', default: '', maxLength: 4096, placeholder: 'Choose a picture or video', description: 'Full path of a picture (JPG, PNG, WebP, BMP, GIF) or a video (MP4, MOV, WebM, MKV). Use the command "ASCII Glyphscape: Choose image or video" to pick one with a file dialog. Videos become video wallpapers.' },
  { key: 'fit', title: 'Source: fit', type: 'string', default: 'cover', enum: ['cover', 'contain'], enumLabels: ['Fill the screen (crop)', 'Show all (letterbox)'] },
  { key: 'position', title: 'Source: keep in view when cropping', type: 'string', default: 'center', enum: ['center', 'top', 'bottom', 'left', 'right'], enumLabels: ['Centre', 'Top', 'Bottom', 'Left', 'Right'] },
  { key: 'style', title: 'Style', type: 'string', default: 'real', enum: ['real', 'blue', 'dark', 'mesh'], enumLabels: ['Real: original colour', 'Blue: halftone', 'Dark: dot matrix', 'Mesh: diamond LED'] },
  { key: 'charset', title: 'Style: character set', type: 'string', default: 'ascii', enum: ['ascii', 'detailed', 'blocks', 'tiles', 'sparse', 'binary', 'braille', 'dots', 'dither', 'bricks', 'particle', 'film', 'drift', 'code', 'custom'], enumLabels: ['ASCII  .:-=+*#%@', 'Detailed  $8&o (70 steps)', 'Blocks  ░▒▓█', 'Letter tiles  8%t: (cut out of tiles)', 'Sparse  #+:.', 'Binary  01', 'Braille  ⣿⠶⠒ (twice the detail)', 'Dots  .·:•●', 'Dither  ▚▞ (twice the detail)', 'Bricks  ▣ ▣ ▣ (running bond)', 'Particle  ·:·:· (scattered dots)', 'Film  ISO (grade, halation, grain)', 'Drift  ▬·· (streaks and trails)', 'Code  {}[]<>/=', 'Custom (below)'], description: 'Braille and Dither read the picture at twice the grid’s detail. Film, Particle and Drift follow Style: effect strength. The Mesh style draws its own diamonds and does not use a character set.' },
  { key: 'customCharset', title: 'Style: custom characters', type: 'string', default: '', maxLength: 64, placeholder: ' .:-=+*#%@', description: 'Used when the character set is Custom: from empty or darkest to fullest, at least two characters. Start with a space for empty cells.' },
  { key: 'cell', title: 'Style: cell size (px at 1080p)', type: 'integer', default: 6, minimum: 3, maximum: 32, description: 'Size of one character cell on a 1080-pixel-high screen; it scales with the resolution, so the look is the same on every screen.' },
  { key: 'font', title: 'Style: font', type: 'string', default: '', maxLength: 512, placeholder: 'Empty: a bold monospace font', description: 'A font family name (for example "JetBrains Mono") or the full path of a .ttf/.otf file.' },
  { key: 'effect', title: 'Style: effect strength', type: 'number', default: 0.6, minimum: 0, maximum: 1, description: 'For the character sets with an effect. Film: colour grade, halation and grain. Particle: how many particles. Drift: how long the trails are.' },
  { key: 'driftDirection', title: 'Style: drift direction', type: 'string', default: 'right', enum: ['right', 'left', 'down', 'up'], enumLabels: ['Right', 'Left', 'Down (falling)', 'Up (rising)'], description: 'Which way the Drift character set smears bright cells.' },
  { key: 'saturation', title: 'Colour: saturation', type: 'number', default: 1.25, minimum: 0, maximum: 2 },
  { key: 'contrast', title: 'Colour: contrast', type: 'number', default: 1.1, minimum: 0.5, maximum: 2 },
  { key: 'brightness', title: 'Colour: brightness', type: 'number', default: 1.25, minimum: 0.4, maximum: 1.8 },
  { key: 'noise', title: 'Colour: grain / noise', type: 'number', default: 0.25, minimum: 0, maximum: 0.8 },
  { key: 'mask', title: 'Colour: isolate subject (flat background)', type: 'boolean', default: false, description: 'Treats colours close to the top-left corner of the picture as background and draws them flat. Best for a subject on a plain backdrop.' },
  { key: 'maskThreshold', title: 'Colour: isolate threshold', type: 'number', default: 0.12, minimum: 0, maximum: 0.9, description: 'How different from the backdrop a colour must be to count as subject.' },
  { key: 'inkColor', title: 'Colour: ink tint', type: 'string', default: '', maxLength: 7, placeholder: '#7cf0ff', description: 'A hex colour that every character is tinted toward (duotone). Empty: none.' },
  { key: 'inkStrength', title: 'Colour: ink tint strength', type: 'number', default: 0, minimum: 0, maximum: 1 },
  { key: 'backgroundColor', title: 'Colour: background', type: 'string', default: '', maxLength: 7, placeholder: 'Empty: the style’s own', description: 'Hex colour behind the characters.' },
  { key: 'accentColor', title: 'Colour: accent', type: 'string', default: '', maxLength: 7, placeholder: 'Empty: the style’s own', description: 'Hex colour of the glow in the motion effects, also used for Orca’s highlights.' },
  { key: 'vignette', title: 'Colour: top and bottom shade', type: 'number', default: 1, minimum: 0, maximum: 1 },
  { key: 'animation', title: 'Motion: animation', type: 'string', default: 'off', enum: ['off', 'hover', 'ripple', 'scan', 'glitch', 'breathe'], enumLabels: ['Off (still picture)', 'Hover: a wandering glow with a trail', 'Ripple: rings spreading out', 'Scan: a sweeping scanline', 'Glitch: flickering blocks', 'Breathe: a slow pulse'], description: 'Anything but Off makes a looping video wallpaper (needs ffmpeg). Orca plays it while its window is focused and shows the still picture otherwise.' },
  { key: 'animationIntensity', title: 'Motion: intensity', type: 'number', default: 0.8, minimum: 0, maximum: 1 },
  { key: 'hoverRadius', title: 'Motion: glow radius (px at 1080p)', type: 'integer', default: 110, minimum: 10, maximum: 400 },
  { key: 'trail', title: 'Motion: trail', type: 'number', default: 0.93, minimum: 0.8, maximum: 0.98, description: 'How long the glow lingers; higher is longer.' },
  { key: 'glitchChars', title: 'Motion: glitch characters in the glow', type: 'boolean', default: true },
  { key: 'fps', title: 'Motion: frames per second', type: 'integer', default: 24, minimum: 10, maximum: 30 },
  { key: 'duration', title: 'Motion: loop length (seconds)', type: 'number', default: 8, minimum: 2, maximum: 20 },
  { key: 'videoStart', title: 'Motion: video start (seconds)', type: 'number', default: 0, minimum: 0, maximum: 86400, description: 'For a video source: where the wallpaper clip starts.' },
  { key: 'videoEnd', title: 'Motion: video end (seconds)', type: 'number', default: 0, minimum: 0, maximum: 86400, description: 'For a video source: where it ends. 0: the end of the video. Orca plays at most 60 seconds.' },
  { key: 'resolution', title: 'Output: resolution', type: 'string', default: 'auto', enum: ['auto', '1920x1080', '2560x1440', '2560x1600', '3440x1440', '3840x2160'], enumLabels: ['Automatic (largest screen)', '1920 × 1080', '2560 × 1440', '2560 × 1600', '3440 × 1440', '3840 × 2160'], description: 'Orca accepts pictures up to 2 MB and videos up to 1920 × 1200 and 8 MB; a picture that would be larger is drawn again at a smaller size.' },
  { key: 'quality', title: 'Output: quality', type: 'string', default: 'high', enum: ['high', 'balanced', 'small'], enumLabels: ['High', 'Balanced', 'Small files'] },
  { key: 'wallpaperOpacity', title: 'Output: wallpaper strength', type: 'number', default: 1, minimum: 0, maximum: 1, description: 'How strongly Orca paints the wallpaper. Orca’s own Background Opacity (Settings > Appearance) must also be below 1 for the wallpaper to show at all.' },
  { key: 'wallpaperSize', title: 'Output: wallpaper sizing', type: 'string', default: 'cover', enum: ['cover', 'contain', 'tile'], enumLabels: ['Cover the window', 'Fit inside the window', 'Tile'] },
  { key: 'seed', title: 'Output: random seed', type: 'integer', default: 7, minimum: 0, maximum: 999999, description: 'Changes the grain and the glitch pattern while keeping everything else.' },
  { key: 'sidebarTone', title: 'Sidebar: tone', type: 'string', default: 'match', enum: ['match', 'deep', 'contrast'], enumLabels: ['Match the background', 'Deeper than the background', 'Lifted from the background'], description: 'Orca cannot blur or see through its sidebars; this sets how the solid sidebars sit against the wallpaper’s colours.' },
  { key: 'sidebarTint', title: 'Sidebar: accent tint', type: 'number', default: 0, minimum: 0, maximum: 0.35, description: 'Mixes the accent colour into the sidebars.' },
  { key: 'autoRender', title: 'Advanced: render when a setting changes', type: 'boolean', default: true, description: 'Off: render only with "ASCII Glyphscape: Render now".' },
  { key: 'python', title: 'Advanced: Python with Pillow', type: 'string', default: '', maxLength: 1024, placeholder: 'Empty: python3 on PATH', description: 'The renderer needs Python 3 with Pillow (python-pillow), and ffmpeg for motion and video.' },
  { key: 'outputDir', title: 'Advanced: theme output folder', type: 'string', default: '', maxLength: 4096, placeholder: 'Empty: this plugin’s folder', description: 'Where the themes are written. When this plugin’s folder is read-only (installed from Git) a small theme plugin is made in your data folder and loaded into Orca for you.' }
])

export const SETTING_BY_KEY = Object.freeze(Object.fromEntries(SETTINGS.map((s) => [s.key, s])))
export const DEFAULTS = Object.freeze(Object.fromEntries(SETTINGS.map((s) => [s.key, s.default])))

const NOT_RENDERED = new Set(['autoRender', 'python', 'outputDir'])
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

function clean(spec, value) {
  if (spec.type === 'boolean') return typeof value === 'boolean' ? value : spec.default
  if (spec.type === 'number' || spec.type === 'integer') {
    let n = typeof value === 'number' && Number.isFinite(value) ? value : spec.default
    if (spec.type === 'integer') n = Math.round(n)
    return Math.min(spec.maximum, Math.max(spec.minimum, n))
  }
  if (typeof value !== 'string') return spec.default
  if (spec.enum) return spec.enum.includes(value) ? value : spec.default
  let text = value.replace(/[\0\r\n]/g, '')
  if (spec.key !== 'customCharset') text = text.trim()
  return text.slice(0, spec.maxLength ?? 10_000)
}

export function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const spec of SETTINGS) out[spec.key] = clean(spec, value[spec.key])
  for (const key of ['inkColor', 'backgroundColor', 'accentColor']) {
    if (out[key] && !HEX.test(out[key])) out[key] = ''
    else if (out[key] && !out[key].startsWith('#')) out[key] = `#${out[key]}`
  }
  return out
}

export function invalidColours(raw) {
  const bad = []
  for (const key of ['inkColor', 'backgroundColor', 'accentColor']) {
    const v = typeof raw?.[key] === 'string' ? raw[key].trim() : ''
    if (v && !HEX.test(v)) bad.push(`${SETTING_BY_KEY[key].title} "${v}"`)
  }
  return bad
}

export function renderSettings(settings) {
  const out = {}
  for (const spec of SETTINGS) {
    if (!NOT_RENDERED.has(spec.key)) out[spec.key] = settings[spec.key]
  }
  return out
}

export function manifestEntry(spec) {
  const entry = {}
  for (const field of ['key', 'title', 'description', 'type', 'default', 'enum', 'enumLabels', 'minimum', 'maximum', 'maxLength', 'placeholder']) {
    if (spec[field] !== undefined) entry[field] = spec[field]
  }
  return entry
}
