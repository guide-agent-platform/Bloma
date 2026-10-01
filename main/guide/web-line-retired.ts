/**
 * web 线拆除刀1（2026-10-01 拍板只做桌面）：非桌面品类的形态引导卡——单点工厂。
 * 三处发卡（prd-confirm / prd-pipeline 降级腿 / guide-pipeline 规则路由兜底）与
 * 回传解析（agent-dispatch resolveWebLineRetiredCard）共用同源定义；
 * 改文案/选项 id/判定只动这里，勿在调用方内联复制（三处口径事故预防）。
 */

export const WEB_LINE_RETIRED_CARD_KIND = 'web_line_retired'
export const WEB_TO_DESKTOP_OPTION_ID = 'web_to_desktop'
export const WEB_TO_REVISE_OPTION_ID = 'web_to_revise'

/** 卡选项 id 判定（回传路由入口用；收紧为字面量联合，拼错编译期即红）。 */
export function isWebLineRetiredOption(
  id: unknown,
): id is typeof WEB_TO_DESKTOP_OPTION_ID | typeof WEB_TO_REVISE_OPTION_ID {
  return id === WEB_TO_DESKTOP_OPTION_ID || id === WEB_TO_REVISE_OPTION_ID
}

/** user_decision_required 事件的卡载荷（结构与其他决策卡一致：kind + title + questions）。 */
export function buildWebLineRetiredCardPayload(): {
  kind: string
  title: string
  questions: Array<{ id: string; label: string; description: string }>
} {
  return {
    kind: WEB_LINE_RETIRED_CARD_KIND,
    title: '选择交付形态',
    questions: [
      { id: WEB_TO_DESKTOP_OPTION_ID, label: '按桌面软件继续', description: '以 Windows 桌面形态推进交付' },
      { id: WEB_TO_REVISE_OPTION_ID, label: '回去调整需求', description: '回到对话，调整需求形态后再确认' },
    ],
  }
}
