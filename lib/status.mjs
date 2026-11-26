export const STATUS_ITEM_ID = 'status'
const TEXT_MAX = 64
const TOOLTIP_MAX = 256

export function clamp(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function clock(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function statusView(state) {
  const s = state ?? {}
  switch (s.phase) {
    case 'rendering': {
      const pct = Math.round(Math.max(0, Math.min(1, s.progress ?? 0)) * 100)
      return { text: clamp(`ASCII ${pct}%`, TEXT_MAX), tone: 'accent', icon: 'layers', tooltip: clamp(`ASCII Glyphscape: ${s.text || 'rendering'}. Click to render again from the start.`, TOOLTIP_MAX) }
    }
    case 'waiting':
      return { text: 'ASCII…', tone: 'neutral', icon: 'layers', tooltip: 'ASCII Glyphscape: a render starts in a moment.' }
    case 'ok': {
      const size = Array.isArray(s.size) ? ` at ${s.size[0]}×${s.size[1]}` : ''
      const kind = s.video ? 'video wallpaper' : 'picture'
      return { text: 'ASCII', tone: 'success', icon: 'layers', tooltip: clamp(`ASCII Glyphscape: ${kind}${size} rendered ${clock(s.finishedAt)}. Choose "ASCII Glyphscape Dark" or "ASCII Glyphscape Light" in Settings > Appearance. Click to render again.`, TOOLTIP_MAX) }
    }
    case 'error':
      return { text: 'ASCII !', tone: 'danger', icon: 'layers', tooltip: clamp(`ASCII Glyphscape: ${s.error || 'the render failed'} Click to try again.`, TOOLTIP_MAX) }
    case 'empty':
      return { text: 'ASCII', tone: 'neutral', icon: 'layers', tooltip: 'ASCII Glyphscape: no picture or video yet. Open the editor or choose a file to render your wallpaper.' }
    case 'cancelled':
      return { text: 'ASCII', tone: 'warning', icon: 'layers', tooltip: 'ASCII Glyphscape: render cancelled. Click to render.' }
    default:
      return { text: 'ASCII', tone: 'neutral', icon: 'layers', tooltip: 'ASCII Glyphscape: click to render the wallpaper.' }
  }
}
