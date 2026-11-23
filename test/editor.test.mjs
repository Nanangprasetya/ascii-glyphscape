import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { EDITOR_KEYS, createEditor, displayName, editable, sourceId } from '../lib/editor.mjs'
import { layout } from '../lib/paths.mjs'
import { DEFAULTS, normalizeSettings } from '../lib/settings.mjs'
import { tempDir } from './helpers.mjs'

const root = new URL('..', import.meta.url).pathname

function setup(t, { settings = {}, cli = [] } = {}) {
  const paths = layout(join(t.dir, 'data'))
  mkdirSync(paths.library, { recursive: true })
  let current = normalizeSettings({ ...DEFAULTS, ...settings })
  const asked = []
  const applied = []
  const cliCalls = []
  const scene = join(t.dir, 'scene.jpg')
  writeFileSync(scene, 'jpg')
  const editor = createEditor({
    pluginRoot: root,
    paths,
    host: {
      settings: () => current,
      loadSettings: async () => ({ settings: current }),
      sourcePath: (s) => s.source || scene,
      samples: { scene },
      apply: async (draft) => {
        applied.push(draft)
        current = normalizeSettings({ ...current, ...draft })
        return { changed: Object.keys(draft), render: { started: true } }
      },
      render: async () => ({ started: true }),
      status: () => ({ view: { phase: 'ok' }, last: null }),
      summary: () => '',
      checklist: () => '1. a',
      browse: async () => ({ cancelled: true }),
      pruneLibrary: async () => {},
      findPython: async () => 'python3',
      env: async () => ({})
    },
    deps: {
      createPreviewer: () => ({
        request: async (op, payload) => {
          asked.push({ op, payload })
          return { id: 1, ok: true, image: Buffer.from('img').toString('base64'), type: 'image/jpeg' }
        },
        dispose() {}
      }),
      findOrcaCli: async () => '/orca/cli.js',
      runOrcaCli: async (args) => {
        cliCalls.push(args)
        const answer = cli.shift() ?? { ok: true, result: {} }
        return { code: 0, json: answer, out: JSON.stringify(answer) }
      }
    }
  })
  return { editor, paths, asked, applied, cliCalls, scene, set: (s) => { current = normalizeSettings({ ...current, ...s }) } }
}

