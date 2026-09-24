/**
 * 桌面调度员线渲染端常量（渲染端适配批，2026-09-24）。
 *
 * 桌面阶段 id 判定与中文短名——渲染端自持一份（不 import main/dispatcher-phases：
 * 渲染端不碰主进程代码，label 表是展示层投影）。阶段表插新阶段（主进程侧零代码
 * 改动演示项）时，本表缺项自动降级显示原始 id——阶段条节点序固定五节点，
 * 未知 id 追加在尾部原样显示，不需要同步改渲染端。
 */

/** 桌面阶段 id 判定（stage_changed 事件分流依据；desktop- 前缀 ∪ delivered）。 */
export function isDesktopPhaseId(id: string): boolean {
  return id.startsWith('desktop-') || id === 'delivered'
}

/** 桌面阶段短名（阶段条节点胶囊用，两字优先——头部空间有限）。 */
export const DESKTOP_PHASE_LABELS: Record<string, string> = {
  'desktop-arch': '选型',
  'desktop-scaffold': '骨架',
  'desktop-implement': '实现',
  'desktop-verify': '验收',
  delivered: '交付',
}

/** 桌面阶段全名（title 属性/无障碍用）。 */
export const DESKTOP_PHASE_FULL_LABELS: Record<string, string> = {
  'desktop-arch': '桌面选型与架构',
  'desktop-scaffold': '最小骨架',
  'desktop-implement': '实现与交付说明',
  'desktop-verify': '驱动验收',
  delivered: '已交付',
}

/** 阶段条节点序（requirements 复用向导管线不进桌面条）。 */
export const DESKTOP_PHASE_ORDER: readonly string[] = [
  'desktop-arch',
  'desktop-scaffold',
  'desktop-implement',
  'desktop-verify',
  'delivered',
]

/** 节点短名（缺项降级：截取 id 去前缀的短形态或原样）。 */
export function desktopPhaseLabel(id: string): string {
  return DESKTOP_PHASE_LABELS[id] ?? id.replace('desktop-', '')
}

/** 节点全名（缺项降级原样）。 */
export function desktopPhaseFullLabel(id: string): string {
  return DESKTOP_PHASE_FULL_LABELS[id] ?? id
}
