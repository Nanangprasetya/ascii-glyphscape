const $ = (id) => document.getElementById(id)
const dpr = () => Math.max(1, Math.min(3, window.devicePixelRatio || 1))

const HIDDEN_KEYS = new Set(['source'])
const COLOUR_KEYS = new Set(['inkColor', 'backgroundColor', 'accentColor'])
const GALLERY_SAME = new Set(['charset', 'fps', 'duration', 'animation', 'animationIntensity', 'hoverRadius', 'trail', 'glitchChars',
  'videoEnd', 'quality', 'wallpaperOpacity', 'wallpaperSize', 'sidebarTone', 'sidebarTint'])
const STILL_SAME = new Set(['fps', 'duration', 'animation', 'animationIntensity', 'hoverRadius', 'trail', 'glitchChars', 'videoEnd',
  'quality', 'wallpaperOpacity', 'wallpaperSize', 'sidebarTone', 'sidebarTint'])
const EFFECT_SETS = new Set(['film', 'particle', 'drift'])
const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i

const S = {
  schema: [],
  byKey: {},
  defaults: {},
  applied: {},
  appliedKey: '',
  draft: {},
  sources: [],
  checklist: '',
  mode: 'dark',
  view: 'still',
  lens: false,
  focus: [0.5, 0.45],
  output: [3840, 2160],
  cell: 12,
  status: null,
  applying: false,
  motionKey: '',
  fields: {},
  galleryTiles: {},
  sourceGrid: null
}

class ApiError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

