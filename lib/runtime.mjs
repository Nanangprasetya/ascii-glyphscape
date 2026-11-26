import { createHash } from 'node:crypto'
import { copyFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { EDITOR_KEYS, createEditor } from './editor.mjs'
import { cancelJob, jobFiles, jobStatus, startJob, sweepJobs } from './jobs.mjs'
import { PACK_KEY, installPack, resolveOutput } from './output.mjs'
import { dataDir, ensureLayout, layout, readJson, writeJson } from './paths.mjs'
import { chooseFile, isMedia } from './picker.mjs'
import { findPython, forgetPython, run } from './python.mjs'
import { childEnv } from './session-env.mjs'
import { DEFAULTS, SETTINGS, invalidColours, normalizeSettings, renderSettings } from './settings.mjs'
import { STATUS_ITEM_ID, clamp, statusView } from './status.mjs'

export const PLUGIN_VERSION = '1.0.0'
export const RENDERER_VERSION = 2
export const COMMANDS = Object.freeze(['open-editor', 'choose-media', 'render-now', 'cancel-render', 'reset-settings', 'setup-checklist'])
export const NO_SOURCE = 'No picture or video is set yet. Run "ASCII Glyphscape: Open editor" to upload one, or "ASCII Glyphscape: Choose image or video" to pick a file.'
const DEBOUNCE_MS = 1200
const START_DELAY_MS = 1500
const POLL_MS = 400
const NOTICE_DELAY_MS = 2500
const LIBRARY_KEEP = 8
const COPY_MAX_BYTES = 512 * 1024 * 1024
const NOTIFY_TITLE_MAX = 120
const NOTIFY_BODY_MAX = 1000
const MACHINE_SETTINGS = new Set(['python', 'outputDir'])

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

export function configHash(config, source) {
  const { jobFile, cleanup, ...rest } = config
  const keys = Object.keys(rest).sort()
  const stable = JSON.stringify({ renderer: RENDERER_VERSION, config: keys.map((k) => [k, rest[k]]), source })
  return createHash('sha256').update(stable).digest('hex')
}

export function summary(result) {
  if (!result?.ok) return result?.error || 'The render failed.'
  const size = Array.isArray(result.size) ? `${result.size[0]}×${result.size[1]}` : ''
  const video = result.videoSize ? ` with a ${result.videoSize[0]}×${result.videoSize[1]} video loop` : ''
  const notes = (result.notes ?? []).join(' ')
  return `Rendered the dark and light themes at ${size}${video}.${notes ? ` ${notes}` : ''}`
}

export function checklist(probe, { first = false } = {}) {
  const lines = []
  if (first) lines.push('ASCII Glyphscape is ready. To see the wallpaper:')
  lines.push('1. Settings > Appearance > Theme: choose "ASCII Glyphscape Dark" or "ASCII Glyphscape Light" from ASCII Glyphscape Output (terminal theme: the same names).')
  lines.push('2. Settings > Appearance > Interface > Advanced and Terminal > Advanced: set Background Opacity below 1 (try 0.6). At 1 Orca paints no wallpaper.')
  lines.push('3. Turn Reduce Visual Effects off. Videos play while the Orca window has focus.')
  lines.push('4. Orca shows the wallpaper through terminals and chats; sidebars stay solid (Orca cannot blur them). Tune them with the Sidebar settings.')
  if (probe) {
    const parts = [
      probe.pillow ? `Python ${probe.python} with Pillow ${probe.pillow}` : 'Python with Pillow: missing',
      probe.x264 ? 'ffmpeg with libx264' : 'ffmpeg with libx264: missing (no motion or video)',
      Array.isArray(probe.screen) ? `screen ${probe.screen[0]}×${probe.screen[1]}` : 'screen size: unknown'
    ]
    lines.push(`This machine: ${parts.join(', ')}.`)
  }
  return lines.join('\n')
}

export function createRuntime(orca, { pluginRoot, deps = {} }) {
  const d = {
    now: Date.now,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    startJob,
    jobStatus,
    cancelJob,
    sweepJobs,
    findPython,
    chooseFile,
    childEnv,
    resolveOutput,
    installPack,
    createEditor,
    run,
    home: os.homedir(),
    dataRoot: dataDir(),
    ...deps
  }
  const paths = layout(d.dataRoot)
  const cli = join(pluginRoot, 'tools', 'ascii_cli.py')
  let settings = normalizeSettings(DEFAULTS)
  let persisted = { lastHash: null, last: null, current: null, welcomed: false, notices: [], packDir: null }
  let packSynced = false
  let view = { phase: 'idle' }
  let lastStatus = ''
  let debounce = null
  let poll = null
  let polling = false
  let subscription = null
  let disposed = false
  let chain = Promise.resolve()
  let ready = Promise.resolve()
  let editor = null

  const log = (message) => {
    try {
      orca.log(message)
    } catch {
    }
  }

  function pushStatus() {
    const next = statusView(view)
    const key = JSON.stringify(next)
    if (key === lastStatus || disposed) return
    lastStatus = key
    Promise.resolve()
      .then(() => orca.host.call('statusBar.update', { id: STATUS_ITEM_ID, ...next }))
      .catch((error) => {
        if (lastStatus === key) lastStatus = ''
        log(`status bar update failed: ${describe(error)}`)
      })
  }

  function setView(next) {
    view = next
    pushStatus()
  }

  async function notify(title, body, { keep = false } = {}) {
    const params = { title: clamp(title, NOTIFY_TITLE_MAX), ...(body ? { body: String(body).slice(0, NOTIFY_BODY_MAX) } : {}) }
    try {
      await orca.host.call('notifications.show', params)
      return true
    } catch (error) {
      log(`notification failed: ${describe(error)}`)
      if (keep) {
        persisted.notices = [...(persisted.notices ?? []), params].slice(-3)
        await saveState()
      }
      return false
    }
  }

  async function deliverNotices() {
    const pending = persisted.notices ?? []
    if (!pending.length) return
    persisted.notices = []
    await saveState()
    for (const params of pending) await notify(params.title, params.body, { keep: true })
  }

  async function saveState() {
    try {
      await writeJson(paths.state, persisted)
    } catch (error) {
      log(`state could not be saved: ${describe(error)}`)
    }
  }

  async function loadSettings() {
    let raw = {}
    try {
      raw = (await orca.settings.get()) ?? {}
    } catch (error) {
      log(`settings could not be read: ${describe(error)}`)
    }
    settings = normalizeSettings({ ...DEFAULTS, ...raw })
    return { settings, raw }
  }

  function sourcePath(s) {
    return s.source
  }

  async function sourceInfo(path) {
    try {
      const info = await stat(path)
      if (!info.isFile()) return null
      return { path, size: info.size, mtimeMs: Math.round(info.mtimeMs) }
    } catch {
      return null
    }
  }

  async function outputsExist(dir, last) {
    const themes = last?.result?.themes
    if (!themes) return false
    for (const entry of Object.values(themes)) {
      for (const rel of [entry.image, entry.video]) {
        if (!rel) continue
        try {
          await stat(join(dir, rel))
        } catch {
          return false
        }
      }
    }
    return true
  }

  function stopPolling() {
    if (poll) d.clearInterval(poll)
    poll = null
  }

  function watch() {
    stopPolling()
    poll = d.setInterval(() => {
      if (polling) return
      polling = true
      tick()
        .catch((error) => log(`job check failed: ${describe(error)}`))
        .finally(() => {
          polling = false
        })
    }, POLL_MS)
    poll?.unref?.()
  }

  async function tick() {
    const current = persisted.current
    if (!current) return stopPolling()
    const files = jobFiles(paths.jobs, current.id)
    const status = await d.jobStatus(files.job, current.pid)
    if (persisted.current !== current) return
    if (status.state === 'running') {
      setView({ phase: 'rendering', progress: status.progress, text: status.text })
      return
    }
    if (status.state === 'done') return finish(current, status.result ?? { ok: false, error: 'The renderer gave no result.' })
    return finish(current, { ok: false, error: `The renderer stopped unexpectedly. Its log: ${files.log}` })
  }

  async function finish(current, result) {
    stopPolling()
    if (persisted.current !== current) return
    persisted.current = null
    if (result?.ok) {
      persisted.lastHash = current.hash
      persisted.last = { result, finishedAt: d.now(), hash: current.hash, outDir: current.outDir }
      setView({ phase: 'ok', finishedAt: d.now(), size: result.size, video: Boolean(result.videoSize) })
      await syncPack(current.outDir)
      const first = !persisted.welcomed
      persisted.welcomed = true
      if (first) await notify('ASCII Glyphscape: wallpaper rendered', `${summary(result)}\n\n${checklist(null, { first: true })}`, { keep: true })
      else if (current.reason === 'command') await notify('ASCII Glyphscape', summary(result), { keep: true })
      log(`render ${current.id} done in ${result.elapsedMs ?? '?'} ms: ${summary(result)}`)
    } else if (result?.cancelled) {
      setView({ phase: 'cancelled' })
      log(`render ${current.id} cancelled`)
    } else {
      const error = result?.error || 'The render failed.'
      setView({ phase: 'error', error })
      await notify('ASCII Glyphscape: render failed', error, { keep: true })
      log(`render ${current.id} failed: ${error}`)
    }
    await saveState()
    d.sweepJobs(paths.jobs, { keep: [current.id] }).catch(() => undefined)
  }

  async function syncPack(dir) {
    const moved = Boolean(persisted.packDir && persisted.packDir !== dir)
    const result = await d.installPack(dir, { moved }).catch((error) => ({ ok: false, message: describe(error) }))
    if (result.ok) {
      packSynced = true
      if (persisted.packDir !== dir) {
        persisted.packDir = dir
        await saveState()
      }
      log(`theme pack ${PACK_KEY} ${result.status ?? 'updated'}${result.contentHash ? ` (${result.contentHash.slice(0, 12)})` : ''}`)
      return true
    }
    await notify('ASCII Glyphscape', `The themes were rendered into ${dir}, but Orca could not take them in: ${result.message} Install them yourself with: orca plugin install "${dir}"`, { keep: true })
    log(`theme pack install failed: ${result.message}`)
    return false
  }

  async function cancelCurrent() {
    const current = persisted.current
    if (!current) return false
    stopPolling()
    persisted.current = null
    await saveState()
    await d.cancelJob(current.pid, jobFiles(paths.jobs, current.id).job)
    log(`render ${current.id} stopped`)
    return true
  }

  async function startRender({ force = false, reason = 'settings' } = {}) {
    if (disposed) return { started: false }
    const { raw } = await loadSettings()
    const s = settings
    const badColours = invalidColours(raw)
    if (!s.source) {
      setView({ phase: 'empty' })
      if (!persisted.introduced) {
        persisted.introduced = true
        await saveState()
        await notify('ASCII Glyphscape', NO_SOURCE, { keep: true })
      }
      return { started: false, empty: true, error: NO_SOURCE }
    }
    const source = await sourceInfo(sourcePath(s))
    if (!source) {
      const error = `The source was not found: ${sourcePath(s)}. Choose another with "ASCII Glyphscape: Choose image or video".`
      if (!persisted.current) setView({ phase: 'error', error })
      await notify('ASCII Glyphscape', error)
      return { started: false, error }
    }
    let out
    try {
      out = await d.resolveOutput({ pluginRoot, setting: s.outputDir, packDir: paths.pack, version: PLUGIN_VERSION })
    } catch (error) {
      setView({ phase: 'error', error: describe(error) })
      await notify('ASCII Glyphscape', describe(error))
      return { started: false, error: describe(error) }
    }
    const config = { ...renderSettings(s), source: source.path, outDir: out.dir }
    const hash = configHash(config, { size: source.size, mtimeMs: source.mtimeMs })
    if (!force && hash === persisted.lastHash && !persisted.current && (await outputsExist(out.dir, persisted.last))) {
      setView({ phase: 'ok', finishedAt: persisted.last?.finishedAt, size: persisted.last?.result?.size, video: Boolean(persisted.last?.result?.videoSize) })
      if (!packSynced) await syncPack(out.dir)
      return { started: false, upToDate: true }
    }
    if (!force && persisted.current?.hash === hash) return { started: false, running: true }
    await cancelCurrent()
    const env = await d.childEnv()
    const python = await d.findPython(s.python, { env })
    if (!python) {
      const error = 'No Python 3 with Pillow was found. Install it (Arch: sudo pacman -S python-pillow; Debian/Ubuntu: sudo apt install python3-pil) or set Advanced > Python with Pillow.'
      setView({ phase: 'error', error })
      await notify('ASCII Glyphscape', error)
      return { started: false, error }
    }
    if (badColours.length) await notify('ASCII Glyphscape', `Ignored colours that are not hex (#rrggbb): ${badColours.join(', ')}.`)
    let job
    try {
      job = await d.startJob({ python, cli, jobsDir: paths.jobs, config, env })
    } catch (error) {
      setView({ phase: 'error', error: describe(error) })
      await notify('ASCII Glyphscape', `The renderer could not be started: ${describe(error)}`)
      return { started: false, error: describe(error) }
    }
    persisted.current = { id: job.id, pid: job.pid, hash, startedAt: d.now(), outDir: out.dir, reason }
    await saveState()
    setView({ phase: 'rendering', progress: 0, text: 'Starting' })
    log(`render ${job.id} started (pid ${job.pid}, ${reason}) into ${out.dir}`)
    watch()
    return { started: true, id: job.id }
  }

  function requestRender(options) {
    const next = chain.then(() => ready).then(() => startRender(options))
    chain = next.catch((error) => {
      log(`render request failed: ${describe(error)}`)
      setView({ phase: 'error', error: describe(error) })
    })
    return next
  }

  function scheduleRender(delay = DEBOUNCE_MS) {
    if (debounce) d.clearTimeout(debounce)
    if (!persisted.current) setView({ phase: 'waiting' })
    debounce = d.setTimeout(() => {
      debounce = null
      requestRender({ reason: 'settings' }).catch(() => undefined)
    }, delay)
    debounce?.unref?.()
  }

  async function libraryCopy(path) {
    const info = await stat(path)
    if (info.size > COPY_MAX_BYTES) return { path, copied: false }
    const tag = createHash('sha1').update(`${path}|${info.size}|${info.mtimeMs}`).digest('hex').slice(0, 10)
    const safe = basename(path).replace(/[^\w.\-]+/g, '_').slice(-80)
    const target = join(paths.library, `${tag}-${safe}`)
    try {
      await stat(target)
    } catch {
      await copyFile(path, target)
    }
    return { path: target, copied: true }
  }

  async function pruneLibrary(keep = []) {
    const kept = new Set((Array.isArray(keep) ? keep : [keep]).filter(Boolean))
    let names = []
    try {
      names = await readdir(paths.library)
    } catch {
      return
    }
    const entries = []
    for (const name of names) {
      const path = join(paths.library, name)
      try {
        entries.push({ path, mtime: (await stat(path)).mtimeMs })
      } catch {
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime)
    for (const entry of entries.slice(LIBRARY_KEEP)) {
      if (!kept.has(entry.path)) await rm(entry.path, { force: true }).catch(() => undefined)
    }
  }

  async function setSetting(key, value) {
    await orca.settings.set(key, value)
  }

  async function browse() {
    await ready
    const env = await d.childEnv()
    const start = settings.source ? dirname(settings.source) : join(d.home, 'Pictures')
    const picked = await d.chooseFile({ run: d.run, env, home: d.home, start })
    if (picked.cancelled) return { cancelled: true }
    if (picked.error) return { error: `No file dialog could be shown (${picked.error}).` }
    if (!isMedia(picked.path)) return { error: `${basename(picked.path)} is not a picture or video this plugin reads (${extname(picked.path) || 'no extension'}).` }
    try {
      const chosen = await libraryCopy(picked.path)
      await pruneLibrary([chosen.path, settings.source])
      return { ...chosen, name: basename(picked.path) }
    } catch (error) {
      return { error: `The file could not be read: ${describe(error)}` }
    }
  }

  async function chooseMedia() {
    const picked = await browse()
    if (picked.cancelled) return 'No file chosen.'
    if (picked.error) return `${picked.error} Type the full path into Settings > Plugins > ASCII Glyphscape > Source instead.`
    await setSetting('source', picked.path)
    if (!settings.autoRender) await requestRender({ force: true, reason: 'command' })
    const note = picked.copied ? '' : ' It is larger than 512 MB, so it is used where it is; keep it there.'
    return `Source set to ${picked.name}. Rendering…${note}`
  }

  async function applyDraft(draft) {
    await ready
    await loadSettings()
    const next = normalizeSettings({ ...settings, ...draft })
    const changed = []
    for (const key of EDITOR_KEYS) {
      if (JSON.stringify(next[key]) !== JSON.stringify(settings[key])) {
        await setSetting(key, next[key])
        changed.push(key)
      }
    }
    await loadSettings()
    const render = await requestRender({ reason: 'editor' })
    return { changed, render: { started: Boolean(render?.started), upToDate: Boolean(render?.upToDate), running: Boolean(render?.running), error: render?.error ?? '' } }
  }

  function getEditor() {
    editor ??= d.createEditor({
      pluginRoot,
      paths,
      log,
      host: {
        settings: () => settings,
        loadSettings,
        sourcePath,
        apply: applyDraft,
        render: (options) => requestRender(options),
        status: () => ({ view, last: persisted.last }),
        summary,
        checklist: () => checklist(null),
        browse,
        pruneLibrary,
        findPython: async () => d.findPython(settings.python, { env: await d.childEnv() }),
        env: () => d.childEnv()
      }
    })
    return editor
  }

  async function openEditor() {
    await ready
    const opened = await getEditor().open()
    if (opened.ok) return opened.reused ? 'The ASCII Glyphscape editor is open in Orca\u2019s browser.' : 'Opened the ASCII Glyphscape editor in Orca\u2019s browser.'
    log(`editor tab could not be opened: ${opened.message}`)
    return `The editor could not be opened in a tab (${opened.message}). Open this address in Orca\u2019s browser: ${opened.url}`
  }

  async function resetSettings() {
    await ready
    for (const spec of SETTINGS) {
      if (!MACHINE_SETTINGS.has(spec.key)) await setSetting(spec.key, spec.default)
    }
    await loadSettings()
    if (!settings.autoRender) await requestRender({ force: true, reason: 'command' })
    return 'ASCII Glyphscape settings are back to their defaults. Rendering…'
  }

  async function setupChecklist() {
    await ready
    const env = await d.childEnv()
    const python = await d.findPython(settings.python, { env })
    let probe = null
    if (python) {
      const result = await d.run(python, ['-I', '-B', cli, 'probe', ''], { env, timeoutMs: 30_000 })
      try {
        probe = JSON.parse(result.stdout.trim().split('\n').pop())
      } catch {
        probe = null
      }
    }
    return checklist(probe ?? { pillow: null, x264: false, screen: null })
  }

  function command(id, handler) {
    orca.commands.register(id, async () => {
      try {
        return await handler()
      } catch (error) {
        log(`${id} failed: ${describe(error)}`)
        return `ASCII Glyphscape: ${describe(error)}`
      }
    })
  }

  function register() {
    command('open-editor', openEditor)
    command('choose-media', chooseMedia)
    command('render-now', async () => {
      const result = await requestRender({ force: true, reason: 'command' })
      return result.started ? 'Rendering the ASCII Glyphscape themes… Progress shows in the status bar.' : result.error || 'Nothing to render.'
    })
    command('cancel-render', async () => {
      await ready
      const stopped = await cancelCurrent()
      if (stopped) setView({ phase: 'cancelled' })
      return stopped ? 'Render cancelled.' : 'No render is running.'
    })
    command('reset-settings', resetSettings)
    command('setup-checklist', setupChecklist)
  }

  async function boot() {
    await ensureLayout(paths)
    persisted = { ...persisted, ...((await readJson(paths.state)) ?? {}) }
    await loadSettings()
    log(`worker started (data: ${paths.root})`)
    if ((persisted.notices ?? []).length) {
      const timer = d.setTimeout(() => {
        deliverNotices().catch((error) => log(`notices failed: ${describe(error)}`))
      }, NOTICE_DELAY_MS)
      timer?.unref?.()
    }
    if (typeof orca.settings?.onDidChange === 'function') {
      subscription = orca.settings.onDidChange(() => {
        loadSettings()
          .then(() => {
            if (settings.autoRender) scheduleRender()
          })
          .catch((error) => log(`settings reload failed: ${describe(error)}`))
      })
    }
    const current = persisted.current
    if (current) {
      const status = await d.jobStatus(jobFiles(paths.jobs, current.id).job, current.pid)
      if (status.state === 'running') {
        setView({ phase: 'rendering', progress: status.progress, text: status.text })
        watch()
        return
      }
      await tick()
    }
    if (view.phase === 'idle' && persisted.last && !persisted.current) {
      setView({ phase: 'ok', finishedAt: persisted.last.finishedAt, size: persisted.last.result?.size, video: Boolean(persisted.last.result?.videoSize) })
    } else {
      pushStatus()
    }
    if (settings.autoRender) scheduleRender(START_DELAY_MS)
    getEditor()
      .resume()
      .catch((error) => log(`editor could not resume: ${describe(error)}`))
  }

  return {
    register,
    start() {
      ready = boot().catch((error) => {
        log(`start failed: ${describe(error)}`)
        setView({ phase: 'error', error: describe(error) })
      })
      return ready
    },
    requestRender,
    get view() {
      return view
    },
    get state() {
      return persisted
    },
    get editor() {
      return editor
    },
    async dispose() {
      disposed = true
      await editor?.dispose().catch(() => undefined)
      stopPolling()
      if (debounce) d.clearTimeout(debounce)
      try {
        subscription?.dispose?.()
      } catch {
      }
    },
    _forgetPython: forgetPython
  }
}
