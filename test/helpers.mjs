import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

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

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

export function writePicture(path, width = 640, height = 360) {
  const rows = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) {
      const dx = x - width * 0.55
      const dy = y - height * 0.45
      const inside = dx * dx + dy * dy < (height * 0.28) ** 2
      row[1 + x * 3] = inside ? 230 : Math.round((x / width) * 120)
      row[2 + x * 3] = inside ? 190 : Math.round((y / height) * 160 + 40)
      row[3 + x * 3] = inside ? 160 : 200 - Math.round((x / width) * 80)
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
  writeFileSync(path, png)
  return path
}
