import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function tempDir(prefix = 'ascii-themes-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export function fakeOrca(initial = {}) {
  const values = { ...initial }
  const listeners = new Set()
  const calls = []
  const registered = new Map()
  const logs = []
  return {
    values,
    calls,
    registered,
    logs,
    log: (m) => logs.push(m),
    host: {
      call: async (method, params) => {
        calls.push([method, params])
        return {}
      }
    },
    commands: {
      register(id, handler) {
        registered.set(id, handler)
        return { dispose() {} }
      }
    },
    settings: {
      get: async (key) => (key ? values[key] : { ...values }),
      set: async (key, value) => {
        values[key] = value
        for (const l of listeners) l({ key })
      },
      onDidChange(listener) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      }
    },
    notifications: () => calls.filter(([m]) => m === 'notifications.show').map(([, p]) => p),
    statuses: () => calls.filter(([m]) => m === 'statusBar.update').map(([, p]) => p)
  }
}

export function manualTimers() {
  let next = 1
  const timeouts = new Map()
  const intervals = new Map()
  return {
    setTimeout: (fn) => {
      const id = next++
      timeouts.set(id, fn)
      return id
    },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (fn) => {
      const id = next++
      intervals.set(id, fn)
      return id
    },
    clearInterval: (id) => intervals.delete(id),
    async fireTimeouts() {
      const due = [...timeouts.values()]
      timeouts.clear()
      for (const fn of due) await fn()
    },
    async fireIntervals() {
      for (const fn of [...intervals.values()]) await fn()
    },
    get pendingTimeouts() {
      return timeouts.size
    },
    get pendingIntervals() {
      return intervals.size
    }
  }
}

export const settle = () => new Promise((r) => setTimeout(r, 20))
