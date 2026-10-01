/**
 * PRD 背板类型与守卫的转发桩（web 线拆除刀3，2026-10-01）：
 * 本文件原为「PRD 类型 re-export + 模板草图生成器」；模板草图与 LLM 草图
 * （sketch-engine-llm）随 web 生成线退役删除。26 个消费者 import 的
 * PrdBackplane/backplanePages/isPlaceholderAssertion 等全部来自
 * model/prd-backplane——经本桩转发零改动；escapeHtml 保留本地定义
 * （judge-engine 文档渲染用）。清桩挂账（export * 桩清理条目）时消费者
 * 直连 model/prd-backplane 后本文件删除。
 */
export * from '../model/prd-backplane'

/** HTML 转义（PRD/报告文档渲染用）。 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}
