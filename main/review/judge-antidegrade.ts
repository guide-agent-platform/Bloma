/**
 * 裁判反退化确定性检测（Phase 3 B4，2026-09-09，P1 稿 §3 M4 + 咨询 A「证据不足一等状态」+ P0 稿 §4.3）。
 *
 * 规则先行层（runJudge 硬约束，LLM 语义腿之前）：对「已知坏实现」形态做静态高精度检测，
 * 与语义裁判 prompt 反退化规则（同开关）互补——门禁自测用例两层都要绿。
 *
 * 检测项（保守取向：只收平台上「不可能合法出现」的形态，防误杀）：
 * - ai-mock-frontend：背板有 CAP（AI 能力是已确认需求）而产物全文无 /api/llm 调用痕迹
 *   ——平台 CSP 禁前端直连外网，唯一合法 AI 通道是同源 /api/llm；无此调用则 AI 结果
 *   必为前端写死/模板冒充（固定 AI 回答坏实现的静态形态）。
 * - cheat-control：产物含「模拟失败」类控件文案——为过「失败→显示提示」断言而加的
 *   教学产物（随记灵案实锤），用户需求中不存在此控件依据。
 *
 * 开关 BLOMA_JUDGE_ANTIDEGRADE 缺省 off=字节级现状（P1 稿原定 M4 不设开关；因代码
 * 先行落地、A/B 后置改设开关保单因子纯净——偏差登记开关矩阵 §5，同 B3）。
 */

import type { AiCapability } from '../model/prd-backplane'

export interface AntidegradeFinding {
  code: 'ai-mock-frontend' | 'cheat-control'
  detail: string
}

/** BLOMA_JUDGE_ANTIDEGRADE 开关：缺省 off。 */
export function antidegradeEnabled(): boolean {
  const raw = (process.env.BLOMA_JUDGE_ANTIDEGRADE ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/** 「模拟失败」类教学控件文案（随记灵案形态；中英常见变体，保守窄匹配防误杀）。 */
const CHEAT_CONTROL_RE = /(模拟|仿真|simulate)[（(]?[^，。;；"'<>]{0,6}(失败|故障|报错|错误|fault|fail|error)/i

/**
 * 反退化静态检测。输入为产物文本聚合（index.html + src/app.js + server 侧源码）与
 * 背板 CAP；caps 为空时 ai-mock-frontend 不触发（无 AI 需求的产品无此义务）。
 */
export function detectAntidegrade(input: { artifact: string; caps: AiCapability[] }): AntidegradeFinding[] {
  const findings: AntidegradeFinding[] = []
  const artifact = input.artifact
  if (input.caps.length > 0 && !artifact.includes('/api/llm')) {
    findings.push({
      code: 'ai-mock-frontend',
      detail: `背板声明 ${input.caps.length} 条能力契约（CAP）但产物全文无 /api/llm 调用痕迹——平台唯一合法 AI 通道缺失，AI 结果必为前端写死/模板冒充（${input.caps.map((cap) => cap.capability_id).join('、')}）`,
    })
  }
  const cheat = artifact.match(CHEAT_CONTROL_RE)
  if (cheat) {
    findings.push({
      code: 'cheat-control',
      detail: `产物含无需求依据的「模拟失败」类控件（命中「${cheat[0]}」）——疑似为过失败态断言而加的教学产物，需求清单中无此控件`,
    })
  }
  return findings
}

/**
 * 语义裁判反退化规则段（append 到 SEMANTIC_JUDGE_SYSTEM_PROMPT 尾部；开关 off 返回
 * 空串=裁判 prompt 字节级现状）。三条：CRUD 闭环≠能力完成 / 证据不足不得判 implemented /
 * 无需求依据控件直接判 deviated。
 */
export const ANTIDEGRADE_JUDGE_RULES = [
  '【反退化规则（能力契约判定）】',
  '- CRUD 闭环 ≠ 能力完成：功能项即使有完整的增删改查界面，若命中【能力契约（CAP）】，必须按各条「验收证据」逐条核查智能能力是否真实成立；局部测试通过不构成 CAP 完成。',
  '- 证据不足不得判 implemented：无法从代码证明能力真实成立（固定文案、写死数据、无真实调用路径、空数据恒返回）时，判 unverified 或 deviated 并说明缺什么证据；不得凭界面齐全/测试通过判 implemented。',
  '- 无需求依据控件直接判 deviated：产物中出现需求清单之外的「模拟失败」类控件或为通过断言而加的入口/按钮，对应功能项判 deviated，evidence 注明控件名与位置。',
].join('\n')
