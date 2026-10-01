/**
 * Phase 8 W1（2026-09-11，狗粮 94f449c6 复盘拍板「照搬正常 agent 工作模式」）：
 * 迭代局部修改轮的聚焦任务书（iteration brief）。
 *
 * 问题：局部优化路径（localOnly）的 loop task 与首轮生成一字不差（全量
 * buildAgentLoopTask「实现可运行 MVP 逐功能项实现」），聚焦锚定只存在于 system 侧——
 * 弱模型以最后的 user 指令为准，把「改一处」理解成「重做全项目」，37/40 轮里 27 轮
 * 纯只读、用户诉求零触碰。修复轮（repair-loop）早已是聚焦任务卡模式，本模块把同一
 * 模式带给迭代路径：
 *
 * - task：用户修改诉求原话即任务主体 + 工作方式（grep-first / 先复现 / 最小变更 /
 *   聚焦完成判据）——「任务=增量」原则；
 * - system：追加【修改模式】段（对齐 REPAIR_MODE_SECTION 语义：任务书即全部工作，
 *   不要重新生成整个项目）；
 * - 轮次预算按比例收窄（maxTurns local 档，见 resolveAgentLoopMaxTurnsLocal）。
 *
 * 开关 BLOMA_ITER_BRIEF：'0'/'off'/'false'=强制关（task/system 字节级=现状全量
 * 任务书）；'1'/'on'/'true'=开；未设=开（纯任务书表达层，无验证语义变化，缺省生效；
 * 回退出口保留）。rebuild（整版重做）不消费本模块（全量锚定语义不变）。
 */

/** localOnly 轮次预算：BLOMA_LOOP_MAX_TURNS_LOCAL 可覆盖；非法值回退缺省 12。 */
const ITERATION_LOCAL_MAX_TURNS_DEFAULT = 12

export function resolveAgentLoopMaxTurnsLocal(): number {
  const raw = (process.env.BLOMA_LOOP_MAX_TURNS_LOCAL ?? '').trim()
  if (raw === '') return ITERATION_LOCAL_MAX_TURNS_DEFAULT
  const parsed = Number(raw)
  const floored = Math.floor(parsed)
  return Number.isFinite(parsed) && floored > 0 ? floored : ITERATION_LOCAL_MAX_TURNS_DEFAULT
}

/** 【修改模式】段（追加在背板锚定 system 之后，语义对齐 repair-loop 的 REPAIR_MODE_SECTION）。 */
export const ITERATION_MODE_SECTION = [
  '【修改模式】当前处于局部修改轮：下方任务书里的用户诉求是本轮全部工作，完成后输出完成总结即可。',
  '不要重新生成整个项目，不要改动与诉求无关的任何文件或功能；项目已实现并在系统提示的地图/锚中给出全貌。',
].join('\n')

/**
 * 局部修改轮任务书。localPrompt 为用户修改诉求原话（refineModificationDescription
 * 已清洗）；五要素：诉求原话 / grep-first 定位 / 先复现后修 / 最小变更 / 聚焦完成判据。
 */
export function buildIterationTask(localPrompt: string): string {
  return [
    `目标：处理用户的修改诉求（局部优化——只改这一处，其余保持现状）。`,
    `【本轮任务】${localPrompt}`,
    '【工作方式】',
    '1. 先用 grep 按诉求关键词定位相关代码，再 read_file 只读命中段落——禁止全项目通读；项目地图/骨架地图已给出文件全貌，按锚点定点读取。',
    '2. 修改前先复现：run_preview 拉起预览确认诉求现象（或用 run_gwt_tests 相关场景确认现状）；无法复现时如实说明并停止，不要盲改。',
    '3. 最小变更：只改与诉求直接相关的文件，其余文件保持现状勿重写。',
    '4. 完成判据：修改后 run_gwt_tests 通过（含本轮诉求对应断言）且 run_security_scan 无高危；输出完成总结，说明改了哪些文件、为什么。',
  ].join('\n')
}
