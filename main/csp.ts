/**
 * 主窗 CSP 策略（单一真相源，可独立单测）。
 *
 * 从 main/index.ts 抽出，供 configureContentSecurity 使用，也让 CSP 收窄规则
 * （问题 B-2）能被 tests/ 直接断言，而无需启动 Electron。
 *
 * 关键约束：
 * - 仅对 `mainFrame` 注入（iframe 子帧交给沙箱静态服务器自身的 CSP，
 *   否则主窗 `script-src 'self'` 会屏蔽生成页内联 <script>，导致「渲染不出 UI」）。
 * - `frame-src` 只放开本地回环（localhost / 127.0.0.1）任意端口，不放任何外部 origin。
 */

export const MAIN_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' http://localhost:* https://api.anthropic.com",
  "frame-src 'self' http://localhost:* http://127.0.0.1:*",
].join('; ')

/**
 * 是否应向该响应注入主窗 CSP：仅 mainFrame。
 * 子帧（iframe/subFrame）、脚本、样式等一律不动响应头，交给各响应自身的 CSP。
 */
export function shouldInjectMainFrameCsp(resourceType: string): boolean {
  return resourceType === 'mainFrame'
}
