import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { RpcError, createEditorServer } from './editor-server.mjs'
import { findOrcaCli, runOrcaCli } from './output.mjs'
import { isMedia } from './picker.mjs'
import { readJson, writeJson } from './paths.mjs'
import { createPreviewer } from './preview.mjs'
import { DEFAULTS, SETTINGS, normalizeSettings, renderSettings } from './settings.mjs'

export const EDITOR_KEYS = Object.freeze(SETTINGS.map((s) => s.key).filter((key) => !['autoRender', 'python', 'outputDir'].includes(key)))
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'])
const THUMB_SIZE = [320, 200]
const THUMBS_KEEP = 64
const MODES = new Set(['dark', 'light'])

export function sourceId(path) {
  return createHash('sha1').update(String(path)).digest('hex').slice(0, 16)
}

export function displayName(file) {
  return String(file).replace(/^[0-9a-f]{10}-/, '')
}

export function isVideo(path) {
  return VIDEO_EXT.has(extname(String(path)).slice(1).toLowerCase())
}

export function editable(input) {
  const out = {}
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of EDITOR_KEYS) if (Object.hasOwn(input, key)) out[key] = input[key]
  }
  return out
}

function settingsKey(settings) {
  return createHash('sha1').update(JSON.stringify(EDITOR_KEYS.map((k) => settings[k]))).digest('hex').slice(0, 16)
}

function sizeArg(value, fallback) {
  return Array.isArray(value) && value.length === 2 && value.every((v) => Number.isFinite(v)) ? value.map((v) => Math.round(v)) : fallback
}

function focusArg(value) {
  return Array.isArray(value) && value.length === 2 && value.every((v) => Number.isFinite(v)) ? value.map((v) => Math.min(1, Math.max(0, v))) : [0.5, 0.5]
}

