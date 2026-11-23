import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clamp, statusView } from '../lib/status.mjs'

describe('status bar', () => {
  it('shows progress, success and errors', () => {
    assert.equal(statusView({ phase: 'rendering', progress: 0.427, text: 'Dark: frame 3' }).text, 'ASCII 43%')
    assert.equal(statusView({ phase: 'ok', size: [2560, 1440], finishedAt: 0 }).tone, 'success')
    const error = statusView({ phase: 'error', error: 'x'.repeat(400) })
    assert.equal(error.tone, 'danger')
    assert.ok(error.tooltip.length <= 256)
    assert.equal(statusView(undefined).text, 'ASCII')
  })

  it('clamps text', () => {
    assert.equal(clamp('a  b\n c', 64), 'a b c')
    assert.equal(clamp('abcdef', 4).length, 4)
  })
})
