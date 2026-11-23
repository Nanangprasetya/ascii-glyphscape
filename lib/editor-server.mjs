import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { readJson, writeJson } from './paths.mjs'

export const RPC_BODY_MAX_BYTES = 256 * 1024
export const UPLOAD_MAX_BYTES = 512 * 1024 * 1024
const HOST = '127.0.0.1'
const TOKEN_BYTES = 16
const MAX_CONNECTIONS = 48
const RPC_NAME_RE = /^[a-z][A-Za-z]{0,63}$/
const ASSET_NAME_RE = /^[a-z0-9-]+\.(js|css|svg)$/
const THUMB_ID_RE = /^[a-f0-9]{16}$/
const CONTENT_TYPES = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8'
}

export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'no-store'
}

export class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function newToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

function sameToken(given, expected) {
  const a = Buffer.from(String(given))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function validStored(value) {
  return (
    value &&
    typeof value === 'object' &&
    Number.isInteger(value.port) &&
    value.port > 1023 &&
    value.port < 65536 &&
    typeof value.token === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(value.token)
  )
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host: HOST, port, exclusive: true })
  })
}

export function createEditorServer({ root, stateFile, call, has, thumb, upload, log = () => {}, uploadMax = UPLOAD_MAX_BYTES }) {
  let server = null
  let port = 0
  let token = ''
  let starting = null
  let assets = new Set()
  let disposed = false

  function send(response, status, headers = {}, body = '') {
    if (response.headersSent || response.destroyed) return
    response.writeHead(status, { ...SECURITY_HEADERS, ...headers })
    response.end(body)
  }

  function sendJson(response, status, value) {
    send(response, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(value))
  }

  function failure(error) {
    const known = error instanceof RpcError || typeof error?.code === 'string'
    return { ok: false, error: { code: known ? error.code : 'action_failed', message: known ? error.message : 'The request failed.' } }
  }

  async function serveFile(response, path, type) {
    try {
      send(response, 200, { 'Content-Type': CONTENT_TYPES[type] }, await readFile(path))
    } catch {
      send(response, 404)
    }
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > RPC_BODY_MAX_BYTES) {
          chunks.length = 0
          reject(new RpcError('too_large', 'The request is too large.'))
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks)))
      request.on('error', reject)
    })
  }

  function sameOrigin(request) {
    return request.headers.origin === `http://${HOST}:${port}`
  }

  async function handleRpc(request, response, name) {
    if (!sameOrigin(request)) return send(response, 403)
    if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(response, 415)
    if (!RPC_NAME_RE.test(name) || !has(name)) {
      return sendJson(response, 200, { ok: false, error: { code: 'unknown_method', message: 'Unknown request.' } })
    }
    try {
      const body = await readBody(request)
      let payload
      try {
        payload = JSON.parse(body.toString('utf8') || '{}')
      } catch {
        throw new RpcError('invalid_request', 'The request is not valid JSON.')
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new RpcError('invalid_request', 'The request must be an object.')
      sendJson(response, 200, { ok: true, result: await call(name, payload.input ?? {}) })
    } catch (error) {
      if (error?.code !== 'superseded' && !(error instanceof RpcError)) log(`editor request ${name} failed: ${describe(error)}`)
      if (error?.code === 'too_large') response.on('finish', () => request.destroy())
      sendJson(response, 200, failure(error))
    }
  }

  async function handleUpload(request, response) {
    if (!sameOrigin(request)) return send(response, 403)
    if (String(request.headers['content-type'] ?? '').toLowerCase() !== 'application/octet-stream') return send(response, 415)
    let name = ''
    try {
      name = decodeURIComponent(String(request.headers['x-file-name'] ?? ''))
    } catch {
      name = ''
    }
    const size = Number(request.headers['content-length'])
    if (!name || name.length > 255) return sendJson(response, 200, failure(new RpcError('invalid_request', 'The file has no name.')))
    if (!Number.isFinite(size) || size <= 0) return sendJson(response, 411, failure(new RpcError('invalid_request', 'The upload has no length.')))
    if (size > uploadMax) {
      response.on('finish', () => request.destroy())
      return sendJson(response, 200, failure(new RpcError('too_large', 'Files up to 512 MB can be uploaded; choose a larger one with "Browse".')))
    }
    try {
      sendJson(response, 200, { ok: true, result: await upload(request, { name, size }) })
    } catch (error) {
      if (!(error instanceof RpcError)) log(`editor upload failed: ${describe(error)}`)
      response.on('finish', () => request.destroy())
      sendJson(response, 200, failure(error))
    }
  }

  async function handle(request, response) {
    if (request.headers.host !== `${HOST}:${port}`) return send(response, 403)
    let pathname
    try {
      pathname = new URL(request.url, `http://${HOST}:${port}`).pathname
    } catch {
      return send(response, 400)
    }
    const parts = pathname.split('/')
    if (parts.length < 3 || !sameToken(parts[1], token)) return send(response, 404)
    const rest = parts.slice(2)
    if (request.method === 'POST') {
      if (rest.length === 2 && rest[0] === 'rpc') return handleRpc(request, response, rest[1])
      if (rest.length === 1 && rest[0] === 'upload') return handleUpload(request, response)
      return send(response, 404)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, { Allow: 'GET, HEAD, POST' })
    if (rest.length === 1 && rest[0] === '') return serveFile(response, join(root, 'index.html'), 'html')
    if (rest.length === 2 && rest[0] === 'assets' && ASSET_NAME_RE.test(rest[1]) && assets.has(rest[1])) {
      return serveFile(response, join(root, rest[1]), rest[1].split('.').pop())
    }
    if (rest.length === 2 && rest[0] === 'thumb' && THUMB_ID_RE.test(rest[1])) {
      const found = await thumb(rest[1]).catch(() => null)
      if (!found) return send(response, 404)
      return send(response, 200, { 'Content-Type': found.type, 'Cache-Control': 'private, max-age=600' }, found.data)
    }
    return send(response, 404)
  }

  async function start() {
    const stored = await readJson(stateFile)
    const remembered = validStored(stored) ? stored : null
    assets = new Set((await readdir(root)).filter((name) => ASSET_NAME_RE.test(name)))
    const created = http.createServer((request, response) => {
      handle(request, response).catch((error) => {
        log(`editor server: ${describe(error)}`)
        send(response, 500)
      })
    })
    created.maxConnections = MAX_CONNECTIONS
    created.on('clientError', (_error, socket) => socket.destroy())
    let boundPort
    let nextToken
    try {
      boundPort = await listen(created, remembered?.port ?? 0)
      nextToken = remembered?.token ?? newToken()
    } catch (error) {
      if (!remembered || error?.code !== 'EADDRINUSE') throw error
      boundPort = await listen(created, 0)
      nextToken = newToken()
    }
    if (disposed) {
      created.close()
      throw new Error('the plugin is shutting down')
    }
    server = created
    port = boundPort
    token = nextToken
    if (!remembered || remembered.port !== port || remembered.token !== token || stored.opened !== true) {
      await writeJson(stateFile, { ...(stored ?? {}), port, token, opened: true }).catch((error) => log(`editor server: could not remember its address: ${describe(error)}`))
    }
    log(`editor server listening on ${HOST}:${port}`)
  }

  return {
    async ensure() {
      if (!server) {
        starting ??= start().finally(() => {
          starting = null
        })
        await starting
      }
      const origin = `http://${HOST}:${port}`
      return { origin, port, url: `${origin}/${token}/` }
    },
    async resume() {
      const stored = await readJson(stateFile)
      if (validStored(stored) && stored.opened === true) {
        await this.ensure()
        return true
      }
      return false
    },
    get running() {
      return server !== null
    },
    async dispose() {
      disposed = true
      const current = server
      server = null
      if (current) {
        current.closeAllConnections?.()
        await new Promise((resolve) => current.close(() => resolve()))
      }
    }
  }
}