async function api(name, input = {}) {
  let response
  try {
    response = await fetch(`rpc/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) })
  } catch {
    throw new ApiError('offline', 'The editor lost its connection to Orca. It reconnects by itself when Orca is back.')
  }
  if (!response.ok) throw new ApiError('http', `The editor could not reach the plugin (${response.status}). Open it again with "ASCII Glyphscape: Open editor".`)
  const body = await response.json()
  if (!body.ok) throw new ApiError(body.error?.code ?? 'failed', body.error?.message ?? 'The request failed.')
  return body.result
}

function toast(message, { error = false, ms = 5000 } = {}) {
  const el = document.createElement('div')
  el.className = `toast${error ? ' error' : ''}`
  el.textContent = message
  $('toasts').append(el)
  setTimeout(() => el.remove(), ms)
}

function fail(error) {
  if (error?.code === 'superseded') return
  toast(error?.message ?? String(error), { error: true, ms: 7000 })
}

function debounce(fn, ms) {
  let timer = null
  const wrapped = (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
  wrapped.now = (...args) => {
    clearTimeout(timer)
    fn(...args)
  }
  return wrapped
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child)
  return node
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function dirtyKeys() {
  return Object.keys(S.draft).filter((key) => !same(S.draft[key], S.applied[key]))
}

function groupOf(spec) {
  const at = spec.title.indexOf(':')
  return at === -1 ? spec.title : spec.title.slice(0, at)
}

function labelOf(spec) {
  const at = spec.title.indexOf(':')
  if (at === -1) return spec.key === 'style' ? 'Look' : spec.title
  const text = spec.title.slice(at + 1).trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function splitLabel(label) {
  const twin = label.indexOf('  ')
  if (twin !== -1) return [label.slice(0, twin), label.slice(twin + 2).trim()]
  const colon = label.indexOf(': ')
  if (colon !== -1) return [label.slice(0, colon), label.slice(colon + 2)]
  return [label, '']
}

function decimals(spec) {
  if (spec.type === 'integer') return 0
  const range = spec.maximum - spec.minimum
  return range <= 1.2 ? 2 : range <= 3 ? 2 : 1
}

function stepOf(spec) {
  if (spec.type === 'integer') return 1
  const range = spec.maximum - spec.minimum
  if (range <= 1.2) return 0.01
  if (range <= 3) return 0.01
  if (range <= 30) return 0.1
  return 1
}

function isVideoSource(draft = S.draft) {
  if (draft.source) {
    const item = S.sources.find((s) => s.path === draft.source)
    return item ? item.video : VIDEO_RE.test(draft.source)
  }
  return false
}

function visible(key, d) {
  switch (key) {
    case 'customCharset': return d.charset === 'custom'
    case 'effect': return EFFECT_SETS.has(d.charset)
    case 'driftDirection': return d.charset === 'drift'
    case 'font': return d.style !== 'mesh'
    case 'maskThreshold': return d.mask
    case 'inkStrength': return Boolean(d.inkColor)
    case 'animationIntensity': case 'fps': case 'duration': return d.animation !== 'off' || isVideoSource(d)
    case 'hoverRadius': case 'trail': case 'glitchChars': return d.animation === 'hover'
    case 'videoStart': case 'videoEnd': return isVideoSource(d)
    default: return true
  }
}

function field(spec, control, { inline = false, value = null } = {}) {
  const reset = el('button', { class: 'field-reset', type: 'button', title: 'Back to the default', 'aria-label': `Reset ${labelOf(spec)}`, text: '↺', onclick: () => setDraft(spec.key, S.defaults[spec.key]) })
  const head = el('div', { class: 'field-head' }, el('span', { class: 'field-dot', title: 'Changed, not applied yet' }), el('label', { class: 'field-label', for: `f-${spec.key}`, text: labelOf(spec) }), reset, value ? el('span', { class: 'field-value' }, value) : null)
  const help = spec.description && !inline ? el('p', { class: 'field-help', text: spec.description }) : null
  const node = el('div', { class: `field${inline ? ' inline' : ''}`, title: inline ? spec.description ?? '' : null }, head, control, help)
  return node
}

function numberField(spec) {
  const step = stepOf(spec)
  const digits = decimals(spec)
  const big = spec.maximum - spec.minimum > 2000
  const num = el('input', { class: 'num', id: `f-${spec.key}`, type: 'number', min: spec.minimum, max: spec.maximum, step, inputmode: 'decimal' })
  const range = big ? null : el('input', { type: 'range', min: spec.minimum, max: spec.maximum, step, 'aria-label': labelOf(spec) })
  const commit = (raw) => {
    let v = Number(raw)
    if (!Number.isFinite(v)) return
    v = Math.min(spec.maximum, Math.max(spec.minimum, v))
    if (spec.type === 'integer') v = Math.round(v)
    else v = Number(v.toFixed(Math.max(digits, 2)))
    setDraft(spec.key, v)
  }
  num.addEventListener('change', () => commit(num.value))
  range?.addEventListener('input', () => commit(range.value))
  const node = field(spec, range ?? el('span'), { value: num })
  return {
    node,
    update(v) {
      if (document.activeElement !== num) num.value = Number(v).toFixed(digits)
      if (range) {
        range.value = v
        range.style.setProperty('--fill', `${((v - spec.minimum) / (spec.maximum - spec.minimum)) * 100}%`)
      }
    }
  }
}

function choiceField(spec) {
  const labels = spec.enumLabels ?? spec.enum
  const parts = labels.map(splitLabel)
  const short = spec.enum.length <= 4 && parts.every(([name]) => name.length <= 14)
  if (short) {
    const buttons = spec.enum.map((value, i) => el('button', { type: 'button', title: labels[i], text: parts[i][0], onclick: () => setDraft(spec.key, value) }))
    const chips = el('div', { class: 'chips', role: 'group', id: `f-${spec.key}`, 'aria-label': labelOf(spec) }, buttons)
    chips.style.gridTemplateColumns = `repeat(${spec.enum.length}, minmax(0, 1fr))`
    return { node: field(spec, chips), update: (v) => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(spec.enum[i] === v))) }
  }
  const select = el('select', { class: 'select', id: `f-${spec.key}`, onchange: () => setDraft(spec.key, select.value) }, spec.enum.map((value, i) => el('option', { value, text: labels[i] })))
  return { node: field(spec, select), update: (v) => { select.value = v } }
}

function switchField(spec) {
  const button = el('button', { class: 'switch', id: `f-${spec.key}`, type: 'button', role: 'switch', onclick: () => setDraft(spec.key, !S.draft[spec.key]) })
  return { node: field(spec, button, { inline: true }), update: (v) => button.setAttribute('aria-checked', String(Boolean(v))) }
}

function colourField(spec) {
  const picker = el('input', { type: 'color', 'aria-label': `${labelOf(spec)} picker`, oninput: () => setDraft(spec.key, picker.value) })
  const text = el('input', { class: 'text', id: `f-${spec.key}`, type: 'text', maxlength: 7, spellcheck: 'false', placeholder: 'Auto' })
  text.addEventListener('change', () => {
    const v = text.value.trim()
    if (!v) return setDraft(spec.key, '')
    const hex = v.startsWith('#') ? v : `#${v}`
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) setDraft(spec.key, hex.toLowerCase())
    else {
      toast(`${labelOf(spec)}: "${v}" is not a hex colour like #7cf0ff.`, { error: true })
      text.value = S.draft[spec.key]
    }
  })
  const auto = el('button', { class: 'ghost small auto', type: 'button', text: 'Auto', title: 'Use the style’s own colour', onclick: () => setDraft(spec.key, '') })
  const box = el('div', { class: 'colour' }, picker, text, auto)
  return {
    node: field(spec, box),
    update(v) {
      box.classList.toggle('is-auto', !v)
      if (document.activeElement !== text) text.value = v || ''
      const six = /^#[0-9a-f]{3}$/i.test(v) ? `#${v.slice(1).split('').map((c) => c + c).join('')}` : v
      picker.value = /^#[0-9a-f]{6}$/i.test(six) ? six : '#000000'
      auto.setAttribute('aria-pressed', String(!v))
    }
  }
}

