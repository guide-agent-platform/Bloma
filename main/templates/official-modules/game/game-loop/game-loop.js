// 官方模块：游戏主循环（requestAnimationFrame，无依赖）
// 适用：基于 canvas 的实时游戏，需要稳定帧循环 + 暂停/恢复。
// 纪律：update（状态推进）与 render（绘制）分离；delta 时间驱动，帧率无关；暂停即停 update 不销毁循环。
// 使用：复制本文件到业务 src/，import { createGameLoop } 后调用；update/render 由业务实现。

/**
 * 创建游戏主循环。
 * @param {object} handlers
 * @param {function(deltaMs:number):void} handlers.update 每帧推进状态（deltaMs = 距上帧毫秒）
 * @param {function():void} [handlers.render] 每帧绘制；未提供则 update 后不单独绘制
 * @returns {object} { start, pause, resume, stop, isRunning }
 */
export function createGameLoop({ update, render }) {
  let running = false
  let paused = false
  let lastTime = 0
  let rafId = null

  const frame = (now) => {
    if (!running) return
    // 暂停时仍保持循环挂起（省得销毁重建），但不推进状态
    if (!paused) {
      const deltaMs = lastTime === 0 ? 0 : now - lastTime
      lastTime = now
      update(Math.min(deltaMs, 100)) // 上限 100ms 防切后台回来一大跳
      if (render) render()
    } else {
      lastTime = now
    }
    rafId = requestAnimationFrame(frame)
  }

  return {
    start() {
      if (running) return
      running = true
      paused = false
      lastTime = 0
      rafId = requestAnimationFrame(frame)
    },
    pause() {
      if (running) paused = true
    },
    resume() {
      if (running) {
        paused = false
        lastTime = 0 // 恢复后首帧 delta 清零，避免暂停期间时间累积
      }
    },
    stop() {
      running = false
      paused = false
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = null
      lastTime = 0
    },
    isRunning() {
      return running && !paused
    },
  }
}
