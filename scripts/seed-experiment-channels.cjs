// Credentials arrive only through process environment. Each isolated Electron user-data
// directory gets its own safeStorage ciphertext; snapshots never include this file.
const { app, safeStorage } = require('electron')
const { join, resolve } = require('node:path')
const { homedir } = require('node:os')
const { mkdirSync, writeFileSync } = require('node:fs')
const home = resolve(process.env.PROMA_HOME || '')
const preparationMaxTokens = Number(process.env.BEX_PREPARATION_MAX_TOKENS || '640000')
const glmPlan = process.env.BEX_GLM_PLAN || 'regular'
if (!['regular', 'coding'].includes(glmPlan)) throw new Error('EXPERIMENT_INVALID_GLM_PLAN')
if (!Number.isSafeInteger(preparationMaxTokens) || preparationMaxTokens < 1024 || preparationMaxTokens > 640000) throw new Error('EXPERIMENT_INVALID_PREPARATION_TOKEN_CAP')
if (!process.env.PROMA_HOME || home.toLowerCase() === join(homedir(), '.proma').toLowerCase()) throw new Error('EXPERIMENT_REQUIRES_ISOLATED_HOME')
app.setPath('userData', join(home, 'electron-user-data'))
app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('EXPERIMENT_ENCRYPTION_UNAVAILABLE')
  const definitions = [
    ['experiment-ds', 'DeepSeek Flash', 'deepseek', 'https://api.deepseek.com/anthropic', 'deepseek-flash', process.env.BEX_DEEPSEEK_API_KEY],
    glmPlan === 'coding'
      ? ['experiment-glm', 'GLM Coding Plan', 'zhipu-coding', 'https://open.bigmodel.cn/api/anthropic', 'glm-5.3', process.env.BEX_GLM_API_KEY]
      : ['experiment-glm', 'GLM 常规 API', 'zhipu', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', process.env.BEX_GLM_API_KEY],
  ]
  const channels = definitions.map(([id, name, provider_type, base_url, model, key]) => {
    if (!key) throw new Error('EXPERIMENT_CREDENTIAL_MISSING')
    return { id, name, provider_type, base_url, api_key: safeStorage.encryptString(key).toString('hex'),
      models: [{ id: model, name: model, enabled: true, supports_tools: true },
        ...(id === 'experiment-ds' ? [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', enabled: true, supports_tools: true }] : [])],
      enabled: true, max_tokens: id === 'experiment-ds' ? preparationMaxTokens : Math.min(preparationMaxTokens, 131072) }
  })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'bloma-channels.json'), JSON.stringify({ version: 1, channels }), 'utf8')
  // Preparation and all non-experiment auxiliary roles use the common M1.
  writeFileSync(join(home, 'category-routing.json'), JSON.stringify({ version: 1, routing: Object.fromEntries(
    ['guide', 'prd', 'sketch', 'mvp', 'judge', 'audit', 'summary'].map(category => [category, { channel_id: 'experiment-ds' }])) }), 'utf8')
  console.log('EXPERIMENT_CHANNELS_ENCRYPTED')
  app.quit()
}).catch(() => { console.error('EXPERIMENT_CHANNEL_SEED_FAILED'); app.exit(1) })
