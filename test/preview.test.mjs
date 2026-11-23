import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { createPreviewer } from '../lib/preview.mjs'

function fakeSpawn(reply = (req) => ({ id: req.id, ok: true, op: req.op, seen: req.n })) {
  const spawned = []
  const spawn = () => {
    const proc = new EventEmitter()
    proc.pid = 4000 + spawned.length
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.requests = []
    proc.stdin = new PassThrough()
    let buffer = ''
    proc.stdin.on('data', (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) !== -1) {
        const req = JSON.parse(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        proc.requests.push(req)
        const answer = reply(req, proc)
        if (answer) setTimeout(() => proc.stdout.write(`${JSON.stringify(answer)}\n`), 5)
      }
    })
    proc.kill = () => proc.emit('exit', null, 'SIGKILL')
    proc.stdin.on('finish', () => setTimeout(() => proc.emit('exit', 0, null), 1))
    spawned.push(proc)
    return proc
  }
  return { spawn, spawned }
}

const base = (extra) => ({ script: '/x/ascii_preview.py', findPython: async () => 'python3', env: async () => ({}), idleMs: 60_000, ...extra })

describe('preview process', () => {
  it('sends one request at a time and lets a newer one of the same kind replace a waiting one', async () => {
    const fake = fakeSpawn()
    const p = createPreviewer(base({ spawn: fake.spawn }))
    try {
      const first = p.request('preview', { n: 1 })
      const second = p.request('preview', { n: 2 })
      second.catch(() => undefined)
      const third = p.request('preview', { n: 3 })
      const other = p.request('gallery', { n: 4 })
      assert.equal((await first).seen, 1)
      await assert.rejects(second, { code: 'superseded' })
      assert.equal((await third).seen, 3)
      assert.equal((await other).seen, 4)
      assert.equal(fake.spawned.length, 1, 'one process serves them all')
      assert.deepEqual(fake.spawned[0].requests.map((r) => r.n), [1, 3, 4])
    } finally {
      p.dispose()
    }
  })

  it('starts again after a crash, and reports what it said', async () => {
    const fake = fakeSpawn((req, proc) => {
      if (req.n === 'crash') {
        proc.stderr.write('Traceback: boom\n')
        setTimeout(() => proc.emit('exit', 1, null), 10)
        return null
      }
      return { id: req.id, ok: true, seen: req.n }
    })
    const p = createPreviewer(base({ spawn: fake.spawn }))
    try {
      await assert.rejects(p.request('preview', { n: 'crash' }), (error) => error.code === 'preview_crashed' && /boom/.test(error.message))
      assert.equal((await p.request('preview', { n: 2 })).seen, 2)
      assert.equal(fake.spawned.length, 2)
    } finally {
      p.dispose()
    }
  })

  it('gives up on a request that takes too long, and says when there is no Python', async () => {
    const fake = fakeSpawn(() => null)
    const p = createPreviewer(base({ spawn: fake.spawn, timeoutMs: 30 }))
    try {
      await assert.rejects(p.request('motion', {}), { code: 'preview_timeout' })
    } finally {
      p.dispose()
    }
    const none = createPreviewer(base({ findPython: async () => null, spawn: fake.spawn }))
    await assert.rejects(none.request('preview', {}), { code: 'no_python' })
    none.dispose()
    await assert.rejects(none.request('preview', {}), { code: 'disposed' })
  })
})
