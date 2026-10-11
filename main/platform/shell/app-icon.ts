import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Temporary user-supplied brand asset, shared by window and future packaging. */
export function appIconPath(): string | undefined {
  const name = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  return [
    join(app.getAppPath(), 'resources', 'branding', name),
    join(process.resourcesPath, 'branding', name),
  ].find(path => existsSync(path))
}