describe('editor', () => {
  it('shows only the look settings and keeps the machine ones out of Apply', async () => {
    assert.ok(!EDITOR_KEYS.includes('python') && !EDITOR_KEYS.includes('outputDir') && !EDITOR_KEYS.includes('autoRender'))
    assert.deepEqual(editable({ charset: 'film', python: '/evil', nope: 1 }), { charset: 'film' })
    assert.equal(displayName('0123456789-cat.png'), 'cat.png')
    const t = await tempDir()
    const e = setup(t)
    try {
      const state = await e.editor.handlers.state()
      assert.deepEqual(Object.keys(state.settings), [...EDITOR_KEYS])
      assert.ok(state.schema.every((s) => EDITOR_KEYS.includes(s.key)))
      await e.editor.handlers.apply({ settings: { charset: 'drift', python: '/bin/evil', outputDir: '/tmp/x' } })
      assert.deepEqual(e.applied, [{ charset: 'drift' }])
    } finally {
      await e.editor.dispose()
      await t.cleanup()
    }
  })

  it('previews the draft with the source it would render', async () => {
    const t = await tempDir()
    const e = setup(t, { settings: { charset: 'ascii' } })
    try {
      await e.editor.handlers.preview({ settings: { charset: 'braille', cell: 999 }, mode: 'light', size: [800, 450] })
      const { op, payload } = e.asked.at(-1)
      assert.equal(op, 'preview')
      assert.equal(payload.mode, 'light')
      assert.equal(payload.cfg.charset, 'braille')
      assert.equal(payload.cfg.cell, 32, 'the draft is normalized like a stored setting')
      assert.equal(payload.cfg.source, e.scene, 'no source: the sample')
      assert.ok(!('python' in payload.cfg))
      await e.editor.handlers.detail({ settings: {}, mode: 'sideways', focus: [7, -1] })
      assert.deepEqual(e.asked.at(-1).payload.focus, [1, 0])
      assert.equal(e.asked.at(-1).payload.mode, 'dark')
    } finally {
      await e.editor.dispose()
      await t.cleanup()
    }
  })

  it('lists the library and removes only unused library files', async () => {
    const t = await tempDir()
    const e = setup(t)
    try {
      const sources = await e.editor.handlers.sources()
      assert.deepEqual(sources.map((s) => s.kind), ['sample'])
      const file = join(e.paths.library, '0123456789-kept.png')
      writeFileSync(file, 'png')
      const listed = await e.editor.handlers.sources()
      const item = listed.find((s) => s.path === file)
      assert.equal(item.name, 'kept.png')
      assert.equal(item.id, sourceId(file))
      e.set({ source: file })
      await assert.rejects(e.editor.handlers.removeSource({ id: item.id }), { code: 'in_use' })
      await assert.rejects(e.editor.handlers.removeSource({ id: sources[0].id }), { code: 'invalid_request' })
      e.set({ source: '' })
      const after = await e.editor.handlers.removeSource({ id: item.id })
      assert.ok(!after.some((s) => s.path === file))
      assert.deepEqual(readdirSync(e.paths.library), [])
    } finally {
      await e.editor.dispose()
      await t.cleanup()
    }
  })

  it('stores an upload in the library under a name made from its content', async () => {
    const t = await tempDir()
    const e = setup(t)
    try {
      const { url } = await e.editor.open()
      const origin = new URL(url).origin
      const send = (name, body) => fetch(`${url}upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), Origin: origin }, body })
      const first = await (await send('My Photo (1).png', 'picture bytes')).json()
      assert.equal(first.ok, true)
      assert.match(first.result.path, /\/library\/[0-9a-f]{10}-My_Photo_1_.png$/)
      assert.equal(readFileSync(first.result.path, 'utf8'), 'picture bytes')
      assert.ok(first.result.sources.some((s) => s.id === first.result.id && s.kind === 'library'))
      const again = await (await send('My Photo (1).png', 'picture bytes')).json()
      assert.equal(again.result.path, first.result.path, 'the same bytes are stored once')
      assert.equal((await (await send('run.sh', '#!/bin/sh')).json()).error.code, 'unsupported')
      assert.deepEqual(readdirSync(e.paths.library).filter((n) => n.endsWith('.part')), [], 'no partial files are left')
    } finally {
      await e.editor.dispose()
      await t.cleanup()
    }
  })

  it('opens a tab in Orca’s browser once, then brings the same tab back', async () => {
    const t = await tempDir()
    const e = setup(t, { cli: [{ ok: true, result: { browserPageId: 'page-1' } }] })
    try {
      const first = await e.editor.open()
      assert.equal(first.ok, true)
      assert.equal(first.reused, false)
      assert.deepEqual(e.cliCalls[0].slice(0, 3), ['tab', 'create', '--url'])
      assert.match(e.cliCalls[0][3], /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/$/)
      const stored = JSON.parse(readFileSync(join(e.paths.root, 'editor.json'), 'utf8'))
      assert.equal(stored.page, 'page-1')
      const url = e.cliCalls[0][3]
      await e.editor.dispose()
      const again = setup(t, { cli: [{ ok: true, result: { tabs: [{ browserPageId: 'page-1', url }] } }, { ok: true, result: {} }] })
      try {
        const second = await again.editor.open()
        assert.equal(second.reused, true)
        assert.deepEqual(again.cliCalls.map((c) => c.slice(0, 2)), [['tab', 'list'], ['tab', 'switch']])
      } finally {
        await again.editor.dispose()
      }
    } finally {
      await e.editor.dispose()
      await t.cleanup()
    }
  })
})
