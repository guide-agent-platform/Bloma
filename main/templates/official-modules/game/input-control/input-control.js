// 官方模块：键盘输入（无依赖）
// 适用：游戏方向控制/动作键（移动、跳跃、攻击），兼顾桌面键盘与移动触摸。
// 纪律：按键态 keydown/keyup 记录；WASD 与方向键双通道映射到同一动作；触摸端给虚拟方向键兜底。
// 使用：复制本文件到业务 src/，import { createInputManager } 后调用。

/**
 * 创建一个输入管理器。
 * @param {object} mapping 动作名 → 按键码数组（如 { moveLeft: ['ArrowLeft','KeyA'], jump: ['Space','KeyW','ArrowUp'] }）
 * @param {Window} [win=window] 监听目标（可注入测试环境）
 * @returns {object} { isDown, wasPressed, attachTouchPad, detachTouchPad }
 */
export function createInputManager(mapping, win = window) {
  const down = new Set() // 当前按住的按键码
  const pressedEdge = new Set() // 本帧刚按下（边沿，消费后清除）

  const onKeyDown = (e) => {
    if (!down.has(e.code)) pressedEdge.add(e.code)
    down.add(e.code)
  }
  const onKeyUp = (e) => down.delete(e.code)

  win.addEventListener('keydown', onKeyDown)
  win.addEventListener('keyup', onKeyUp)

  // 触摸虚拟键兜底：attachTouchPad 会创建 DOM 按钮，按下即视为对应动作的「虚拟按键」
  let touchPressed = new Set()

  const actionCodes = (action) => mapping[action] || []

  return {
    /** 某动作当前是否按下（长按判定，移动常用）。 */
    isDown(action) {
      return actionCodes(action).some((code) => down.has(code) || touchPressed.has(code))
    },
    /** 某动作是否「本帧刚按下」（边沿触发，跳跃/攻击常用；每帧更新前调 endFrame 清空）。 */
    wasPressed(action) {
      return actionCodes(action).some((code) => pressedEdge.has(code))
    },
    /** 每帧末尾调用：清空「本帧刚按下」集合（边沿只活一帧）。 */
    endFrame() {
      pressedEdge.clear()
    },
    /** 创建触摸虚拟方向/动作键（移动端兜底）。container 为承载 DOM 元素。 */
    attachTouchPad(container, buttons) {
      // buttons: [{ action, label, className? }]
      const els = []
      buttons.forEach((btn) => {
        const el = document.createElement('button')
        el.type = 'button'
        el.textContent = btn.label
        el.className = btn.className || 'bloma-touch-btn'
        const press = () => touchPressed.add(btn.action)
        const release = () => touchPressed.delete(btn.action)
        el.addEventListener('pointerdown', press)
        el.addEventListener('pointerup', release)
        el.addEventListener('pointerleave', release)
        el.addEventListener('pointercancel', release)
        container.appendChild(el)
        els.push(el)
      })
      return () => els.forEach((el) => el.parentNode && el.parentNode.removeChild(el))
    },
    /** 释放全局键盘监听（页面卸载时调用）。 */
    destroy() {
      win.removeEventListener('keydown', onKeyDown)
      win.removeEventListener('keyup', onKeyUp)
    },
  }
}