function textField(spec) {
  const input = el('input', { class: `text${spec.key === 'customCharset' ? ' mono' : ''}`, id: `f-${spec.key}`, type: 'text', maxlength: spec.maxLength ?? 512, spellcheck: 'false', placeholder: spec.placeholder ?? '' })
  input.addEventListener('change', () => setDraft(spec.key, spec.key === 'customCharset' ? input.value : input.value.trim()))
  return { node: field(spec, input), update: (v) => { if (document.activeElement !== input) input.value = v ?? '' } }
}

function seedField(spec) {
  const input = el('input', { class: 'text', id: `f-${spec.key}`, type: 'number', min: spec.minimum, max: spec.maximum, step: 1 })
  input.addEventListener('change', () => {
    const v = Math.round(Number(input.value))
    if (Number.isFinite(v)) setDraft(spec.key, Math.min(spec.maximum, Math.max(spec.minimum, v)))
  })
  const dice = el('button', { class: 'ghost', type: 'button', text: 'Shuffle', title: 'A new random seed', onclick: () => setDraft(spec.key, Math.floor(Math.random() * spec.maximum)) })
  return { node: field(spec, el('div', { class: 'seed' }, input, dice)), update: (v) => { if (document.activeElement !== input) input.value = v } }
}

function galleryField(spec) {
  const labels = spec.enumLabels ?? spec.enum
  const grid = el('div', { class: 'tiles', id: `f-${spec.key}`, role: 'group', 'aria-label': 'Character set' })
  const note = el('p', { class: 'tiles-note', hidden: true, text: 'The Mesh look draws diamonds; it does not use a character set.' })
  S.galleryTiles = {}
  spec.enum.forEach((value, i) => {
    const [name, glyphs] = splitLabel(labels[i])
    const image = el('img', { class: 'tile-image', alt: '' })
    const tile = el('button', { class: 'tile', type: 'button', title: labels[i], onclick: () => setDraft(spec.key, value) },
      el('span', { class: 'tile-frame' }, image),
      el('span', { class: 'tile-name' }, name, el('span', { class: 'tile-glyphs', text: glyphs.replace(/\s*\(.*\)$/, '') || ' ' })))
    S.galleryTiles[value] = { tile, image }
    grid.append(tile)
  })
  return {
    node: field(spec, el('div', {}, grid, note)),
    update(v) {
      for (const [value, { tile }] of Object.entries(S.galleryTiles)) tile.setAttribute('aria-pressed', String(value === v))
      const mesh = S.draft.style === 'mesh'
      grid.classList.toggle('dim', mesh)
      note.hidden = !mesh
    }
  }
}

function sourceField() {
  const spec = { key: 'source', title: 'Source: picture or video', description: '' }
  const grid = el('div', { class: 'tiles' })
  const path = el('p', { class: 'source-path' })
  const browse = el('button', { class: 'ghost small', type: 'button', text: 'Browse files…', title: 'The desktop’s file dialog', onclick: browseFile })
  const actions = el('div', { class: 'source-actions' }, browse, el('span', { class: 'field-help', text: 'or drop a file on the preview' }))
  S.sourceGrid = grid
  return {
    node: field(spec, el('div', { class: 'stack' }, grid, actions, path)),
    update() {
      renderSources()
      const current = S.draft.source
      path.textContent = current ? current : ''
      path.classList.toggle('missing', Boolean(current) && !S.sources.some((s) => s.path === current))
      if (path.classList.contains('missing')) path.textContent = `Missing: ${current}`
    }
  }
}

