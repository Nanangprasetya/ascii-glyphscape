import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { COMMANDS, configHash, createRuntime, summary } from '../lib/runtime.mjs'
import { fakeOrca, manualTimers, settle, tempDir } from './helpers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function setup({ settings = {}, python = 'python3', state } = {}) {
  const tmp = await tempDir()
  const data = join(tmp.dir, 'data')
  const out = join(tmp.dir, 'out')
  mkdirSync(join(out, 'images'), { recursive: true })
  if (state) {
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'state.json'), JSON.stringify(state))
  }
  const picture = join(tmp.dir, 'picture.png')
  writeFileSync(picture, 'png')
  const orca = fakeOrca({ autoRender: true, source: picture, ...settings })
  const timers = manualTimers()
  const started = []
  const cancelled = []
  const installs = []
  const statuses = new Map()
  const editorHost = { current: null }
  let nextPid = 100
  const deps = {
    ...timers,
    dataRoot: data,
    home: tmp.dir,
    childEnv: async () => ({ PATH: '/bin' }),
    findPython: async () => python,
    resolveOutput: async () => ({ dir: out, kind: 'pack' }),
    installPack: async (dir, options) => {
      installs.push({ dir, ...options })
      return { ok: true, status: 'updated', contentHash: 'c0ffee' }
    },
    sweepJobs: async () => 0,
    startJob: async ({ config }) => {
      const job = { id: `job${started.length + 1}`, pid: nextPid++ }
      started.push({ ...job, config })
      statuses.set(job.id, { state: 'running', progress: 0.25, text: 'Dark: frame 1 of 4' })
      return job
    },
    jobStatus: async (file) => statuses.get(file.split('/').pop().replace('.json', '')) ?? { state: 'lost' },
    cancelJob: async (pid) => {
      cancelled.push(pid)
      return true
    },
    chooseFile: async () => ({ cancelled: true }),
    createEditor: ({ host }) => {
      editorHost.current = host
      return { open: async () => ({ ok: true, reused: false, url: 'http://127.0.0.1:1/t/' }), resume: async () => false, dispose: async () => {}, handlers: {} }
    },
    run: async () => ({ code: 0, stdout: '{"ok":true,"python":"3.14","pillow":"13","x264":true,"screen":[3840,2160]}', stderr: '' })
  }
  const runtime = createRuntime(orca, { pluginRoot: root, deps })
  runtime.register()
  await runtime.start()
  const finishJob = (id, result) => {
    for (const rel of [result.themes?.dark?.image, result.themes?.light?.image]) {
      if (rel) writeFileSync(join(out, rel), 'x')
    }
    statuses.set(id, { state: 'done', progress: 1, text: 'Done', result })
  }
  const okResult = (tag) => ({ ok: true, size: [2560, 1440], videoSize: null, notes: [], themes: { dark: { image: `images/ascii-dark-${tag}.webp`, video: null }, light: { image: `images/ascii-light-${tag}.webp`, video: null } } })
  return { tmp, orca, timers, runtime, started, cancelled, installs, statuses, finishJob, okResult, data, out, editorHost, picture }
}

