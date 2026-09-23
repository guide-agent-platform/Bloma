/**
 * 思考过程调试日志（开发插件）
 *
 * 由环境变量 `BLOMA_SHOW_THINKING=1` 激活。启用后 anthropicMessagesQuery
 * 会打开 Anthropic extended thinking 并把 `thinking_delta` 打印到主进程 stdout
 * （`npm run start` 终端），引导对话与 MVP 生成两条路径共用此入口，一次覆盖。
 *
 * 约束：
 * - 仅打印到主进程终端，不进 SDKMessage / AgentEvent / UI / JSONL，P0 用户不可见。
 * - 默认关闭（不设环境变量时行为与现状完全一致）。
 */

/** 思考日志开关：环境变量 `BLOMA_SHOW_THINKING=1` 时启用。 */
export function isThinkingLogEnabled(): boolean {
  return process.env.BLOMA_SHOW_THINKING === '1'
}

/** 打印一段思考增量。sessionId 截断为前 8 位，便于多会话区分。 */
export function logThinking(sessionId: string, text: string): void {
  console.log(`[thinking:${sessionId.slice(0, 8)}] ${text}`)
}
