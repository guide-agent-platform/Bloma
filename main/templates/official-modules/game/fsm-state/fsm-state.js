// 官方模块：显式状态机（无依赖）
// 适用：游戏有明确阶段（主菜单/进行中/暂停/结束/胜利）需要互斥切换。
// 纪律：状态切换只经 transition 单入口；进入/离开钩子集中处理；禁止用散落布尔标志拼状态。
// 使用：复制本文件到业务 src/，import { createStateMachine } 后调用。

/**
 * 创建一个有限状态机。
 * @param {object} config
 * @param {string} config.initial 初始状态名
 * @param {Record<string, object>} config.states 状态定义：
 *   { enter?, exit?, update?(dt)? }
 * @param {Record<string, string[]>} [config.transitions] 允许的转移表（from → 可去的 to 列表）；
 *   未提供则允许任意切换。用于开发期防非法转移。
 * @returns {object} { transition, getState, update }
 */
export function createStateMachine({ initial, states, transitions }) {
  let current = initial

  const canTransition = (from, to) => {
    if (!transitions) return true
    const allowed = transitions[from]
    if (!allowed) return true
    return allowed.includes(to)
  }

  const call = (state, hook, arg) => {
    const def = states[state]
    if (def && typeof def[hook] === 'function') def[hook](arg)
  }

  return {
    /**
     * 切换到目标状态（单入口）。非法状态名/非法转移抛错（开发期尽早暴露）。
     * 顺序：旧状态 exit → 更新 current → 新状态 enter。
     */
    transition(to) {
      if (!states[to]) throw new Error(`未知状态：${to}`)
      if (!canTransition(current, to)) throw new Error(`非法转移：${current} → ${to}`)
      if (to === current) return current
      call(current, 'exit')
      current = to
      call(current, 'enter')
      return current
    },
    /** 当前状态名。 */
    getState() {
      return current
    },
    /** 每帧推进：调用当前状态的 update(dt)。 */
    update(dt) {
      call(current, 'update', dt)
    },
  }
}
