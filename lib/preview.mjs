import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export const IDLE_MS = 10 * 60_000
export const TIMEOUT_MS = 180_000
const STDERR_KEEP = 20

export class PreviewError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function createPreviewer({ script, findPython, env, log = () => {}, spawn = nodeSpawn, idleMs = IDLE_MS, timeoutMs = TIMEOUT_MS, timers = { setTimeout, clearTimeout } }) {
  let child = null
  let starting = null
  let inflight = null
  let busy = false
  let idle = null
  let nextId = 1
  let disposed = false
  const queue = []
  const stderr = []

  function stop() {
    const current = child
    child = null
    if (!current) return
    try {
      current.stdin.end()
    } catch {
    }
    const killer = timers.setTimeout(() => {
      try {
        current.kill('SIGKILL')
      } catch {
      }
    }, 3000)
    killer?.unref?.()
    current.once('exit', () => timers.clearTimeout(killer))
  }

  function armIdle() {
    if (idle) timers.clearTimeout(idle)
    idle = timers.setTimeout(() => {
      idle = null
      if (!busy && !queue.length) {
        log('preview process stopped (idle)')
        stop()
      }
    }, idleMs)
    idle?.unref?.()
  }

  async function ensure() {
    if (child) return child
    starting ??= (async () => {
      const python = await findPython()
      if (!python) throw new PreviewError('no_python', 'No Python 3 with Pillow was found, so nothing can be previewed. Install python-pillow.')
      const proc = spawn(python, ['-I', '-B', script], { stdio: ['pipe', 'pipe', 'pipe'], env: await env() })
      proc.on('error', (error) => log(`preview process error: ${error.message}`))
      proc.stdin.on('error', () => undefined)
      createInterface({ input: proc.stdout }).on('line', (line) => onLine(proc, line))
      createInterface({ input: proc.stderr }).on('line', (line) => {
        stderr.push(line)
        if (stderr.length > STDERR_KEEP) stderr.shift()
      })
      proc.on('exit', (code, signal) => {
        if (child === proc) child = null
        if (inflight?.proc === proc) {
          const job = inflight
          inflight = null
          timers.clearTimeout(job.timer)
          const tail = stderr.slice(-3).join(' | ')
          job.reject(new PreviewError('preview_crashed', `The preview process stopped (${signal ?? code}).${tail ? ` ${tail}` : ''}`))
        }
      })
      child = proc
      log(`preview process started (pid ${proc.pid})`)
      return proc
    })().finally(() => {
      starting = null
    })
    return starting
  }

  function onLine(proc, line) {
    let answer
    try {
      answer = JSON.parse(line)
    } catch {
      log(`preview process said: ${line.slice(0, 200)}`)
      return
    }
    const job = inflight
    if (!job || job.proc !== proc || answer.id !== job.id) return
    inflight = null
    timers.clearTimeout(job.timer)
    job.resolve(answer)
  }

  function send(proc, job) {
    return new Promise((resolve, reject) => {
      const id = nextId++
      const timer = timers.setTimeout(() => {
        if (inflight?.id !== id) return
        inflight = null
        log(`preview ${job.op} took over ${timeoutMs} ms; restarting the preview process`)
        if (child === proc) stop()
        reject(new PreviewError('preview_timeout', 'The preview took too long.'))
      }, timeoutMs)
      inflight = { id, proc, resolve, reject, timer }
      proc.stdin.write(`${JSON.stringify({ ...job.payload, id, op: job.op })}\n`)
    })
  }

  async function pump() {
    if (busy || !queue.length || disposed) return
    busy = true
    const job = queue.shift()
    try {
      const proc = await ensure()
      job.resolve(await send(proc, job))
    } catch (error) {
      job.reject(error)
    } finally {
      busy = false
      armIdle()
      pump()
    }
  }

  return {
    request(op, payload = {}, { channel = op } = {}) {
      if (disposed) return Promise.reject(new PreviewError('disposed', 'The plugin is shutting down.'))
      return new Promise((resolve, reject) => {
        const older = queue.findIndex((job) => job.channel === channel)
        if (older !== -1) {
          queue[older].reject(new PreviewError('superseded', 'A newer request replaced this one.'))
          queue.splice(older, 1)
        }
        queue.push({ op, payload, channel, resolve, reject })
        pump()
      })
    },
    get running() {
      return child !== null
    },
    dispose() {
      disposed = true
      if (idle) timers.clearTimeout(idle)
      for (const job of queue.splice(0)) job.reject(new PreviewError('disposed', 'The plugin is shutting down.'))
      stop()
    }
  }
}
