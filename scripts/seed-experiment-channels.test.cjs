const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

async function seeded(plan) {
  const files = new Map()
  let ready
  const env = { PROMA_HOME: join(require('node:os').tmpdir(), 'isolated-seed-test'), BEX_DEEPSEEK_API_KEY: 'test-ds', BEX_GLM_API_KEY: 'test-glm',
    ...(plan === undefined ? {} : { BEX_GLM_PLAN: plan }) }
  const electron = { app: { setPath() {}, whenReady: () => ({ then(fn) { ready = Promise.resolve().then(fn); return ready } }), quit() {}, exit(code) { throw new Error(`exit:${code}`) } },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`encrypted:${value}`) } }
  vm.runInNewContext(readFileSync(join(__dirname, 'seed-experiment-channels.cjs'), 'utf8'), {
    process: { env }, console: { log() {}, error() {} }, Buffer,
    require(name) { return name === 'electron' ? electron : name === 'node:fs' ? { mkdirSync() {}, writeFileSync: (path, value) => files.set(path, value) } : require(name) },
  })
  await ready
  return JSON.parse(files.get(join(env.PROMA_HOME, 'bloma-channels.json'))).channels
}
test('defaults to historical regular GLM routing', async () => {
  const channels = await seeded()
  assert.equal(channels[1].provider_type, 'zhipu')
  assert.equal(channels[1].base_url, 'https://open.bigmodel.cn/api/paas/v4')
})
test('Coding Plan uses native Anthropic route and encrypted credentials', async () => {
  const channels = await seeded('coding')
  assert.equal(channels[1].provider_type, 'zhipu-coding')
  assert.equal(channels[1].base_url, 'https://open.bigmodel.cn/api/anthropic')
  assert.equal(channels[1].models[0].name, 'glm-5.3')
  assert.equal(channels[1].models.filter(model => model.id === 'glm-5.3-flash' && model.enabled && model.supports_tools).length, 1)
  assert.equal(channels[1].max_tokens, 131072)
  assert.equal(channels[0].models[0].name, 'deepseek-flash')
  assert.ok(!JSON.stringify(channels).includes('test-glm'))
})
test('invalid plan fails before credential seeding', async () => {
  await assert.rejects(() => seeded('codng'), /EXPERIMENT_INVALID_GLM_PLAN/)
})
