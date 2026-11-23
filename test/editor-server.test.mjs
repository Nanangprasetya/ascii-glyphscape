import assert from 'node:assert/strict'
import http from 'node:http'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RpcError, SECURITY_HEADERS, createEditorServer } from '../lib/editor-server.mjs'
import { tempDir } from './helpers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'editor')

async function serve(t, extra = {}) {
  const uploads = []
  const server = createEditorServer({
    root,
    stateFile: join(t.dir, 'editor.json'),
    call: async (name, input) => {
      if (name === 'boom') throw new Error('secret internals')
      if (name === 'known') throw new RpcError('in_use', 'That file is in use.')
      return { echo: input }
    },
    has: (name) => ['echo', 'boom', 'known'].includes(name),
    thumb: async (id) => (id === 'a'.repeat(16) ? { type: 'image/jpeg', data: Buffer.from('jpg') } : null),
    upload: async (request, info) => {
      let size = 0
      for await (const chunk of request) size += chunk.length
      uploads.push({ ...info, got: size })
      return { stored: info.name }
    },
    uploadMax: 1024,
    ...extra
  })
  const { url, origin, port } = await server.ensure()
  return { server, url, origin, port, uploads }
}

function raw(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = []
      response.on('data', (c) => chunks.push(c))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }))
    })
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

describe('editor server', () => {
  it('serves the page and its listed assets only behind the token, with a strict policy', async () => {
    const t = await tempDir()
    const s = await serve(t)
    try {
      const page = await fetch(s.url)
      assert.equal(page.status, 200)
      assert.equal(page.headers.get('content-security-policy'), SECURITY_HEADERS['Content-Security-Policy'])
      assert.match(await page.text(), /assets\/editor\.js/)
      assert.equal((await fetch(`${s.url}assets/editor.js`)).status, 200)
      assert.equal((await fetch(`${s.url}assets/editor.css`)).headers.get('content-type'), 'text/css; charset=utf-8')
      assert.equal((await fetch(`${s.url}assets/index.html`)).status, 404, 'only scripts, styles and icons')
      assert.equal((await fetch(`${s.url}assets/..%2Feditor.js`)).status, 404)
      assert.equal((await fetch(`${s.origin}/`)).status, 404)
      assert.equal((await fetch(`${s.origin}/${'A'.repeat(22)}/`)).status, 404, 'a wrong token looks like nothing')
      const tokenPath = new URL(s.url).pathname
      assert.equal((await raw(s.port, tokenPath, { headers: { Host: 'evil.example' } })).status, 403, 'DNS rebinding')
      assert.equal((await fetch(`${s.url}thumb/${'a'.repeat(16)}`)).status, 200)
      assert.equal((await fetch(`${s.url}thumb/${'b'.repeat(16)}`)).status, 404)
      const dots = await raw(s.port, `${tokenPath}thumb/..`)
      assert.equal(dots.status, 200)
      assert.match(dots.body, /<title>ASCII Glyphscape/, 'thumb/.. is the page itself')
      assert.equal((await raw(s.port, `${tokenPath}assets/../../lib/runtime.mjs`)).status, 404)
      assert.equal((await raw(s.port, `${tokenPath}assets/%2e%2e%2fpaths.mjs`)).status, 404)
    } finally {
      await s.server.dispose()
      await t.cleanup()
    }
  })

  it('answers requests only from its own origin, as JSON, and hides unexpected errors', async () => {
    const t = await tempDir()
    const s = await serve(t)
    const rpc = (name, { origin = s.origin, type = 'application/json', body = JSON.stringify({ input: { a: 1 } }) } = {}) =>
      fetch(`${s.url}rpc/${name}`, { method: 'POST', headers: { 'Content-Type': type, Origin: origin }, body })
    try {
      assert.deepEqual(await (await rpc('echo')).json(), { ok: true, result: { echo: { a: 1 } } })
      assert.equal((await rpc('echo', { origin: 'http://evil.example' })).status, 403)
      assert.equal((await rpc('echo', { type: 'text/plain' })).status, 415, 'a plain form cannot reach it')
      assert.equal((await (await rpc('nope')).json()).error.code, 'unknown_method')
      assert.equal((await (await rpc('echo', { body: '[1]' })).json()).error.code, 'invalid_request')
      assert.equal((await (await rpc('echo', { body: 'x'.repeat(300 * 1024) })).json()).error.code, 'too_large')
      const boom = await (await rpc('boom')).json()
      assert.deepEqual(boom.error, { code: 'action_failed', message: 'The request failed.' })
      assert.deepEqual((await (await rpc('known')).json()).error, { code: 'in_use', message: 'That file is in use.' })
    } finally {
      await s.server.dispose()
      await t.cleanup()
    }
  })

  it('takes uploads with a name, a length and its own origin, up to the limit', async () => {
    const t = await tempDir()
    const s = await serve(t)
    const up = (body, headers = {}) =>
      fetch(`${s.url}upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: s.origin, 'X-File-Name': encodeURIComponent('my cat.png'), ...headers }, body })
    try {
      assert.deepEqual(await (await up('12345')).json(), { ok: true, result: { stored: 'my cat.png' } })
      assert.deepEqual(s.uploads, [{ name: 'my cat.png', size: 5, got: 5 }])
      assert.equal((await up('12345', { Origin: 'http://evil.example' })).status, 403)
      assert.equal((await up('12345', { 'Content-Type': 'text/plain' })).status, 415)
      assert.equal((await (await up('12345', { 'X-File-Name': '' })).json()).error.code, 'invalid_request')
      assert.equal((await (await up('x'.repeat(2048))).json()).error.code, 'too_large')
      assert.equal(s.uploads.length, 1)
    } finally {
      await s.server.dispose()
      await t.cleanup()
    }
  })

  it('comes back at the same address, so a restored tab keeps working', async () => {
    const t = await tempDir()
    const first = await serve(t)
    await first.server.dispose()
    const again = await serve(t)
    try {
      assert.equal(again.url, first.url)
      const fresh = createEditorServer({ root, stateFile: join(t.dir, 'other.json'), call: async () => ({}), has: () => false, thumb: async () => null, upload: async () => ({}) })
      assert.equal(await fresh.resume(), false, 'never opened: nothing starts')
      assert.equal(fresh.running, false)
    } finally {
      await again.server.dispose()
      await t.cleanup()
    }
  })
})
