import { spawn } from 'node:child_process'

const PROBE_MS = 10_000

export function pythonCandidates(setting) {
  const list = []
  const text = typeof setting === 'string' ? setting.trim() : ''
  if (text) list.push(text)
  for (const name of ['python3', '/usr/bin/python3', '/usr/local/bin/python3', 'python']) {
    if (!list.includes(name)) list.push(name)
  }
  return list
}

export function run(file, args, { env = process.env, timeoutMs = PROBE_MS, cwd } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error.message })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: stderr || error.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

const found = new Map()

export async function findPython(setting, { runner = run, env } = {}) {
  const key = String(setting ?? '')
  if (found.has(key)) return found.get(key)
  for (const candidate of pythonCandidates(setting)) {
    const result = await runner(candidate, ['-I', '-c', 'import PIL'], { env })
    if (result.code === 0) {
      found.set(key, candidate)
      return candidate
    }
  }
  return null
}

export function forgetPython() {
  found.clear()
}
