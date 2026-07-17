import { readFileSync } from 'node:fs'

const shared = readFileSync(new URL('../shared/types.ts', import.meta.url), 'utf8')
const required = [
  'agent:send-message',
  'agent:stop',
  'agent:stream-event',
  'permission:response',
  'project:create',
  'snapshot:rollback',
  'analytics:track',
]

const missing = required.filter((channel) => !shared.includes(channel))
if (missing.length) {
  console.error(`Missing IPC channels: ${missing.join(', ')}`)
  process.exit(1)
}

console.log('docs:check passed')
