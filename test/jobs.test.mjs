import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { alive, cancelJob, jobFiles, jobStatus, readJob, startJob, sweepJobs } from '../lib/jobs.mjs'
import { DEFAULTS, renderSettings } from '../lib/settings.mjs'
import { tempDir } from './helpers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hasPillow = (() => {
  try {
    execFileSync('python3', ['-I', '-c', 'import PIL'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('jobs', () => {
  it('starts the renderer detached with a config it can clean up', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const seen = []
      const spawn = (file, args, options) => {
        seen.push({ file, args, options })
        return { pid: 4242, on() {}, unref() {} }
      }
      const job = await startJob({ python: 'python3', cli: '/p/tools/ascii_cli.py', jobsDir: dir, config: { style: 'blue' }, env: { A: '1' }, spawn, id: 'j1' })
      assert.equal(job.pid, 4242)
      assert.deepEqual(seen[0].args, ['-I', '-B', '/p/tools/ascii_cli.py', 'render', join(dir, 'cfg-j1.json')])
      assert.equal(seen[0].options.detached, true)
      const config = JSON.parse(readFileSync(join(dir, 'cfg-j1.json'), 'utf8'))
      assert.equal(config.style, 'blue')
      assert.equal(config.jobFile, join(dir, 'j1.json'))
      assert.equal(config.cleanup, join(dir, 'cfg-j1.json'))
      assert.equal((await readJob(join(dir, 'j1.json'))).state, 'running')
    } finally {
      await cleanup()
    }
  })

  it('tells running, done and lost jobs apart', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const file = join(dir, 'j.json')
      const living = new Set([10])
      const kill = (pid) => {
        if (!living.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      }
      writeFileSync(file, JSON.stringify({ state: 'running', pid: 10, progress: 0.5, text: 'x' }))
      assert.equal((await jobStatus(file, 10, { kill })).state, 'running')
      living.clear()
      assert.equal((await jobStatus(file, 10, { kill })).state, 'lost')
      writeFileSync(file, JSON.stringify({ state: 'done', result: { ok: true } }))
      assert.deepEqual((await jobStatus(file, 10, { kill })).result, { ok: true })
      assert.equal(alive(0), false)
      assert.equal(alive(process.pid), true)
    } finally {
      await cleanup()
    }
  })

  it('escalates a cancel to the process group when SIGTERM is ignored', async () => {
    const sent = []
    const kill = (pid, signal) => {
      sent.push([pid, signal])
      if (signal === 'SIGKILL') return
    }
    assert.equal(await cancelJob(77, null, { kill, waitMs: 30, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }), true)
    assert.deepEqual(sent.filter(([, s]) => s !== 0), [[77, 'SIGTERM'], [-77, 'SIGKILL']])
  })

  it('sweeps old job files but keeps the ones asked for', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      for (const id of ['old', 'keep']) {
        const files = jobFiles(dir, id)
        writeFileSync(files.job, '{}')
        utimesSync(files.job, new Date(0), new Date(0))
      }
      writeFileSync(join(dir, 'new.json'), '{}')
      assert.equal(await sweepJobs(dir, { keep: ['keep'] }), 1)
      assert.ok(existsSync(join(dir, 'keep.json')))
      assert.ok(existsSync(join(dir, 'new.json')))
    } finally {
      await cleanup()
    }
  })

  it('runs the real renderer end to end and cancels it', { skip: !hasPillow && 'needs python3 with Pillow', timeout: 240_000 }, async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const out = join(dir, 'plugin')
      mkdirSync(join(out, 'images'), { recursive: true })
      const jobs = join(dir, 'jobs')
      const config = { ...renderSettings(DEFAULTS), resolution: '1920x1080', source: join(root, 'assets/samples/sample.jpg'), outDir: out, style: 'dark', mask: true }
      const job = await startJob({ python: 'python3', cli: join(root, 'tools/ascii_cli.py'), jobsDir: jobs, config, env: process.env })
      let status
      for (let i = 0; i < 600; i += 1) {
        status = await jobStatus(job.files.job, job.pid)
        if (status.state !== 'running') break
        await new Promise((r) => setTimeout(r, 200))
      }
      assert.equal(status.state, 'done')
      assert.equal(status.result.ok, true, status.result.error)
      assert.ok(existsSync(join(out, status.result.themes.dark.image)))
      assert.ok(!existsSync(job.files.config), 'the renderer removes its config')

      const slow = await startJob({ python: 'python3', cli: join(root, 'tools/ascii_cli.py'), jobsDir: jobs, config: { ...config, animation: 'hover', duration: 20, fps: 30 }, env: process.env })
      for (let i = 0; i < 300; i += 1) {
        const s = await jobStatus(slow.files.job, slow.pid)
        if (/frame/.test(s.text)) break
        await new Promise((r) => setTimeout(r, 200))
      }
      assert.equal(await cancelJob(slow.pid, slow.files.job), true)
      const done = await readJob(slow.files.job)
      assert.equal(done.state, 'done')
      assert.equal(done.result.cancelled, true)
    } finally {
      await cleanup()
    }
  })
})
