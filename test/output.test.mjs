import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PACK_KEY, installPack, packManifest, resolveOutput } from '../lib/output.mjs'
import { tempDir } from './helpers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('theme pack folder', () => {
  it('is made in the data folder with the starting themes', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const pack = join(dir, 'pack')
      assert.deepEqual(await resolveOutput({ pluginRoot: root, setting: '', packDir: pack, version: '1.2.3' }), { dir: pack, kind: 'pack' })
      const manifest = JSON.parse(readFileSync(join(pack, 'orca-plugin.json'), 'utf8'))
      assert.deepEqual(manifest, packManifest({ version: '1.2.3' }))
      assert.equal(manifest.execution, 'data', 'content only: Orca installs it without approval')
      for (const rel of ['images', 'themes/ascii-dark.json', 'terminal/ascii-light.json']) assert.ok(existsSync(join(pack, rel)), rel)
    } finally {
      await cleanup()
    }
  })

  it('keeps files already there and refuses folders that cannot work', async () => {
    const { dir, cleanup } = await tempDir()
    try {
      const custom = join(dir, 'custom')
      mkdirSync(join(custom, 'themes'), { recursive: true })
      writeFileSync(join(custom, 'themes', 'ascii-dark.json'), '{"mine":true}')
      const out = await resolveOutput({ pluginRoot: root, setting: custom, packDir: join(dir, 'pack'), version: '1.0.0' })
      assert.equal(out.kind, 'custom')
      assert.equal(readFileSync(join(custom, 'themes', 'ascii-dark.json'), 'utf8'), '{"mine":true}')
      await assert.rejects(resolveOutput({ pluginRoot: root, setting: 'relative/dir', packDir: '', version: '1' }), /full path/)
      await assert.rejects(resolveOutput({ pluginRoot: root, setting: join(root, 'out'), packDir: '', version: '1' }), /inside the ASCII Glyphscape plugin folder/)
    } finally {
      await cleanup()
    }
  })
})

describe('installing the pack', () => {
  const answer = (json) => ({ code: 0, json, out: JSON.stringify(json) })

  it('re-copies an installed pack', async () => {
    const calls = []
    const run = async (args) => {
      calls.push(args)
      return answer({ ok: true, result: { pluginKey: PACK_KEY, contentHash: 'abc' } })
    }
    assert.deepEqual(await installPack('/p', { cli: 'cli.js', run }), { ok: true, status: 'updated', contentHash: 'abc', message: '' })
    assert.deepEqual(calls, [['plugin', 'update', PACK_KEY]])
  })

  it('installs it the first time, and again from a new folder', async () => {
    const calls = []
    const run = async (args) => {
      calls.push(args)
      if (args[1] === 'update') return answer({ ok: false, error: { code: 'plugin_not_found', message: 'not installed' } })
      return answer({ ok: true, result: { contentHash: 'def' } })
    }
    assert.equal((await installPack('/p', { cli: 'cli.js', run })).status, 'installed')
    assert.deepEqual(calls, [['plugin', 'update', PACK_KEY], ['plugin', 'install', '/p']])
    calls.length = 0
    await installPack('/q', { cli: 'cli.js', run, moved: true })
    assert.deepEqual(calls, [['plugin', 'uninstall', PACK_KEY], ['plugin', 'install', '/q']])
  })

  it('reports what Orca said when it fails', async () => {
    const run = async () => answer({ ok: false, error: { code: 'invalid_plugin', message: 'bad manifest' } })
    assert.deepEqual(await installPack('/p', { cli: 'cli.js', run }), { ok: false, message: 'bad manifest' })
    assert.match((await installPack('/p', { execPath: '/nowhere/orca' })).message, /command line was not found/)
  })
})