describe('runtime', () => {
  it('registers every command', async () => {
    const t = await setup()
    try {
      assert.deepEqual([...t.orca.registered.keys()], [...COMMANDS])
    } finally {
      await t.runtime.dispose()
      await t.tmp.cleanup()
    }
  })

  it('renders on start, reports progress and success, then skips an unchanged render', async () => {
    const t = await setup()
    try {
      assert.equal(t.timers.pendingTimeouts, 1, 'a render is scheduled on start')
      await t.timers.fireTimeouts()
      await settle()
      assert.equal(t.started.length, 1)
      const config = t.started[0].config
      assert.equal(config.source, t.picture)
      assert.equal(config.outDir, t.out)
      assert.equal(config.python, undefined)
      await t.timers.fireIntervals()
      await settle()
      assert.equal(t.runtime.view.phase, 'rendering')
      assert.equal(t.orca.statuses().at(-1).text, 'ASCII 25%')

      t.finishJob('job1', t.okResult('aaaaaaaaaaaa'))
      await t.timers.fireIntervals()
      await settle()
      assert.equal(t.runtime.view.phase, 'ok')
      assert.deepEqual(t.installs, [{ dir: t.out, moved: false }], 'the new render reaches Orca through the pack')
      assert.equal(t.runtime.state.packDir, t.out)
      assert.equal(t.runtime.state.current, null)
      const welcome = t.orca.notifications()
      assert.equal(welcome.length, 1)
      assert.match(welcome[0].body, /Background Opacity below 1/)
      const saved = JSON.parse(readFileSync(join(t.data, 'state.json'), 'utf8'))
      assert.equal(saved.lastHash, t.runtime.state.lastHash)

      await t.runtime.requestRender({})
      assert.equal(t.started.length, 1, 'nothing changed, nothing rendered')
      assert.equal(t.installs.length, 1, 'the pack was synced by this worker already')
      await t.runtime.requestRender({ force: true, reason: 'command' })
      assert.equal(t.started.length, 2, 'Render now always renders')
    } finally {
      await t.runtime.dispose()
      await t.tmp.cleanup()
    }
  })

  it('debounces setting changes and replaces a running render', async () => {
    const t = await setup()
    try {
      await t.timers.fireTimeouts()
      await settle()
      assert.equal(t.started.length, 1)
      await t.orca.settings.set('style', 'blue')
      await t.orca.settings.set('cell', 9)
      await settle()
      assert.equal(t.timers.pendingTimeouts, 1, 'one debounced render for two changes')
      await t.timers.fireTimeouts()
      await settle()
      assert.equal(t.started.length, 2)
      assert.deepEqual(t.cancelled, [100], 'the first render was stopped')
      assert.equal(t.started[1].config.style, 'blue')
      assert.equal(t.started[1].config.cell, 9)
    } finally {
      await t.runtime.dispose()
      await t.tmp.cleanup()
    }
  })

  it('does not render on changes when auto render is off', async () => {
    const t = await setup({ settings: { autoRender: false } })
    try {
      assert.equal(t.timers.pendingTimeouts, 0)
      await t.orca.settings.set('style', 'mesh')
      await settle()
      assert.equal(t.timers.pendingTimeouts, 0)
      assert.match(await t.orca.registered.get('render-now')(), /Rendering/)
      assert.equal(t.started.length, 1)
    } finally {
      await t.runtime.dispose()
      await t.tmp.cleanup()
    }
  })

  it('resumes watching a render that a previous worker started', async () => {
    const tmp = await tempDir()
    try {
      const state = { lastHash: null, last: null, welcomed: true, current: { id: 'old', pid: 55, hash: 'h1', startedAt: 1, outDir: '/o', reason: 'settings' } }
      mkdirSync(join(tmp.dir, 'd'), { recursive: true })
      writeFileSync(join(tmp.dir, 'd', 'state.json'), JSON.stringify(state))
      const orca = fakeOrca({ autoRender: false })
      const timers = manualTimers()
      let status = { state: 'running', progress: 0.6, text: 'Light: frame 9 of 10' }
      const runtime = createRuntime(orca, {
        pluginRoot: root,
        deps: { ...timers, dataRoot: join(tmp.dir, 'd'), jobStatus: async () => status, sweepJobs: async () => 0, installPack: async () => ({ ok: true }) }
      })
      runtime.register()
      await runtime.start()
      assert.equal(runtime.view.phase, 'rendering')
      assert.equal(timers.pendingIntervals, 1)
      status = { state: 'done', result: { ok: false, error: 'boom' } }
      await timers.fireIntervals()
      await settle()
      assert.equal(runtime.view.phase, 'error')
      assert.equal(orca.notifications().at(-1).body, 'boom')
      assert.equal(runtime.state.current, null)
      await runtime.dispose()
    } finally {
      await tmp.cleanup()
    }
  })

  it('explains a missing Python or source instead of starting', async () => {
    const t = await setup({ python: null, settings: { autoRender: false } })
    try {
      await t.orca.registered.get('render-now')()
      assert.equal(t.started.length, 0)
      assert.equal(t.runtime.view.phase, 'error')
      assert.match(t.orca.notifications().at(-1).body, /python-pillow/)
      await t.orca.settings.set('source', '/nope/missing.png')
      await t.orca.registered.get('render-now')()
      assert.match(t.orca.notifications().at(-1).body, /was not found/)
    } finally {
      await t.runtime.dispose()
      await t.tmp.cleanup()
    }
  })

  it('asks for a picture instead of rendering when none is set', async () => {
    const t = await setup({ settings: { source: '' } })
    try {
      await t.timers.fireTimeouts()
      await settle()
      assert.equal(t.started.length, 0, 'nothing to render')
      assert.equal(t.runtime.view.phase, 'empty')
      assert.match(t.orca.statuses().at(-1).tooltip, /no picture or video yet/)
      assert.match(t.orca.notifications().at(-1).body, /Open editor/)
      assert.match(await t.orca.registered.get('render-now')(), /No picture or video is set yet/)
      assert.equal(t.orca.notifications().length, 1, 'the hint is shown once')
    } finally {
      await t.runtime.dispose()
      await t.tmp.cleanup()
    }
  })

  it('resets settings and copies a chosen file into the library', async () => {
    const t = await setup({ settings: { autoRender: false, style: 'mesh', python: '/opt/py' } })
    try {
      await t.orca.registered.get('reset-settings')()
      assert.equal(t.orca.values.style, 'real')
      assert.equal(t.orca.values.python, '/opt/py', 'machine settings survive a reset')

      const picture = join(t.tmp.dir, 'my picture.png')
      writeFileSync(picture, 'png')
      const runtime2 = t.runtime
      const chosen = createRuntime(t.orca, { pluginRoot: root, deps: { dataRoot: t.data, home: t.tmp.dir, ...manualTimers(), childEnv: async () => ({}), chooseFile: async () => ({ path: picture }), findPython: async () => 'python3', resolveOutput: async () => ({ dir: t.out, kind: 'pack' }), startJob: async () => ({ id: 'x', pid: 1 }), jobStatus: async () => ({ state: 'running' }), cancelJob: async () => true, sweepJobs: async () => 0 } })
      chosen.register()
      await chosen.start()
      assert.match(await t.orca.registered.get('choose-media')(), /my picture\.png/)
      assert.match(t.orca.values.source, /library\/[0-9a-f]{10}-my_picture\.png$/)
      assert.equal(readFileSync(t.orca.values.source, 'utf8'), 'png')
      await chosen.dispose()
      await runtime2.dispose()
    } finally {
      await t.tmp.cleanup()
    }
  })

  it('keeps a notice Orca refused while reloading and shows it from the next worker', async () => {
    const t = await setup()
    try {
      await t.timers.fireTimeouts()
      await settle()
      const realCall = t.orca.host.call
      t.orca.host.call = async (method, params) => {
        if (method === 'notifications.show') throw new Error('plugin is not enabled with current consent')
        return realCall(method, params)
      }
      t.finishJob('job1', t.okResult('bbbbbbbbbbbb'))
      await t.timers.fireIntervals()
      await settle()
      assert.equal(t.runtime.state.notices.length, 1)
      await t.runtime.dispose()

      t.orca.host.call = realCall
      const timers = manualTimers()
      await t.orca.settings.set('autoRender', false)
      const next = createRuntime(t.orca, { pluginRoot: root, deps: { ...timers, dataRoot: t.data, sweepJobs: async () => 0, startJob: async () => assert.fail('no render expected'), resolveOutput: async () => ({ dir: t.out, kind: 'pack' }) } })
      next.register()
      await next.start()
      await timers.fireTimeouts()
      await settle()
      assert.match(t.orca.notifications().at(-1).title, /wallpaper rendered/)
      assert.deepEqual(next.state.notices, [])
      await next.dispose()
    } finally {
      await t.tmp.cleanup()
    }
  })

  it('syncs the pack once when a new worker finds the render up to date, and reports a failed install', async () => {
    const t = await setup()
    try {
      await t.timers.fireTimeouts()
      await settle()
      t.finishJob('job1', t.okResult('cccccccccccc'))
      await t.timers.fireIntervals()
      await settle()
      await t.runtime.dispose()
      const installs = []
      const timers = manualTimers()
      const next = createRuntime(t.orca, { pluginRoot: root, deps: { ...timers, dataRoot: t.data, sweepJobs: async () => 0, resolveOutput: async () => ({ dir: t.out, kind: 'pack' }), startJob: async () => assert.fail('no render expected'), installPack: async (dir, o) => { installs.push({ dir, ...o }); return { ok: false, message: 'denied' } } } })
      next.register()
      await next.start()
      await timers.fireTimeouts()
      await settle()
      assert.deepEqual(installs, [{ dir: t.out, moved: false }])
      assert.match(t.orca.notifications().at(-1).body, /orca plugin install/)
      await next.dispose()
    } finally {
      await t.tmp.cleanup()
    }
  })

  it('applies an editor draft: only changed look settings, rendered at once', async () => {
    const t = await setup({ settings: { charset: 'ascii', python: '/usr/bin/python3' } })
    try {
      assert.match(await t.orca.registered.get('open-editor')(), /^Opened the ASCII Glyphscape editor in Orca/)
      const host = t.editorHost.current
      assert.ok(host, 'the editor was made')
      const before = t.started.length
      const result = await host.apply({ charset: 'film', saturation: 1.25, python: '/tmp/evil' })
      assert.deepEqual(result.changed, ['charset'])
      assert.equal(result.render.started, true)
      assert.equal(t.orca.values.charset, 'film')
      assert.equal(t.orca.values.python, '/usr/bin/python3', 'machine settings stay as they are')
      assert.equal(t.started.length, before + 1)
      assert.equal(t.started.at(-1).config.charset, 'film')
    } finally {
      await t.runtime.dispose()
      await t.tmp.cleanup()
    }
  })

  it('returns the setup checklist from the command', async () => {
    const t = await setup({ settings: { autoRender: false } })
    try {
      const text = await t.orca.registered.get('setup-checklist')()
      assert.match(text, /ASCII Glyphscape Dark/)
      assert.match(text, /screen 3840×2160/)
      assert.match(text, /cannot blur/)
    } finally {
      await t.runtime.dispose()
      await t.tmp.cleanup()
    }
  })
})

describe('helpers', () => {
  it('hashes configs independently of key order and job paths', () => {
    const a = configHash({ a: 1, b: 2, jobFile: '/x' }, { size: 1 })
    assert.equal(a, configHash({ b: 2, a: 1, jobFile: '/y' }, { size: 1 }))
    assert.notEqual(a, configHash({ a: 1, b: 3 }, { size: 1 }))
    assert.notEqual(a, configHash({ a: 1, b: 2 }, { size: 2 }))
  })

  it('summarizes results', () => {
    assert.match(summary({ ok: true, size: [1, 2], videoSize: [3, 4], notes: ['n'] }), /1×2 with a 3×4 video loop\. n/)
    assert.equal(summary({ ok: false, error: 'e' }), 'e')
  })
})
