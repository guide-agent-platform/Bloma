// 最小 MCP stdio server（真进程）：L-DJSON over stdio。
// 故意包含：非 JSON 行（健壮性）、stderr 输出（客户端须不误读为响应）、tools/call 延迟（真实时序）。
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
process.stdout.write('server: ready (non-json line)\n'); // 垃圾行：客户端必须跳过

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { process.stderr.write(`bad json: ${line.slice(0, 40)}\n`); return; }
  if (msg.id === undefined && msg.method) { // 通知：无 id 不回（判据是缺 id，不是有 method）
    if (msg.method === 'notifications/initialized') process.stderr.write('server: got initialized\n');
    return;
  }
  const id = msg.id;
  const reply = (result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n');
  if (msg.method === undefined && msg.params === undefined) { /* impossible */ }
  switch (msg.params?.method ?? msg.params?.name ?? '') { /* unused */ }
  // 请求分发按 method 字段
  const m = msg.method;
  if (m === 'initialize') {
    reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.1.0' } });
  } else if (m === 'tools/list') {
    reply({ tools: [
      { name: 'echo', description: 'echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'fail', description: 'always errors', inputSchema: { type: 'object' } },
    ] });
  } else if (m === 'tools/call') {
    const tool = msg.params?.name;
    if (tool === 'echo') {
      setTimeout(() => reply({ content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text ?? ''}` }], isError: false }), 60); // 真实延迟
    } else if (tool === 'fail') {
      reply({ content: [{ type: 'text', text: 'boom' }], isError: true });
    } else {
      reply(undefined, { code: -32601, message: `unknown tool: ${tool}` });
    }
  } else {
    reply(undefined, { code: -32601, message: `method not found: ${m}` });
  }
});
