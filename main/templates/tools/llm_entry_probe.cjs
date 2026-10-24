// Host-owned local HTTP observations of the product's actual Node client.
const http = require('node:http'), net = require('node:net'), fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url')
const output = process.stdout.write.bind(process.stdout)
process.stdout.write = (...args) => process.stderr.write(...args)
async function probe(root, spec) {
  const requests = [], state = { status: 200, malformed: false }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', data => { body += data; if (body.length > 65536) req.destroy() })
    req.on('end', () => { try {
      requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
      res.writeHead(state.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(state.malformed ? {} : { choices: [{ message: { content: 'host-stub-result' } }] }))
    } catch { res.writeHead(400); res.end('{}') } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port, original = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (...args) {
    // Node's HTTP/undici clients normalize options before reaching Socket.connect.
    const options = Array.isArray(args[0]) ? args[0][0] : args[0]
    const host = typeof options === 'object' ? options.host ?? options.hostname : args[1]
    const target = typeof options === 'object' ? options.port : options
    if (Number(target) !== port || host !== '127.0.0.1') throw Error('host probe forbids external connections')
    return original.apply(this, args)
  }
  try {
    const base = fs.realpathSync(root), file = fs.realpathSync(path.resolve(base, spec.module)), rel = path.relative(base, file)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('registered module outside product')
    const module = await import(pathToFileURL(file).href), Constructor = module[spec.factory] ?? module.default?.[spec.factory]
    const instance = new Constructor(), method = instance[spec.method].bind(instance)
    const config = { endpoint: `http://127.0.0.1:${port}/v1`, model: 'host-test-model', api_key: 'host-test-key', provider: 'real', timeout: 2 }
    const invoke = async config => {
      let timer
      try {
        const response = await Promise.race([Promise.resolve().then(() => method({ prompt: 'host-test-prompt', config: { ...config } })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('entry timeout')), 3000) })])
        return typeof response === 'string' ? JSON.parse(response) : response
      } finally { clearTimeout(timer) }
    }
    const tests = []
    for (const [name, status, malformed, kind] of [['real_request', 200, false, 'success'], ['auth_error', 401, false, 'auth_error'],
      ['model_error', 404, false, 'model_error'], ['rate_limited', 429, false, 'rate_limited'], ['invalid_response', 200, true, 'invalid_response']]) {
      Object.assign(state, { status, malformed })
      const before = requests.length, response = await invoke(config), request = requests.length === before + 1 ? requests.at(-1) : undefined
      tests.push({ name, passed: !!(response && response.kind === kind && response.ok === (status === 200 && !malformed)
        && request?.path === '/v1/chat/completions' && request.auth === 'Bearer host-test-key'
        && request.body.model === 'host-test-model' && JSON.stringify(request.body.messages) === JSON.stringify([{ role: 'user', content: 'host-test-prompt' }])
        && (kind !== 'success' || response.text === 'host-stub-result')) })
    }
    const before = requests.length, response = await invoke({ ...config, api_key: '' })
    tests.push({ name: 'unconfigured', passed: response?.ok === false && response.kind === 'unconfigured' && requests.length === before })
    return { probe_version: 1, status: tests.every(t => t.passed) ? 'passed' : 'failed', tests, request_count: requests.length }
  } finally {
    net.Socket.prototype.connect = original
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
}
probe(process.argv[2], JSON.parse(process.argv[3])).catch(error => ({ probe_version: 1, status: 'environment_blocked', error: `${error.name}: registered entry could not be exercised` }))
  .then(result => { output(JSON.stringify(result)); process.exitCode = result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2 })
