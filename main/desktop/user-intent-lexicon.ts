/**
 * 桌面线用户文本意图词表（刀1，2026-10-02 确认协议与呈现层战役）。
 *
 * 背景（d34d189f 狗粮案定性拍板）：流程推进发生在 agent 内部（门禁全绿自动推进），
 * 人工只保留 Intent 层确认与不可逆动作——聊天框文本不构成推进凭据，但必须保留
 * 两个用户权力出口：停止/反悔（立即暂停流水线）与继续（修复后放行）。
 *
 * 设计（结构参照竞品 nanju-project.ts 确认词表——AGPL 同源授权互搬；两条实证教训）：
 * - 反义词优先：'不通过/没通过' 含子串 '通过'、'先别推进' 含 '推进'——stop 判定
 *   必须先于 continue 判定，否则反悔被反向解读为放行（竞品裁决 A2 实测事故）；
 * - 匹配形态：中文 includes / 纯英文 \b 词边界（大小写不敏感——'ok' 不误命中 'skip'）；
 * - 词表单点：所有用户文本意图判定走本模块，路由层不自带词表；扩词改数据不改逻辑。
 */

/** 用户文本意图三态：stop=停止/反悔；continue=继续（仅 blocked 态消费）；none=普通消息。 */
export type UserDesktopIntent = 'stop' | 'continue' | 'none'

/** 停止/反悔词（命中 → 中断推进、置 desktop_blocked、出人话卡）。 */
export const USER_STOP_KEYWORDS: readonly string[] = [
  '不通过', '没通过', '需要修复', '重做', '不行', '改主意',
  '先别', '暂缓', '再想想', '等等', '先停', '不急', '取消',
  '需要调整', '不满意', '停止', '停下', '别推进', '先停一下',
  'stop', 'halt', 'cancel', 'pause',
]

/** 继续词（仅在 blocked 态生效——修复后放行授权；正常态不特殊处理，防文本误推进）。 */
export const USER_CONTINUE_KEYWORDS: readonly string[] = [
  '继续', '可以', '通过', '好的', '没问题', '确认', '推进',
  '恢复', '继续跑', '放手去做',
  'continue', 'go on', 'ok', 'resume', 'approve',
]

/** 词匹配（中文 includes / 纯英文 \b 词边界，大小写不敏感；纯 ASCII 词才走词边界）。 */
function keywordHit(text: string, keywords: readonly string[]): string | undefined {
  for (const kw of keywords) {
    if (/^[\x20-\x7E]+$/.test(kw)) {
      if (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) return kw
    } else if (text.includes(kw)) {
      return kw
    }
  }
  return undefined
}

/** 用户文本意图分类（纯函数）：stop 优先于 continue（反义词包含子串的实证防御）。 */
export function classifyUserDesktopIntent(text: string): UserDesktopIntent {
  if (keywordHit(text, USER_STOP_KEYWORDS) !== undefined) return 'stop'
  if (keywordHit(text, USER_CONTINUE_KEYWORDS) !== undefined) return 'continue'
  return 'none'
}
