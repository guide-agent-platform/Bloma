// No window, network, plaintext key logging or credential edits.
const { app, safeStorage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const [home, output] = process.argv.slice(2)
if (!home || !output) throw new Error('Explicit test home/output required')
app.setPath('userData', join(home, 'electron-user-data'))
app.whenReady().then(() => {
  const config = JSON.parse(readFileSync(join(home, 'bloma-channels.json'), 'utf8'))
  const available = safeStorage.isEncryptionAvailable()
  const channels = config.channels.map(channel => {
    let decryptable = false
    try { decryptable = available && Boolean(safeStorage.decryptString(Buffer.from(channel.api_key, 'hex'))) } catch { /* never print key or error contents */ }
    return { id: channel.id, provider: channel.provider_type, enabled: channel.enabled === true,
      enabled_models: (channel.models ?? []).filter(model => model.enabled).length, decryptable }
  })
  const report = { encryption_available: available, channels, usable_count: channels.filter(c => c.enabled && c.decryptable && c.enabled_models).length }
  writeFileSync(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  app.quit()
}).catch(() => { console.error('Channel preflight failed'); app.exit(2) })