export function createEditor({ pluginRoot, paths, host, log = () => {}, deps = {} }) {
  const d = { findOrcaCli, runOrcaCli, createPreviewer, createEditorServer, ...deps }
  const stateFile = join(paths.root, 'editor.json')
  const thumbsDir = join(paths.root, 'thumbs')
  const known = new Map()

  const previewer = d.createPreviewer({
    script: join(pluginRoot, 'tools', 'ascii_preview.py'),
    findPython: () => host.findPython(),
    env: () => host.env(),
    log
  })

  function remember(path) {
    const id = sourceId(path)
    known.set(id, path)
    return id
  }

  function draftOf(input) {
    return normalizeSettings({ ...host.settings(), ...editable(input?.settings) })
  }

  function configOf(input) {
    const s = draftOf(input)
    return { ...renderSettings(s), source: host.sourcePath(s) }
  }

  async function ask(op, payload, channel = op) {
    const answer = await previewer.request(op, payload, { channel })
    if (!answer.ok) throw new RpcError(answer.code || 'preview_failed', answer.error || 'The preview failed.')
    const { id, ok, ...rest } = answer
    return rest
  }

  async function listSources() {
    const applied = host.settings()
    const items = []
    for (const [sample, path] of Object.entries(host.samples)) {
      items.push({ id: remember(path), kind: 'sample', sample, name: 'Sample', path, video: false })
    }
    let names = []
    try {
      names = await readdir(paths.library)
    } catch {
      names = []
    }
    const library = []
    for (const name of names) {
      if (name.startsWith('.') || !isMedia(name)) continue
      const path = join(paths.library, name)
      try {
        const info = await stat(path)
        if (info.isFile()) library.push({ id: remember(path), kind: 'library', name: displayName(name), path, video: isVideo(name), size: info.size, mtime: Math.round(info.mtimeMs) })
      } catch {
      }
    }
    library.sort((a, b) => b.mtime - a.mtime)
    items.push(...library)
    if (applied.source && !items.some((item) => item.path === applied.source)) {
      try {
        const info = await stat(applied.source)
        if (info.isFile()) items.push({ id: remember(applied.source), kind: 'external', name: applied.source.split('/').pop(), path: applied.source, video: isVideo(applied.source), size: info.size })
      } catch {
      }
    }
    return items
  }

  function statusInfo() {
    const { view, last } = host.status()
    const applied = host.settings()
    return {
      phase: view.phase,
      progress: view.progress ?? null,
      text: view.text ?? '',
      error: view.error ?? '',
      finishedAt: last?.finishedAt ?? null,
      summary: last?.result ? host.summary(last.result) : '',
      settingsKey: settingsKey(applied)
    }
  }

  async function thumb(id) {
    const path = known.get(id)
    if (!path) return null
    const info = await stat(path)
    const file = join(thumbsDir, `${id}-${Math.round(info.mtimeMs)}.jpg`)
    try {
      return { type: 'image/jpeg', data: await readFile(file) }
    } catch {
    }
    const answer = await ask('thumb', { path, size: THUMB_SIZE }, `thumb:${id}`)
    const data = Buffer.from(answer.image, 'base64')
    await mkdir(thumbsDir, { recursive: true })
    await writeFile(file, data)
    pruneThumbs().catch(() => undefined)
    return { type: 'image/jpeg', data }
  }

  async function pruneThumbs() {
    const names = await readdir(thumbsDir)
    if (names.length <= THUMBS_KEEP) return
    const entries = await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(join(thumbsDir, name)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })))
    entries.sort((a, b) => b.mtime - a.mtime)
    for (const entry of entries.slice(THUMBS_KEEP)) await rm(join(thumbsDir, entry.name), { force: true })
  }

  async function upload(request, { name, size }) {
    if (!isMedia(name)) throw new RpcError('unsupported', `${name} is not a picture or video this plugin reads.`)
    await mkdir(paths.library, { recursive: true })
    const part = join(paths.library, `.upload-${randomBytes(6).toString('hex')}.part`)
    const hash = createHash('sha1')
    let got = 0
    try {
      await pipeline(
        request,
        async function* count(source) {
          for await (const chunk of source) {
            got += chunk.length
            if (got > size) throw new RpcError('invalid_request', 'The upload is longer than it said.')
            hash.update(chunk)
            yield chunk
          }
        },
        createWriteStream(part, { flags: 'wx' })
      )
      if (got !== size) throw new RpcError('incomplete', 'The upload stopped before the end of the file.')
      const safe = name.split(/[\\/]/).pop().replace(/[^\w.\-]+/g, '_').slice(-80)
      const target = join(paths.library, `${hash.digest('hex').slice(0, 10)}-${safe}`)
      try {
        await stat(target)
        await rm(part, { force: true })
      } catch {
        await rename(part, target)
      }
      await host.pruneLibrary([target, host.settings().source])
      return { id: remember(target), path: target, name: displayName(safe), sources: await listSources() }
    } catch (error) {
      await rm(part, { force: true }).catch(() => undefined)
      throw error
    }
  }

  const handlers = {
    async state() {
      await host.loadSettings()
      const applied = host.settings()
      return {
        settings: Object.fromEntries(EDITOR_KEYS.map((k) => [k, applied[k]])),
        defaults: Object.fromEntries(EDITOR_KEYS.map((k) => [k, DEFAULTS[k]])),
        schema: SETTINGS.filter((s) => EDITOR_KEYS.includes(s.key)),
        samples: Object.fromEntries(Object.entries(host.samples).map(([k, path]) => [k, remember(path)])),
        sources: await listSources(),
        status: statusInfo(),
        checklist: host.checklist()
      }
    },
    async info(input) {
      return ask('info', { cfg: configOf(input) })
    },
    async preview(input) {
      return ask('preview', { cfg: configOf(input), mode: MODES.has(input.mode) ? input.mode : 'dark', size: sizeArg(input.size, [1280, 720]) })
    },
    async detail(input) {
      return ask('detail', { cfg: configOf(input), mode: MODES.has(input.mode) ? input.mode : 'dark', focus: focusArg(input.focus), size: sizeArg(input.size, [480, 300]) })
    },
    async gallery(input) {
      return ask('gallery', { cfg: configOf(input), mode: MODES.has(input.mode) ? input.mode : 'dark', focus: focusArg(input.focus), tile: sizeArg(input.tile, [192, 108]) })
    },
    async motion(input) {
      return ask('motion', { cfg: configOf(input), mode: MODES.has(input.mode) ? input.mode : 'dark', size: sizeArg(input.size, [640, 360]) })
    },
    async apply(input) {
      const result = await host.apply(editable(input?.settings))
      return { ...result, status: statusInfo() }
    },
    async render() {
      const result = await host.render({ force: true, reason: 'editor' })
      return { started: Boolean(result?.started), error: result?.error ?? '', status: statusInfo() }
    },
    async status() {
      return statusInfo()
    },
    async sources() {
      return listSources()
    },
    async browse() {
      const picked = await host.browse()
      if (picked.path) return { id: remember(picked.path), path: picked.path, sources: await listSources() }
      return picked
    },
    async removeSource(input) {
      const path = known.get(String(input?.id ?? ''))
      if (!path || !path.startsWith(`${paths.library}/`)) throw new RpcError('invalid_request', 'Only files in the library can be removed.')
      if (path === host.settings().source) throw new RpcError('in_use', 'This file is the applied source; apply another one first.')
      await rm(path, { force: true })
      return listSources()
    }
  }

  const server = d.createEditorServer({
    root: join(pluginRoot, 'editor'),
    stateFile,
    call: (name, input) => handlers[name](input),
    has: (name) => Object.hasOwn(handlers, name),
    thumb,
    upload,
    log
  })

  async function open() {
    const { url } = await server.ensure()
    const cli = await d.findOrcaCli()
    if (!cli) return { ok: false, url, message: 'Orca’s command line was not found next to Orca.' }
    const stored = (await readJson(stateFile)) ?? {}
    if (stored.page) {
      const list = await d.runOrcaCli(['tab', 'list'], { cli })
      const tab = list.json?.result?.tabs?.find((t) => t.browserPageId === stored.page)
      if (tab) {
        const switched = await d.runOrcaCli(['tab', 'switch', '--page', stored.page, '--focus'], { cli })
        if (switched.json?.ok) {
          if (!String(tab.url ?? '').startsWith(url)) await d.runOrcaCli(['goto', '--url', url], { cli })
          return { ok: true, url, reused: true }
        }
      }
    }
    const created = await d.runOrcaCli(['tab', 'create', '--url', url], { cli })
    const page = created.json?.result?.browserPageId
    if (created.json?.ok && page) {
      await writeJson(stateFile, { ...((await readJson(stateFile)) ?? {}), page })
      return { ok: true, url, reused: false }
    }
    return { ok: false, url, message: created.json?.error?.message ?? (created.out.trim().slice(-300) || 'Orca did not open a tab.') }
  }

  return {
    open,
    handlers,
    resume: () => server.resume(),
    get running() {
      return server.running
    },
    async dispose() {
      previewer.dispose()
      await server.dispose()
    }
  }
}
