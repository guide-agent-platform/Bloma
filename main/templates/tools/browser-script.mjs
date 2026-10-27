// Child process only: the platform supplies this project's owned browser and a
// clean engineering environment. Never import user code in the Bloma main process.
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { expect } from 'playwright/test'
import { connectApp } from './browser-context.mjs'
import { bindScreenshotEvidence } from './browser-evidence.mjs'

try {
  const { page, context } = await connectApp()
  const evidenceDir = bindScreenshotEvidence(page, context)
  const script = await import(pathToFileURL(process.argv[2]).href)
  if (typeof script.default !== 'function') throw Error('BROWSER_SCRIPT_DEFAULT_FUNCTION_REQUIRED')
  const value = await script.default({ page, context, expect, assert, dataDir: process.env.APP_DATA_DIR, evidenceDir })
  const output = JSON.stringify({ result: value ?? null })
  await new Promise(resolve => process.stdout.write(output.slice(0, 12000) + '\n', resolve))
  // Disconnect the child socket by exiting, never browser.close(): the app and
  // persistent context belong to the parent, including after failed assertions.
  process.exit(0)
} catch (error) {
  await new Promise(resolve => process.stderr.write(String(error?.stack ?? error).slice(0, 12000) + '\n', resolve))
  process.exit(1)
}
