import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, join } from 'node:path'

export function dataDir({ env = process.env, home = os.homedir() } = {}) {
  if (env.ORCA_ASCII_THEMES_DATA) return env.ORCA_ASCII_THEMES_DATA
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.startsWith('/') ? env.XDG_DATA_HOME : join(home, '.local', 'share')
  return join(base, 'orca-ascii-themes')
}

export function layout(root) {
  return {
    root,
    jobs: join(root, 'jobs'),
    library: join(root, 'library'),
    state: join(root, 'state.json'),
    pack: join(root, 'theme-pack')
  }
}

export async function ensureLayout(paths) {
  await mkdir(paths.jobs, { recursive: true })
  await mkdir(paths.library, { recursive: true })
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}
