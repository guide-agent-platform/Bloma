const { app, safeStorage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const USER_DATA = process.argv[4] || ''
if (USER_DATA) app.setPath('userData', USER_DATA)
app.whenReady().then(() => {
  const p = process.argv[2]
  const outP = process.argv[3]
  console.log('userData:', app.getPath('userData'))
  const d = JSON.parse(readFileSync(p, 'utf-8'))
  const chs = Array.isArray(d.channels) ? d.channels : d
  const result = {}
  for (const c of chs) {
    const enc = c.apiKey || c.api_key
    if (!enc) continue
    try {
      const buf = enc.length > 60 && /^[0-9a-f]+$/i.test(enc) ? Buffer.from(enc, 'hex') : Buffer.from(enc, 'base64')
      const plain = safeStorage.decryptString(buf)
      result[c.name || c.id] = { provider: c.provider || c.provider_type, baseUrl: c.baseUrl || c.base_url, apiKey: plain }
      // 同名渠道支持：额外按 id 前 8 位索引（不被同名覆盖）
      const shortId = String(c.id || '').slice(0, 8)
      if (shortId) result['id:' + shortId] = result[c.name || c.id]
      console.log('OK:', c.name || c.id, '(id:' + shortId + ')')
    } catch (e) {
      result[c.name || c.id] = { provider: c.provider, error: '解密失败: ' + e.message.slice(0, 80) }
      console.log('FAIL:', c.name || c.id, e.message.slice(0, 80))
    }
  }
  writeFileSync(outP, JSON.stringify(result, null, 2), 'utf-8')
  app.exit(0)
})