function renderSources() {
  const grid = S.sourceGrid
  if (!grid) return
  const add = el('button', { class: 'tile add', type: 'button', title: 'Upload a picture or video', onclick: () => $('file-input').click() }, el('strong', { text: '+' }), el('span', { text: 'Upload' }))
  const tiles = S.sources.map((item) => {
    const selected = S.draft.source ? S.draft.source === item.path : item.kind === 'sample'
    const remove = item.kind === 'library' && item.path !== S.applied.source
      ? el('span', { class: 'remove', role: 'button', title: 'Remove from the library', text: '×', onclick: (event) => { event.stopPropagation(); removeSource(item) } })
      : null
    return el('button', { class: 'tile', type: 'button', title: item.path, 'aria-pressed': String(selected), onclick: () => pickSource(item) },
      el('span', { class: 'tile-frame' }, el('img', { class: 'tile-image', alt: '', src: `thumb/${item.id}`, loading: 'lazy' }), item.video ? el('span', { class: 'badge', text: 'VIDEO' }) : null, remove),
      el('span', { class: 'tile-name', text: item.name }))
  })
  grid.replaceChildren(add, ...tiles)
}

function buildPanel() {
  const panel = $('panel')
  panel.replaceChildren()
  S.fields = {}
  const groups = new Map()
  for (const spec of S.schema) {
    const group = groupOf(spec)
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(spec)
  }
  for (const [name, specs] of groups) {
    const body = el('div', { class: 'group-body' })
    const badge = el('span', { class: 'group-badge' })
    const details = el('details', { class: 'group', open: true }, el('summary', {}, el('span', {}, name, badge)), body)
    details.dataset.group = name
    if (name === 'Source') {
      const control = sourceField()
      S.fields.source = { ...control, group: name }
      body.append(control.node)
    }
    for (const spec of specs) {
      if (HIDDEN_KEYS.has(spec.key)) continue
      let control
      if (spec.key === 'charset') control = galleryField(spec)
      else if (spec.key === 'seed') control = seedField(spec)
      else if (COLOUR_KEYS.has(spec.key)) control = colourField(spec)
      else if (spec.enum) control = choiceField(spec)
      else if (spec.type === 'boolean') control = switchField(spec)
      else if (spec.type === 'number' || spec.type === 'integer') control = numberField(spec)
      else control = textField(spec)
      control.node.dataset.key = spec.key
      S.fields[spec.key] = { ...control, group: name, badge }
      body.append(control.node)
    }
    S.fields[`group:${name}`] = { badge }
    panel.append(details)
  }
  const foot = el('div', { class: 'panel-foot' },
    el('button', { class: 'ghost', type: 'button', text: 'All to defaults', title: 'Every look setting back to its default (the source stays)', onclick: resetAll }),
    el('button', { class: 'ghost', type: 'button', text: 'Render again', title: 'Render the applied settings again', onclick: renderAgain }))
  panel.append(foot)
}

function refreshFields() {
  const dirty = new Set(dirtyKeys())
  const counts = {}
  for (const [key, f] of Object.entries(S.fields)) {
    if (key.startsWith('group:')) continue
    if (key === 'source') {
      f.update()
      const changed = dirty.has('source')
      f.node.classList.toggle('dirty', changed)
      if (changed) counts.Source = (counts.Source ?? 0) + 1
      continue
    }
    const v = S.draft[key]
    f.update(v)
    f.node.hidden = !visible(key, S.draft)
    f.node.classList.toggle('dirty', dirty.has(key))
    f.node.classList.toggle('changed', !same(v, S.defaults[key]))
    if (dirty.has(key)) counts[f.group] = (counts[f.group] ?? 0) + 1
  }
  for (const [key, f] of Object.entries(S.fields)) {
    if (!key.startsWith('group:')) continue
    const n = counts[key.slice(6)] ?? 0
    f.badge.textContent = n ? `${n} changed` : ''
  }
  const n = dirty.size
  $('apply-count').textContent = n ? String(n) : ''
  $('apply').disabled = S.applying || n === 0
  $('revert').disabled = n === 0
  renderStatus()
}

function setDraft(key, value, { quiet = false } = {}) {
  if (same(S.draft[key], value)) return
  S.draft = { ...S.draft, [key]: value }
  refreshFields()
  if (!quiet) draftChanged([key])
}

function draftChanged(keys) {
  if (!keys.every((k) => STILL_SAME.has(k))) previews.still()
  if (!keys.every((k) => GALLERY_SAME.has(k))) previews.gallery()
  if (S.view === 'motion') staleMotion()
  if (S.lens) previews.detail()
}

function pickSource(item) {
  const source = item.kind === 'sample' ? '' : item.path
  if (same(source, S.draft.source)) return
  S.draft = { ...S.draft, source }
  refreshFields()
  draftChanged(['source'])
}

