/**
 * 应用服务器（real-fullstack 骨架）——这是你自己项目的真实入口文件，可读可改。
 * 业界标准形态：Express 应用，`npm start`（node server.js）启动。
 * 平台只在拉起本进程时注入环境变量：PORT（监听端口）与 BLOMA_APP_LLM_*（AI 代理密钥，
 * 密钥只存在于进程环境，永远不会出现在代码里）。
 */
'use strict';

const express = require('express');
const { mountLlmProxy } = require('./server/llm-proxy');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// JSON body 解析（/api/* 请求体）
app.use(express.json({ limit: '512kb' }));

// CSP 中间件（与平台 main/coding/product-csp.ts 真相源保持同步；同源边界是安全底线）
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'",
  );
  next();
});

// ---- 静态托管：前端产物（index.html / dist / src/styles.css 等）----
app.use(express.static('.'));

// ---- AI 能力代理（预置，读环境变量；如需扩展再改 server/llm-proxy.js）----
mountLlmProxy(app);

// ---- 业务路由：按 PRD【后端 API 契约】在这里（或 require('./server/routes/xx')）实现 ----
// 业界标准写法示例（实现时替换为真实端点）：
//   const { readData, writeData } = require('./server/db');
//   app.get('/api/records', (req, res) => {
//     res.json({ records: readData('records', []) });
//   });
//   app.post('/api/records', (req, res) => {
//     const list = readData('records', []);
//     list.push(req.body);
//     writeData('records', list);
//     res.json({ ok: true, id: list.length });
//   });

// 404 兜底（API 与页面统一）
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'not_found', path: req.path });
  } else {
    res.status(404).send('Not Found');
  }
});

// 错误中间件：真实堆栈进 stderr（平台会把服务日志回流给调试与用户）
app.use((err, req, res, next) => { // eslint-disable-line @typescript-eslint/no-unused-vars
  console.error('[server] 未捕获错误:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'route_error', message: String((err && err.message) || err).slice(0, 200) });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://127.0.0.1:${PORT}`);
});
