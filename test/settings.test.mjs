import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULTS, SETTINGS, invalidColours, manifestEntry, normalizeSettings, renderSettings } from '../lib/settings.mjs'

describe('settings', () => {
  it('fills in defaults and clamps what is stored', () => {
    const s = normalizeSettings({ cell: 999, saturation: -3, fps: 12.6, style: 'neon', mask: 'yes', source: '  /a/b.png \n', customCharset: ' .oO' })
    assert.equal(s.cell, 32)
    assert.equal(s.saturation, 0)
    assert.equal(s.fps, 13)
    assert.equal(s.style, 'real')
    assert.equal(s.mask, false)
    assert.equal(s.source, '/a/b.png')
    assert.equal(s.customCharset, ' .oO', 'leading space of a character ramp is kept')
    assert.deepEqual(normalizeSettings(undefined), DEFAULTS)
  })

  it('accepts hex colours with or without # and drops the rest', () => {
    const s = normalizeSettings({ inkColor: 'abc', backgroundColor: '#112233', accentColor: 'red' })
    assert.equal(s.inkColor, '#abc')
    assert.equal(s.backgroundColor, '#112233')
    assert.equal(s.accentColor, '')
    assert.deepEqual(invalidColours({ accentColor: 'red', inkColor: '#fff' }), ['Colour: accent "red"'])
  })

  it('sends the renderer only what changes the picture', () => {
    const r = renderSettings(DEFAULTS)
    for (const key of ['python', 'outputDir', 'autoRender']) assert.equal(r[key], undefined)
    assert.equal(r.style, 'real')
    assert.equal(Object.keys(r).length, SETTINGS.length - 3)
  })

  it('writes manifest entries without empty fields', () => {
    const entry = manifestEntry(SETTINGS.find((s) => s.key === 'mask'))
    assert.deepEqual(Object.keys(entry).sort(), ['default', 'description', 'key', 'title', 'type'])
  })
})
