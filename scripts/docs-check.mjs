import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const shared = readFileSync(new URL('shared/types.ts', root), 'utf8')

const expectedChannels = [
  'agent:send-message',
  'agent:stop',
  'agent:list-sessions',
  'agent:load-messages',
  'agent:stream-event',
  'permission:response',
  'project:create',
  'project:list',
  'project:confirm-sketch',
  'project:submit-correction',
  'project:archive',
  'project:upgrade',
  'sandbox:run',
  'sandbox:stop',
  'snapshot:create',
  'snapshot:rollback',
  'document:sync',
  'analytics:track',
]

const channels = [...shared.matchAll(/^\s*\w+:\s*['"]([\w:-]+)['"],?$/gm)].map((match) => match[1])
const missing = expectedChannels.filter((channel) => !channels.includes(channel))
if (missing.length) {
  console.error(`Missing IPC channels: ${missing.join(', ')}`)
  process.exit(1)
}

const hardcodedPattern = /(?:ipcMain\.handle|ipcRenderer\.(?:invoke|on|send)|webContents\.send)\(\s*['"][\w:-]+['"]/g
for (const dir of ['main', 'preload', 'renderer']) {
  scanDir(new URL(`${dir}/`, root), (file, content) => {
    const matches = content.match(hardcodedPattern)
    if (matches) {
      console.error(`Hardcoded IPC channel in ${file}: ${matches.join(', ')}`)
      process.exit(1)
    }
  })
}

console.log('docs:check passed')

function scanDir(dirUrl, visit) {
  const dirPath = fileURLToPath(dirUrl)
  for (const entry of readdirSync(dirPath)) {
    const path = join(dirPath, entry)
    if (statSync(path).isDirectory()) {
      scanDir(new URL(`${entry}/`, dirUrl), visit)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    visit(path, readFileSync(path, 'utf8'))
  }
}
