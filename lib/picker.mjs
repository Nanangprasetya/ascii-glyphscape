import { extname } from 'node:path'

export const MEDIA_EXTENSIONS = Object.freeze(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'avif', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'])
const TITLE = 'ASCII Glyphscape: choose a picture or video'

export function dialogCommands({ home, start } = {}) {
  const patterns = MEDIA_EXTENSIONS.map((e) => `*.${e}`).join(' ')
  const from = start || home || '/'
  return [
    { file: 'kdialog', args: ['--title', TITLE, '--getopenfilename', from, `Pictures and videos (${patterns})`] },
    { file: 'zenity', args: ['--file-selection', `--title=${TITLE}`, `--filename=${from.endsWith('/') ? from : `${from}/`}`, `--file-filter=Pictures and videos | ${patterns}`, '--file-filter=All files | *'] }
  ]
}

export function isMedia(path) {
  return MEDIA_EXTENSIONS.includes(extname(String(path)).slice(1).toLowerCase())
}

export async function chooseFile({ run, env, home, start }) {
  const failures = []
  for (const { file, args } of dialogCommands({ home, start })) {
    const result = await run(file, args, { env, timeoutMs: 30 * 60_000 })
    if (result.code === -1 && /ENOENT/.test(result.stderr)) {
      failures.push(`${file} is not installed`)
      continue
    }
    if (result.code === 0) {
      const path = result.stdout.split('\n').map((line) => line.trim()).find(Boolean)
      return path ? { path } : { cancelled: true }
    }
    if (result.code === 1 || result.code === 5 || result.code === 255) return { cancelled: true }
    failures.push(`${file} failed: ${result.stderr.trim().slice(-200) || `exit ${result.code}`}`)
  }
  return { error: failures.join('; ') || 'no file dialog program found' }
}
