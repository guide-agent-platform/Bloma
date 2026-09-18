/**
 * /api/llm 同源 AI 代理（real-fullstack 骨架，预置可改）。
 *
 * 浏览器侧 CSP 只放行同源 connect-src，模型调用一律走本代理：
 * 前端 fetch('/api/llm', { messages, ... }) → 本进程出网调用模型渠道 → { content }。
 * 密钥来自进程环境变量（平台拉起时注入，绝不出现在代码/前端）：
 *   BLOMA_APP_LLM_BASE_URL / BLOMA_APP_LLM_KEY / BLOMA_APP_LLM_MODEL
 *   BLOMA_APP_LLM_PROTOCOL（'openai' | 'anthropic'，缺省 openai）
 *   BLOMA_APP_LLM_MOCK（'true' 时确定性 mock，测试/断言用；'fail' 模拟失败形态）
 * 无密钥配置时如实 503（不静默假成功）。
 */
'use strict';

function llmEnv() {
  return {
    baseUrl: process.env.BLOMA_APP_LLM_BASE_URL || '',
    key: process.env.BLOMA_APP_LLM_KEY || '',
    model: process.env.BLOMA_APP_LLM_MODEL || '',
    protocol: process.env.BLOMA_APP_LLM_PROTOCOL || 'openai',
    mock: process.env.BLOMA_APP_LLM_MOCK || '',
  };
}

async function callUpstream(env, payload) {
  const isAnthropic = env.protocol === 'anthropic';
  const url = env.baseUrl.replace(/\/+$/, '') + (isAnthropic ? '/v1/messages' : '/v1/chat/completions');
  const headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = env.key;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${env.key}`;
  }
  const body = isAnthropic
    ? { model: env.model, max_tokens: 2048, messages: payload.messages }
    : { model: env.model, messages: payload.messages };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const data = await res.json();
  const content = isAnthropic
    ? (data.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('')
    : (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return content;
}

function mountLlmProxy(app) {
  app.post('/api/llm', async (req, res) => {
    const env = llmEnv();
    const payload = req.body || {};
    if (env.mock === 'fail') {
      res.status(502).json({ error: 'mock_fail' });
      return;
    }
    if (env.mock === 'true') {
      res.json({ content: `[mock] ${JSON.stringify(payload.messages || []).slice(0, 120)}` });
      return;
    }
    if (!env.baseUrl || !env.key || !env.model) {
      res.status(503).json({ error: 'llm_not_configured', hint: '平台未注入 BLOMA_APP_LLM_* 环境变量' });
      return;
    }
    try {
      const content = await callUpstream(env, payload);
      res.json({ content });
    } catch (err) {
      console.error('[llm-proxy] 上游调用失败:', err && err.message);
      res.status(502).json({ error: 'upstream_failed', message: String((err && err.message) || err) });
    }
  });
}

module.exports = { mountLlmProxy };
