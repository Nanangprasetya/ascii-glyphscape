import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime } from './lib/runtime.mjs'

let runtime = null

export default function activate(orca) {
  runtime = createRuntime(orca, { pluginRoot: dirname(fileURLToPath(import.meta.url)) })
  runtime.register()
  runtime.start()
}

export async function deactivate() {
  const current = runtime
  runtime = null
  await current?.dispose()
}
