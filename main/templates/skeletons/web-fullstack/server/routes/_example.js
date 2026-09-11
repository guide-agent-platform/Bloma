/**
 * server/routes 路由模块样例（只读参考，不要直接改动本文件）。
 *
 * 模块格式（static-server 以 CommonJS require 加载，禁用 ESM import/export）：
 *
 *   module.exports = {
 *     'GET /': async (req, res, ctx) => {
 *       // 列表：读数据用 ctx.readData('notes', [])，返回 JSON 用 ctx.sendJson(res, 200, {...})
 *       const notes = ctx.readData('notes', []);
 *       ctx.sendJson(res, 200, { records: notes });
 *     },
 *     'POST /': async (req, res, ctx) => {
 *       // 新增：请求体已在 ctx.body（JSON 已解析）；写数据用 ctx.writeData('notes', list)
 *       const notes = ctx.readData('notes', []);
 *       notes.push(ctx.body);
 *       ctx.writeData('notes', notes);
 *       ctx.sendJson(res, 200, { ok: true });
 *     },
 *     'GET /:id': async (req, res, ctx) => {
 *       // 路径参数：键里以 : 开头的段是单段通配，匹配值在 ctx.params.id
 *       ctx.sendJson(res, 200, { id: ctx.params.id });
 *     },
 *   };
 *
 * 挂载规则：文件名即 /api/ 前缀（notes.js → /api/notes/*），键格式 'METHOD /path'；
 * 每个资源建一个文件（records.js、notes.js…），按 PRD【后端 API 契约】实现端点。
 * 数据落 data/ 目录（ctx.readData/ctx.writeData，原子写重启不丢）；路由热加载，
 * 预览运行中改路由文件下一次请求即生效。
 */
module.exports = {};
