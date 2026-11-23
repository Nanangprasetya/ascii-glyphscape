import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readJson, writeJson } from './paths.mjs'

export const PACK_ID = 'ascii-themes-output'
export const PACK_KEY = `local.${PACK_ID}`
export const THEMES = Object.freeze([
  { id: 'ascii-dark', title: 'ASCII Glyphscape Dark', mode: 'dark' },
  { id: 'ascii-light', title: 'ASCII Glyphscape Light', mode: 'light' }
])
export const SEED = 'assets/pack'
const SUBDIRS = ['images', 'themes', 'terminal']
const CLI_ENTRY = ['app.asar.unpacked', 'out', 'cli', 'index.js']

async function canWrite(path) {
  try {
    await access(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function packManifest({ version }) {
  return {
    $schema: 'https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json',
    manifestVersion: 2,
    execution: 'data',
    id: PACK_ID,
    name: 'ASCII Glyphscape Output',
    version,
    description: 'The wallpaper themes rendered by ASCII Glyphscape. Change them in Settings > Plugins > ASCII Glyphscape; this plugin is rewritten after every render.',
    license: 'MIT',
    engines: { orca: '>=1.4.254' },
    contributes: {
      themes: THEMES.map(({ id, title, mode }) => ({ id, title, path: `themes/ascii-${mode}.json` })),
      terminalThemes: THEMES.map(({ id, title, mode }) => ({ id: `${id}-term`, title, path: `terminal/ascii-${mode}.json` }))
    }
  }
}

export async function seedPack(dir, pluginRoot, { version }) {
  for (const sub of SUBDIRS) await mkdir(join(dir, sub), { recursive: true })
  const manifest = join(dir, 'orca-plugin.json')
  const current = await readJson(manifest)
  const wanted = packManifest({ version })
  if (JSON.stringify(current) !== JSON.stringify(wanted)) await writeJson(manifest, wanted)
  for (const sub of SUBDIRS) {
    let names = []
    try {
      names = await readdir(join(pluginRoot, SEED, sub))
    } catch {
      continue
    }
    for (const name of names) {
      const target = join(dir, sub, name)
      try {
        await access(target)
      } catch {
        await copyFile(join(pluginRoot, SEED, sub, name), target)
      }
    }
  }
}

export async function resolveOutput({ pluginRoot, setting, packDir, version }) {
  const dir = setting || packDir
  const kind = setting ? 'custom' : 'pack'
  if (!dir.startsWith('/')) throw new Error(`The theme output folder must be a full path: ${dir}`)
  if (dir === pluginRoot || dir.startsWith(`${pluginRoot}/`)) {
    throw new Error('The theme output folder cannot be inside the ASCII Glyphscape plugin folder: Orca would never show a new render from there.')
  }
  await mkdir(dir, { recursive: true })
  if (!(await canWrite(dir))) throw new Error(`The theme output folder is read-only: ${dir}`)
  await seedPack(dir, pluginRoot, { version })
  return { dir, kind }
}

export async function findOrcaCli({ execPath = process.execPath } = {}) {
  const dir = dirname(execPath)
  for (const root of [join(dir, 'resources'), join(dir, '..', 'Resources')]) {
    const candidate = join(root, ...CLI_ENTRY)
    try {
      await access(candidate)
      return candidate
    } catch {
    }
  }
  return null
}

function parseCli(out) {
  const start = out.indexOf('{')
  if (start === -1) return null
  try {
    return JSON.parse(out.slice(start))
  } catch {
    return null
  }
}

export function runOrcaCli(args, { execPath = process.execPath, cli, timeoutMs = 60_000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    delete env.NODE_OPTIONS
    let child
    try {
      child = spawnFn(execPath, [cli, ...args, '--json'], { cwd: dirname(execPath), env, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs })
    } catch (error) {
      resolve({ code: -1, json: null, out: error.message })
      return
    }
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('error', (error) => resolve({ code: -1, json: null, out: error.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, json: parseCli(out), out }))
  })
}

export async function installPack(dir, { moved = false, execPath = process.execPath, cli, run = runOrcaCli } = {}) {
  const entry = cli ?? (await findOrcaCli({ execPath }))
  if (!entry) return { ok: false, message: 'Orca\u2019s command line was not found next to Orca.' }
  const options = { execPath, cli: entry }
  const failed = (result) => ({ ok: false, message: result.json?.error?.message ?? (result.out.trim().slice(-300) || `exit ${result.code}`) })
  if (moved) {
    await run(['plugin', 'uninstall', PACK_KEY], options)
  } else {
    const update = await run(['plugin', 'update', PACK_KEY], options)
    if (update.json?.ok) {
      const r = update.json.result ?? {}
      return { ok: true, status: r.status ?? 'updated', contentHash: r.contentHash ?? null, message: '' }
    }
    if (update.json?.error?.code !== 'plugin_not_found') return failed(update)
  }
  const install = await run(['plugin', 'install', dir], options)
  if (install.json?.ok) return { ok: true, status: 'installed', contentHash: install.json.result?.contentHash ?? null, message: '' }
  return failed(install)
}
