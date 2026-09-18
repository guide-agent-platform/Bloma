/**
 * server/routes 数据迁移模块样例（只读参考，不要直接改动本文件）。
 *
 * 【数据迁移纪律（BLOMA_DATA_MIGRATE）】凡改动 data/ 数据结构的变更（加字段/改字段
 * 语义/拆分文件），必须同步提供迁移，禁止丢旧数据重建：
 *
 *   1. 版本文件 data/schema-version.json：ctx.writeData('schema-version', '1')
 *      （首次写 data/ 时创建；此后每次结构变更把版本 +1）。
 *   2. server/routes/_migrate.js（本样例的正式版，CJS 格式）：
 *
 *        module.exports = {
 *          from: '1',
 *          to: '2',
 *          run: async (ctx) => {
 *            // ctx.readData(name, fallback) / ctx.writeData(name, value) 与路由同款
 *            const notes = ctx.readData('notes', [])
 *            ctx.writeData('notes', notes.map((n) => ({ ...n, tag: n.tag ?? '未分类' })))
 *            // 迁移完成后必须把版本写到目标值（终验演练会校验）：
 *            ctx.writeData('schema-version', '2')
 *          },
 *        };
 *
 *   3. 终验迁移演练（平台侧）：临时副本上执行 run 并校验——行数不减少、既有记录
 *      标识字段不丢、版本到位；演练不过=变更判败（GWT 失败条目回流修复）。
 *
 * 未改结构的常规轮次不需要 _migrate.js（有版本文件而无 _migrate.js 属正常态）。
 */
