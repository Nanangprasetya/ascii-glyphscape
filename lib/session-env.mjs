import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

export const SESSION_KEYS = Object.freeze(['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP'])
const ANCESTORS_MAX = 8

export function parseEnviron(text) {
  const out = {}
  for (const entry of String(text).split('\0')) {
    const at = entry.indexOf('=')
    if (at > 0) out[entry.slice(0, at)] = entry.slice(at + 1)
  }
  return out
}

function pick(source, into) {
  for (const key of SESSION_KEYS) {
    if (into[key] === undefined && typeof source[key] === 'string' && source[key] !== '') into[key] = source[key]
  }
  return into
}

const hasDisplay = (env) => Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)

export async function sessionEnv({ env = process.env, platform = process.platform, ppid = process.ppid, uid = process.getuid?.(), home = os.homedir(), read = readFile, list = readdir } = {}) {
  if (platform === 'darwin' || platform === 'win32') return {}
  const out = pick(env, {})
  if (hasDisplay(out)) return out
  let pid = ppid
  for (let depth = 0; pid > 1 && depth < ANCESTORS_MAX; depth += 1) {
    try {
      const found = parseEnviron(await read(`/proc/${pid}/environ`, 'latin1'))
      if (hasDisplay(found)) return pick(found, out)
    } catch {
    }
    try {
      pid = Number(/^PPid:\s*(\d+)/m.exec(await read(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0)
    } catch {
      break
    }
  }
  const runtime = out.XDG_RUNTIME_DIR ?? (uid === undefined ? null : `/run/user/${uid}`)
  const names = runtime ? await list(runtime).catch(() => null) : null
  if (names) {
    out.XDG_RUNTIME_DIR = runtime
    const wayland = names.filter((name) => /^wayland-\d+$/.test(name)).sort()[0]
    if (wayland) out.WAYLAND_DISPLAY = wayland
    if (!out.DBUS_SESSION_BUS_ADDRESS && names.includes('bus')) out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(runtime, 'bus')}`
    const xauth = names.find((name) => name.startsWith('xauth_'))
    if (!out.XAUTHORITY && xauth) out.XAUTHORITY = join(runtime, xauth)
  }
  const x11 = (await list('/tmp/.X11-unix').catch(() => [])).filter((name) => /^X\d+$/.test(name)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))[0]
  if (!out.DISPLAY && x11) out.DISPLAY = `:${x11.slice(1)}`
  if (!out.XAUTHORITY && out.DISPLAY && home && existsSync(join(home, '.Xauthority'))) out.XAUTHORITY = join(home, '.Xauthority')
  return out
}

export async function childEnv(extra = {}) {
  const env = { ...process.env, ...(await sessionEnv()), ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}
