// Child process only: the platform supplies this project's owned browser and a
// clean engineering environment. Never import user code in the Bloma main process.
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect } from 'playwright/test'

try {
  const endpoint = new URL(process.env.BLOMA_DEBUG_CDP ?? '')
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw Error('BROWSER_SCRIPT_OWNED_ENDPOINT_REQUIRED')
  const downloads = join(process.env.APP_DATA_DIR, 'browser-downloads'); mkdirSync(downloads, { recursive: true })
  const browser = await chromium.connectOverCDP(endpoint.href, { isLocal: true, artifactsDir: downloads })
  const pages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === process.env.BLOMA_DEBUG_PAGE)
  if (pages.length !== 1) throw Error('BROWSER_SCRIPT_PAGE_NOT_UNIQUE')
  const page = pages[0]
  page.setDefaultTimeout(5000)
  const script = await import(pathToFileURL(process.argv[2]).href)
  if (typeof script.default !== 'function') throw Error('BROWSER_SCRIPT_DEFAULT_FUNCTION_REQUIRED')
  const value = await script.default({ page, context: page.context(), expect, assert, dataDir: process.env.APP_DATA_DIR })
  const output = JSON.stringify({ result: value ?? null })
  await new Promise(resolve => process.stdout.write(output.slice(0, 12000) + '\n', resolve))
  // Disconnect the child socket by exiting, never browser.close(): the app and
  // persistent context belong to the parent, including after failed assertions.
  process.exit(0)
} catch (error) {
  await new Promise(resolve => process.stderr.write(String(error?.stack ?? error).slice(0, 12000) + '\n', resolve))
  process.exit(1)
}
