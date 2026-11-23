import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJson } from './paths.mjs'

export const JOB_KEEP_MS = 24 * 60 * 60_000
const CANCEL_WAIT_MS = 5000

export function newJobId(now = Date.now()) {
  return `${now.toString(36)}-${randomBytes(4).toString('hex')}`
}

export function jobFiles(jobsDir, id) {
  return {
    job: join(jobsDir, `${id}.json`),
    config: join(jobsDir, `cfg-${id}.json`),
    log: join(jobsDir, `${id}.log`)
  }
}

export function alive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export async function startJob({ python, cli, jobsDir, config, env, spawn = nodeSpawn, id = newJobId() }) {
  const files = jobFiles(jobsDir, id)
  await writeJson(files.config, { ...config, jobFile: files.job, cleanup: files.config })
  await writeJson(files.job, { state: 'running', pid: null, progress: 0, text: 'Starting', result: null, startedAt: Date.now(), updatedAt: Date.now() })
  let log = 'ignore'
  try {
    log = openSync(files.log, 'a')
  } catch {
  }
  let child
  try {
    child = spawn(python, ['-I', '-B', cli, 'render', files.config], { detached: true, stdio: ['ignore', log, log], env })
  } finally {
    if (typeof log === 'number') closeSync(log)
  }
  child.on?.('error', () => undefined)
  child.unref?.()
  if (!child.pid) throw new Error(`${python} could not be started`)
  return { id, pid: child.pid, files }
}

export async function readJob(file) {
  const job = await readJson(file)
  return job && typeof job === 'object' ? job : null
}

export async function jobStatus(file, pid, { kill = process.kill } = {}) {
  const job = await readJob(file)
  if (!job) return { state: alive(pid, kill) ? 'running' : 'lost', progress: 0, text: '', result: null }
  if (job.state === 'done') return { state: 'done', progress: 1, text: job.text ?? '', result: job.result ?? null }
  const owner = Number.isInteger(job.pid) ? job.pid : pid
  if (!alive(owner, kill)) return { state: 'lost', progress: job.progress ?? 0, text: job.text ?? '', result: null }
  return { state: 'running', progress: job.progress ?? 0, text: job.text ?? '', result: null }
}

export async function cancelJob(pid, file, { kill = process.kill, waitMs = CANCEL_WAIT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!alive(pid, kill)) return false
  try {
    kill(pid, 'SIGTERM')
  } catch {
    return false
  }
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    await sleep(100)
    const job = file ? await readJob(file) : null
    if (!alive(pid, kill) || job?.state === 'done') return true
  }
  try {
    kill(-pid, 'SIGKILL')
  } catch {
    try {
      kill(pid, 'SIGKILL')
    } catch {
    }
  }
  return true
}

export async function sweepJobs(jobsDir, { keep = [], keepMs = JOB_KEEP_MS, now = Date.now() } = {}) {
  let names = []
  try {
    names = await readdir(jobsDir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (keep.some((id) => name.includes(id))) continue
    const path = join(jobsDir, name)
    try {
      if (now - (await stat(path)).mtimeMs > keepMs) {
        await rm(path, { force: true })
        removed += 1
      }
    } catch {
    }
  }
  return removed
}