function resetAll() {
  const next = { ...S.defaults, source: S.draft.source }
  S.draft = next
  refreshFields()
  draftChanged(['source'])
  toast('Every look setting is back to its default. Apply to keep it.')
}

function revert() {
  S.draft = { ...S.applied }
  refreshFields()
  draftChanged(['source'])
}

function screenBox() {
  const rect = $('screen').getBoundingClientRect()
  return { width: rect.width, height: rect.height, left: rect.left, top: rect.top }
}

function previewSize(limit = [1920, 1200]) {
  const box = screenBox()
  let w = Math.round(box.width * dpr())
  let h = Math.round((w * S.output[1]) / S.output[0])
  const k = Math.min(1, limit[0] / w, limit[1] / h)
  w = Math.max(160, Math.round(w * k))
  h = Math.max(90, Math.round(h * k))
  return [w, h]
}

function setAspect() {
  $('screen').style.aspectRatio = `${S.output[0]} / ${S.output[1]}`
}

function busy(kind, on) {
  const screen = $('screen')
  const set = (screen._busy ??= new Set())
  if (on) set.add(kind)
  else set.delete(kind)
  screen.classList.toggle('busy', set.size > 0)
}

let stillSeq = 0
async function drawStill() {
  if (S.view !== 'still') return
  const seq = ++stillSeq
  busy('still', true)
  const started = performance.now()
  try {
    const r = await api('preview', { settings: S.draft, mode: S.mode, size: previewSize() })
    if (seq !== stillSeq || S.view !== 'still') return
    if (!same(r.output, S.output)) {
      S.output = r.output
      setAspect()
    }
    S.cell = r.cell
    $('preview').src = `data:${r.type};base64,${r.image}`
    $('empty').hidden = true
    caption(`${Math.round(performance.now() - started)} ms`)
  } catch (error) {
    if (seq === stillSeq) {
      if (error.code === 'source_missing') showNote(error.message)
      fail(error)
    }
  } finally {
    if (seq === stillSeq) busy('still', false)
  }
}

let gallerySeq = 0
async function drawGallery() {
  const first = Object.values(S.galleryTiles)[0]
  if (!first) return
  const seq = ++gallerySeq
  const width = first.tile.getBoundingClientRect().width || 120
  const tile = [Math.round(width * dpr()), Math.round((width * dpr() * 9) / 16)]
  try {
    const r = await api('gallery', { settings: S.draft, mode: S.mode, focus: S.focus, tile })
    if (seq !== gallerySeq) return
    const drawn = new Set(r.tiles.map((t) => t.id))
    for (const t of r.tiles) {
      const found = S.galleryTiles[t.id]
      if (found) found.image.src = `data:image/png;base64,${t.image}`
    }
    for (const [id, found] of Object.entries(S.galleryTiles)) {
      if (drawn.has(id)) delete found.image.parentElement.dataset.placeholder
      else {
        found.image.removeAttribute('src')
        found.image.parentElement.dataset.placeholder = 'Aa+.'
      }
    }
  } catch (error) {
    if (seq === gallerySeq) fail(error)
  }
}

let detailBusy = false
let detailWanted = null
async function drawDetail() {
  if (!S.lens || !S.pointer) return
  if (detailBusy) {
    detailWanted = true
    return
  }
  detailBusy = true
  detailWanted = false
  const lens = $('lens')
  const size = [Math.round(lens.clientWidth * dpr()), Math.round(lens.clientHeight * dpr())]
  const focus = S.pointer
  try {
    if (!$('lens-image').getAttribute('src')) $('lens-label').textContent = 'Drawing the full-size picture…'
    const r = await api('detail', { settings: S.draft, mode: S.mode, focus, size })
    if (!S.lens) return
    $('lens-image').src = `data:${r.type};base64,${r.image}`
    $('lens-label').textContent = `1:1 · ${r.output[0]}×${r.output[1]} · cell ${r.cell} px`
    placeLensRect(r.rect, r.output)
  } catch (error) {
    fail(error)
  } finally {
    detailBusy = false
    if (detailWanted) drawDetail()
  }
}

function placeLensRect(rect, output) {
  const box = screenBox()
  const k = box.width / output[0]
  const r = $('lens-rect')
  r.hidden = false
  r.style.left = `${rect[0] * k}px`
  r.style.top = `${rect[1] * k}px`
  r.style.width = `${Math.max(2, rect[2] * k)}px`
  r.style.height = `${Math.max(2, rect[3] * k)}px`
}

