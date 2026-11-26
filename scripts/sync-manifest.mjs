import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_VERSION } from '../lib/runtime.mjs'
import { SETTINGS, manifestEntry } from '../lib/settings.mjs'

export const COMMAND_TITLES = Object.freeze({
  'open-editor': 'ASCII Glyphscape: Open editor (live preview)',
  'choose-media': 'ASCII Glyphscape: Choose image or video…',
  'render-now': 'ASCII Glyphscape: Render now',
  'cancel-render': 'ASCII Glyphscape: Cancel render',
  'reset-settings': 'ASCII Glyphscape: Reset settings',
  'setup-checklist': 'ASCII Glyphscape: Show setup checklist'
})

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'orca-plugin.json')

export function generated(manifest) {
  const { themes, terminalThemes, ...contributes } = manifest.contributes
  return {
    ...manifest,
    version: PLUGIN_VERSION,
    contributes: {
      ...contributes,
      commands: Object.entries(COMMAND_TITLES).map(([id, title]) => ({ id, title })),
      settings: SETTINGS.map(manifestEntry)
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, `${JSON.stringify(generated(manifest), null, 2)}\n`)
  console.log(`updated ${file}`)
}
