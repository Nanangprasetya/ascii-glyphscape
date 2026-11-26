import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SEED, THEMES, packManifest } from '../lib/output.mjs'
import { COMMANDS, PLUGIN_VERSION } from '../lib/runtime.mjs'
import { SETTINGS } from '../lib/settings.mjs'
import { STATUS_ITEM_ID } from '../lib/status.mjs'
import { COMMAND_TITLES, generated } from '../scripts/sync-manifest.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8'))
const read = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'))

describe('manifest', () => {
  it('is in step with the code (run node scripts/sync-manifest.mjs after changes)', () => {
    assert.deepEqual(generated(manifest), manifest)
    assert.equal(manifest.version, PLUGIN_VERSION)
  })

  it('declares exactly the commands the worker registers', () => {
    assert.deepEqual(manifest.contributes.commands.map((c) => c.id), [...COMMANDS])
    assert.deepEqual(Object.keys(COMMAND_TITLES), [...COMMANDS])
    const item = manifest.contributes.statusBarItems[0]
    assert.equal(item.id, STATUS_ITEM_ID)
    assert.ok(COMMANDS.includes(item.command))
  })

  it('asks only for the access the plugin uses and stays resident', () => {
    assert.deepEqual(manifest.capabilities.map((c) => c.kind).sort(), ['notifications:show', 'settings:own'])
    assert.equal(manifest.execution, 'trusted-worker')
    assert.equal(manifest.main, 'main.mjs')
    assert.ok(manifest.contributes.statusBarItems.length > 0, 'a status bar item keeps the worker running')
    assert.equal(manifest.contributes.panels, undefined, 'configuration lives in Settings, not a sidebar panel')
  })

  it('keeps settings within what Orca accepts', () => {
    assert.ok(SETTINGS.length <= 64)
    const keys = new Set()
    for (const s of SETTINGS) {
      assert.ok(!keys.has(s.key), `duplicate ${s.key}`)
      keys.add(s.key)
      assert.match(s.key, /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/)
      assert.ok(s.title.length <= 120, s.key)
      assert.ok((s.description ?? '').length <= 1000, s.key)
      assert.ok(['string', 'number', 'integer', 'boolean'].includes(s.type), s.key)
      if (s.enum) {
        assert.ok(s.enum.includes(s.default), s.key)
        assert.equal(s.enumLabels.length, s.enum.length, s.key)
      }
      if (s.minimum !== undefined) assert.ok(s.default >= s.minimum && s.default <= s.maximum, s.key)
      assert.ok(!/[\u2014]/.test(JSON.stringify(s)), `${s.key} uses an em dash`)
    }
  })

  it('leaves the themes to the theme pack and seeds it with valid starting themes', () => {
    assert.equal(manifest.contributes.themes, undefined, 'a dev folder would keep showing its first wallpaper')
    assert.equal(manifest.contributes.terminalThemes, undefined)
    const pack = packManifest({ version: PLUGIN_VERSION })
    for (const { mode } of THEMES) {
      assert.ok(pack.contributes.themes.some((t) => t.path === `themes/ascii-${mode}.json`))
      const doc = read(`${SEED}/themes/ascii-${mode}.json`)
      assert.equal(doc.base, mode)
      assert.equal(doc.background, undefined, 'no bundled wallpaper: the first render brings the picture')
      assert.ok(readFileSync(join(root, SEED, `themes/ascii-${mode}.json`)).length <= 16 * 1024)
      const term = read(`${SEED}/terminal/ascii-${mode}.json`)
      assert.equal(term.mode, mode)
      for (const value of Object.values(term.terminal)) assert.match(value, /^#[0-9a-f]{6}$/i)
    }
    for (const rel of [manifest.main, 'tools/ascii_cli.py']) assert.ok(statSync(join(root, rel)).size > 0, rel)
  })
})