let motionSeq = 0
async function drawMotion() {
  const seq = ++motionSeq
  const key = JSON.stringify([S.draft, S.mode])
  hideNote()
  busy('motion', true)
  showNote(isVideoSource() ? 'Drawing the first seconds of the clip… up to half a minute with small cells.' : 'Drawing the loop at preview size… a few seconds.')
  const started = performance.now()
  try {
    const r = await api('motion', { settings: S.draft, mode: S.mode, size: previewSize([960, 600]) })
    if (seq !== motionSeq || S.view !== 'motion') return
    S.motionKey = key
    $('preview').src = `data:image/webp;base64,${r.image}`
    $('empty').hidden = true
    hideNote()
    caption(`${r.frames} frames at ${r.fps} fps, drawn in ${((performance.now() - started) / 1000).toFixed(1)} s (the real loop runs at ${S.draft.fps} fps)`)
  } catch (error) {
    if (seq !== motionSeq) return
    hideNote()
    if (error.code === 'motion_off') {
      showNote(error.message)
    } else {
      fail(error)
    }
  } finally {
    if (seq === motionSeq) busy('motion', false)
  }
}

function staleMotion() {
  if (S.motionKey === JSON.stringify([S.draft, S.mode])) return hideNote()
  showNote('The loop shows older settings.', { action: 'Update', run: () => drawMotion() })
}

const previews = {
  still: debounce(drawStill, 140),
  gallery: debounce(drawGallery, 450),
  detail: debounce(drawDetail, 40)
}

function showNote(text, { action = null, run = null } = {}) {
  $('note-text').textContent = text
  const button = $('note-action')
  button.hidden = !action
  if (action) {
    button.textContent = action
    button.onclick = run
  }
  $('note').hidden = false
}

function hideNote() {
  $('note').hidden = true
}

function caption(timing = '') {
  const theme = S.mode === 'dark' ? 'ASCII Glyphscape Dark' : 'ASCII Glyphscape Light'
  const pieces = [`Preview of <strong>${theme}</strong>`, `wallpaper ${S.output[0]}×${S.output[1]}`, `cell ${S.cell} px`]
  if (timing) pieces.push(timing)
  $('caption').innerHTML = pieces.join(' · ')
  $('meta').textContent = `${S.output[0]}×${S.output[1]}`
}

function placeFocus() {
  const mark = $('focus-mark')
  mark.style.left = `${S.focus[0] * 100}%`
  mark.style.top = `${S.focus[1] * 100}%`
}

