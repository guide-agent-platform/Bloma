/**
 * PRD 白话术语表（闭环治理 PR7，随感 37「确认卡婴儿模式」）。
 *
 * 单点维护：P 码保留（与文档面板/审查卡/md 对账需要），全部配白话；
 * 后续五形态（确认弹窗/聊天卡/审查卡/四段式/md）统一引用此表（拍板项 C，
 * 需产品拍板后另开 PR，本表即母版数据源）。
 */
export const PRD_TERMS = {
  P0: '核心必须',
  P1: '重要',
  P2: '可延后',
  assertion: '做到这样才算完成',
  story: '使用场景',
  outOfScope: '这次明确不做的',
  assumption: '我们替你默认的（说一声就能改）',
} as const

export type PrdPriority = 'P0' | 'P1' | 'P2'

/** 徽标文案：P 码（对账用）+ 白话（认知负荷最小化）。 */
export const priorityLabel = (p: PrdPriority): string => `${p} · ${PRD_TERMS[p]}`
