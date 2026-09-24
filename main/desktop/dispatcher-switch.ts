/**
 * 桌面线整体开关（批次 A 地基，2026-09-24）。
 *
 * BLOMA_DESKTOP_DISPATCH 缺省 off 字节锁：仅显式 '1' | 'true' | 'on' 视为开启，
 * 其余一切取值（含未设置/空串/其他值）一律关闭。开关矩阵登记于
 * docs/05_PROJECT_PLAN/p3-task-contract-switches.md §45。
 *
 * 开关语义：桌面调度员线的总闸（阶段表消费、提示词构建、围栏挂载、批次 D 接线
 * 全部在其后）；off 时 web 线字节级现状，桌面线代码零入口。批次 A/B 的纯函数
 * 地基不读开关（无副作用可直接单测）；开关在接线层（批次 D）成为唯一生效条件。
 */

/** 判定桌面调度员线是否开启（env 可注入——测试密闭性：显式设/还原，勿依赖机器残留）。 */
export function isDesktopDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.BLOMA_DESKTOP_DISPATCH
  return value === '1' || value === 'true' || value === 'on'
}

/** 开关名（登记/诊断共用单一真源）。 */
export const DESKTOP_DISPATCH_SWITCH = 'BLOMA_DESKTOP_DISPATCH' as const