function setMode(mode) {
  if (S.mode === mode) return
  S.mode = mode
  for (const b of document.querySelectorAll('#mode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode))
  if (S.view === 'motion') drawMotion()
  else previews.still.now()
  previews.gallery()
  if (S.lens) drawDetail()
  caption()
}

function setView(view) {
  if (S.view === view) return
  S.view = view
  for (const b of document.querySelectorAll('#view button')) b.setAttribute('aria-pressed', String(b.dataset.view === view))
  hideNote()
  if (view === 'motion') {
    if (S.lens) setLens(false)
    drawMotion()
  } else {
    motionSeq++
    busy('motion', false)
    previews.still.now()
  }
}

function setLens(on) {
  S.lens = on
  $('lens-toggle').setAttribute('aria-pressed', String(on))
  $('screen').classList.toggle('lensing', on)
  if (!on) {
    $('lens').hidden = true
    $('lens-rect').hidden = true
    $('lens-image').removeAttribute('src')
  }
  if (on && S.view === 'motion') setView('still')
}

function onPointerMove(event) {
  if (!S.lens) return
  const box = screenBox()
  const x = (event.clientX - box.left) / box.width
  const y = (event.clientY - box.top) / box.height
  if (x < 0 || y < 0 || x > 1 || y > 1) return
  S.pointer = [x, y]
  const lens = $('lens')
  lens.hidden = false
  const lw = lens.offsetWidth
  const lh = lens.offsetHeight
  let left = event.clientX - box.left + 24
  let top = event.clientY - box.top + 24
  if (left + lw > box.width - 8) left = event.clientX - box.left - lw - 24
  if (top + lh > box.height - 8) top = event.clientY - box.top - lh - 24
  lens.style.left = `${Math.max(8, left)}px`
  lens.style.top = `${Math.max(8, top)}px`
  previews.detail()
}

function onScreenClick(event) {
  if (S.lens) return
  const box = screenBox()
  S.focus = [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height].map((v) => Math.min(1, Math.max(0, v)))
  placeFocus()
  previews.gallery.now()
}

function uploadFile(file) {
  if (!file) return
  const add = S.sourceGrid?.querySelector('.add')
  add?.classList.add('loading')
  const label = add?.querySelector('span')
  const xhr = new XMLHttpRequest()
  xhr.open('POST', 'upload')
  xhr.setRequestHeader('Content-Type', 'application/octet-stream')
  xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
  xhr.upload.onprogress = (event) => {
    if (label && event.lengthComputable) label.textContent = `${Math.round((event.loaded / event.total) * 100)}%`
  }
  xhr.onload = () => {
    add?.classList.remove('loading')
    let body = null
    try {
      body = JSON.parse(xhr.responseText)
    } catch {
      body = null
    }
    if (!body?.ok) {
      if (label) label.textContent = 'Upload'
      return fail(new ApiError(body?.error?.code ?? 'upload', body?.error?.message ?? `The upload failed (${xhr.status}).`))
    }
    S.sources = body.result.sources
    const item = S.sources.find((s) => s.id === body.result.id)
    renderSources()
    if (item) pickSource(item)
    toast(`${body.result.name} is in the library. Apply to use it for the themes.`)
  }
  xhr.onerror = () => {
    add?.classList.remove('loading')
    if (label) label.textContent = 'Upload'
    fail(new ApiError('upload', 'The upload failed.'))
  }
  xhr.send(file)
}

async function browseFile() {
  try {
    const r = await api('browse')
    if (r.cancelled) return
    if (r.error) return fail(new ApiError('browse', `${r.error} Upload the file here instead.`))
    S.sources = r.sources
    const item = S.sources.find((s) => s.id === r.id)
    if (item) pickSource(item)
    else renderSources()
  } catch (error) {
    fail(error)
  }
}

async function removeSource(item) {
  try {
    S.sources = await api('removeSource', { id: item.id })
    if (S.draft.source === item.path) revertSourceTo(S.applied)
    renderSources()
  } catch (error) {
    fail(error)
  }
}

function revertSourceTo(settings) {
  S.draft = { ...S.draft, source: settings.source }
  refreshFields()
  draftChanged(['source'])
}

async function apply() {
  if (S.applying || !dirtyKeys().length) return
  S.applying = true
  refreshFields()
  const sent = { ...S.draft }
  try {
    const r = await api('apply', { settings: sent })
    S.status = r.status
    S.appliedKey = r.status.settingsKey
    S.applied = { ...sent }
    if (r.render.error) fail(new ApiError('render', r.render.error))
    else toast(r.changed.length ? `Applied ${r.changed.length} change${r.changed.length > 1 ? 's' : ''}. Rendering both themes…` : 'Nothing changed.')
    const state = await api('state')
    S.applied = state.settings
    S.appliedKey = state.status.settingsKey
    if (same(S.draft, sent)) S.draft = { ...state.settings }
    S.sources = state.sources
  } catch (error) {
    fail(error)
  } finally {
    S.applying = false
    refreshFields()
    pollSoon()
  }
}

async function renderAgain() {
  try {
    const r = await api('render')
    S.status = r.status
    if (r.error) fail(new ApiError('render', r.error))
    else toast('Rendering the applied settings again…')
  } catch (error) {
    fail(error)
  }
  renderStatus()
  pollSoon()
}

function renderStatus() {
  const box = $('status')
  const text = box.querySelector('.status-text')
  const st = S.status
  const dirty = dirtyKeys().length
  let tone = 'idle'
  let message = 'Loading…'
  if (st?.phase === 'rendering') {
    tone = 'busy'
    const pct = Math.round((st.progress ?? 0) * 100)
    message = `Rendering ${pct}%${st.text ? ` · ${st.text}` : ''}`
    $('status-fill').style.width = `${pct}%`
  } else if (st?.phase === 'waiting') {
    tone = 'busy'
    message = 'A render starts in a moment…'
    $('status-fill').style.width = '0%'
  } else if (st?.phase === 'error') {
    tone = 'error'
    message = `Render failed: ${st.error}`
  } else if (dirty) {
    tone = 'dirty'
    message = `${dirty} change${dirty > 1 ? 's' : ''} not applied yet`
  } else if (st?.phase === 'ok') {
    tone = 'ok'
    const when = st.finishedAt ? new Date(st.finishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    message = `Applied${when ? ` · rendered ${when}` : ''}`
  } else if (st) {
    tone = 'idle'
    message = st.phase === 'cancelled' ? 'Render cancelled' : 'Ready'
  }
  box.dataset.tone = tone
  text.textContent = message
  box.title = st?.summary || message
}

let pollTimer = null
function pollSoon(ms = 600) {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(poll, ms)
}

async function poll() {
  try {
    const st = await api('status')
    S.status = st
    if (st.settingsKey !== S.appliedKey) await externalChange()
    hideBanner('offline')
  } catch (error) {
    if (error.code === 'offline' || error.code === 'http') showBanner(error.message, null, 'offline')
  }
  renderStatus()
  const active = S.status && (S.status.phase === 'rendering' || S.status.phase === 'waiting')
  pollSoon(active ? 800 : 4000)
}

async function externalChange() {
  const state = await api('state')
  const wasDirty = dirtyKeys().length > 0
  S.applied = state.settings
  S.appliedKey = state.status.settingsKey
  S.sources = state.sources
  if (!wasDirty) {
    S.draft = { ...state.settings }
    refreshFields()
    draftChanged(['source'])
    toast('The settings were changed on Orca’s Settings page; the editor follows them.')
  } else {
    refreshFields()
    showBanner('The settings were changed on Orca’s Settings page while you have changes here.', {
      label: 'Load them',
      run: () => {
        hideBanner()
        revert()
      }
    })
  }
}

function showBanner(text, action = null, kind = 'change') {
  $('banner-text').textContent = text
  const button = $('banner-action')
  button.hidden = !action
  if (action) {
    button.textContent = action.label
    button.onclick = action.run
  }
  $('banner').dataset.kind = kind
  $('banner').hidden = false
}

function hideBanner(kind = null) {
  if (kind && $('banner').dataset.kind !== kind) return
  $('banner').hidden = true
}

function wire() {
  for (const b of document.querySelectorAll('#mode button')) b.addEventListener('click', () => setMode(b.dataset.mode))
  for (const b of document.querySelectorAll('#view button')) b.addEventListener('click', () => setView(b.dataset.view))
  $('lens-toggle').addEventListener('click', () => setLens(!S.lens))
  $('apply').addEventListener('click', apply)
  $('revert').addEventListener('click', revert)
  const screen = $('screen')
  screen.addEventListener('pointermove', onPointerMove)
  screen.addEventListener('pointerleave', () => {
    if (S.lens) $('lens').hidden = true
  })
  screen.addEventListener('click', onScreenClick)
  $('file-input').addEventListener('change', (event) => {
    uploadFile(event.target.files?.[0])
    event.target.value = ''
  })
  let depth = 0
  document.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return
    depth++
    $('drop').hidden = false
  })
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (!depth) $('drop').hidden = true
  })
  document.addEventListener('dragover', (event) => event.preventDefault())
  document.addEventListener('drop', (event) => {
    event.preventDefault()
    depth = 0
    $('drop').hidden = true
    uploadFile(event.dataTransfer?.files?.[0])
  })
  const help = $('help')
  $('help-button').addEventListener('click', (event) => {
    event.stopPropagation()
    help.hidden = !help.hidden
    $('help-button').setAttribute('aria-expanded', String(!help.hidden))
  })
  document.addEventListener('click', (event) => {
    if (!help.hidden && !help.contains(event.target)) {
      help.hidden = true
      $('help-button').setAttribute('aria-expanded', 'false')
    }
  })
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      apply()
    } else if (event.key === 'Escape') {
      help.hidden = true
      if (S.lens) setLens(false)
    } else if ((event.key === 'l' || event.key === 'L') && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')) {
      setLens(!S.lens)
    }
  })
  window.addEventListener('beforeunload', (event) => {
    if (dirtyKeys().length) event.preventDefault()
  })
  const resized = debounce(() => {
    if (S.view === 'still') drawStill()
    previews.gallery()
  }, 300)
  new ResizeObserver(resized).observe(screen)
}

async function start() {
  wire()
  try {
    const state = await api('state')
    S.schema = state.schema
    S.defaults = state.defaults
    S.applied = state.settings
    S.appliedKey = state.status.settingsKey
    S.draft = { ...state.settings }
    S.sources = state.sources
    S.status = state.status
    S.checklist = state.checklist
    $('help-list').replaceChildren(...state.checklist.split('\n').map((line) => el('li', { text: line.replace(/^\d+\.\s*/, '') })))
    buildPanel()
    refreshFields()
    placeFocus()
    try {
      const info = await api('info', { settings: S.draft })
      S.output = info.output
      S.cell = info.cell
      setAspect()
    } catch (error) {
      fail(error)
    }
    caption()
    drawStill()
    drawGallery()
    pollSoon(1500)
  } catch (error) {
    $('empty').textContent = error.message
    fail(error)
  }
}

start()
