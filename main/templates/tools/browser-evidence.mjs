import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

// The host owns this directory for this execution. Relative screenshot paths
// from existing suites are interpreted here, never against the release cwd.
export function bindScreenshotEvidence(page, context) {
  const evidenceDir = process.env.BLOMA_EVIDENCE_DIR
  if (!evidenceDir || !isAbsolute(evidenceDir)) throw Error('EVIDENCE_DIRECTORY_REQUIRED')
  const bound = new WeakSet()
  const bind = target => {
    if (bound.has(target)) return
    bound.add(target)
    if (typeof target.screenshot === 'function') {
      const screenshot = target.screenshot.bind(target)
      target.screenshot = async (options = {}) => {
      if (!options.path) return screenshot(options)
      const path = resolve(evidenceDir, options.path), rel = relative(evidenceDir, path)
      if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
        throw Error('EVIDENCE_PATH_OUTSIDE_DIRECTORY: use evidenceDir or a relative screenshot path')
      mkdirSync(dirname(path), { recursive: true })
      return screenshot({ ...options, path })
      }
    }
    for (const method of ['locator', 'getByRole', 'getByLabel', 'getByPlaceholder', 'getByText', 'getByTestId', 'getByTitle', 'getByAltText', 'filter', 'first', 'last', 'nth']) {
      if (typeof target[method] !== 'function') continue
      const original = target[method].bind(target)
      target[method] = (...args) => { const locator = original(...args); bind(locator); return locator }
    }
  }
  for (const target of context.pages()) bind(target)
  bind(page)
  context.on('page', bind)
  return evidenceDir
}
