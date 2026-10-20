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

// Commands address this run. Product nouns, quoted labels and negated commands
// are not instructions to the host; unknown prose remains ordinary feedback.
const STOP_COMMAND = /^(?:请|麻烦|先|现在|马上|暂时)*(?:不通过|没通过|测试没通过|需要修复|重做|不行|改主意|暂缓|先停|取消|停止|停下|别推进|需要调整|不满意)(?:(?:当前|这个|本次)?(?:任务|流程|制作|生成|运行|执行)|一下|吧|了|先)*$/
const STOP_ENGLISH = /^(?:please\s+)?(?:stop|halt|cancel|pause)(?:\s+(?:it|this|now|the|current|run|task|workflow|please))*$/i
const CONTINUE_COMMAND = /^(?:请)?(?:继续|可以|通过|好的|没问题|确认|推进|恢复|继续跑|放手去做)(?:继续|通过|开工|执行|运行|生成|制作|推进|了|吧)*$/
const CONTINUE_ENGLISH = /^(?:please\s+)?(?:continue|go on|ok|resume|approve)(?:\s+(?:it|this|now|the|current|run|task|workflow|please))*$/i

/** Only whole command clauses control the host; stop takes precedence. */
export function classifyUserDesktopIntent(text: string): UserDesktopIntent {
  const clauses = text.trim().split(/[，。；！？,;!?\n]+/).map(part => part.trim()).filter(Boolean)
  if (clauses.some(part => STOP_COMMAND.test(part) || STOP_ENGLISH.test(part))) return 'stop'
  if (clauses.some(part => CONTINUE_COMMAND.test(part) || CONTINUE_ENGLISH.test(part))) return 'continue'
  return 'none'
}
