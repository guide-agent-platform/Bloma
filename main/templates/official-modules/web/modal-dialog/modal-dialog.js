// 官方模块：弹层与确认框（原生 DOM，无框架依赖）
// 适用：删除确认、操作成功提示、重要信息告知等「确认/取消」「提示」交互。
// 纪律：Promise 返回（await 即可拿结果）；Esc 与遮罩点击关闭；焦点管理（打开聚焦主按钮、关闭还原）。
// 使用：复制本文件 + modal-dialog.css 到业务 src/，import { confirm, alert } 后调用。
// 文案请传入中文；按钮/标题文本均可自定义。

const MODAL_CONTAINER_CLASS = 'bloma-modal-container'
const MODAL_OVERLAY_CLASS = 'bloma-modal-overlay'
const MODAL_BOX_CLASS = 'bloma-modal-box'

/**
 * 打开一个弹层，返回 Promise<用户选择的值>。
 * buttons: [{ label, value, kind: 'primary' | 'secondary' }]
 * Esc / 遮罩点击 = 选择第一个非 primary 按钮的值（无则 undefined）。
 */
function openModal({ title, message, buttons }) {
  return new Promise((done) => {
    const root = document.createElement('div')
    root.className = MODAL_CONTAINER_CLASS

    const overlay = document.createElement('div')
    overlay.className = MODAL_OVERLAY_CLASS

    const box = document.createElement('div')
    box.className = MODAL_BOX_CLASS
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')

    const titleEl = document.createElement('h3')
    titleEl.className = 'bloma-modal-title'
    titleEl.textContent = title || ''
    box.appendChild(titleEl)

    const messageEl = document.createElement('div')
    messageEl.className = 'bloma-modal-message'
    messageEl.textContent = message || ''
    box.appendChild(messageEl)

    const actions = document.createElement('div')
    actions.className = 'bloma-modal-actions'

    const prevFocus = document.activeElement
    let settled = false

    const close = (value) => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey)
      if (root.parentNode) root.parentNode.removeChild(root)
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus()
      done(value)
    }

    buttons.forEach((btn) => {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = `bloma-modal-btn ${btn.kind === 'primary' ? 'bloma-modal-btn-primary' : 'bloma-modal-btn-secondary'}`
      el.textContent = btn.label
      el.addEventListener('click', () => close(btn.value))
      actions.appendChild(el)
    })
    box.appendChild(actions)

    // 遮罩点击 = 取消（取第一个非 primary 按钮的值）
    overlay.addEventListener('click', () => {
      const cancel = buttons.find((b) => b.kind !== 'primary')
      close(cancel ? cancel.value : undefined)
    })
    box.addEventListener('click', (e) => e.stopPropagation())

    root.appendChild(overlay)
    root.appendChild(box)
    document.body.appendChild(root)

    // Esc 关闭
    function onKey(e) {
      if (e.key === 'Escape') {
        const cancel = buttons.find((b) => b.kind !== 'primary')
        close(cancel ? cancel.value : undefined)
      }
    }
    document.addEventListener('keydown', onKey)

    // 打开后聚焦主按钮（可访问性）
    requestAnimationFrame(() => {
      const target = actions.querySelector('.bloma-modal-btn-primary') || actions.querySelector('button')
      if (target) target.focus()
    })
  })
}

/**
 * 确认框：返回 true（确认）/ false（取消或关闭）。
 * @param {string} message 提示文案
 * @param {object} [options] { title, confirmText='确定', cancelText='取消' }
 */
export function confirm(message, options = {}) {
  const title = options.title || '确认'
  const confirmText = options.confirmText || '确定'
  const cancelText = options.cancelText || '取消'
  return openModal({
    title,
    message,
    buttons: [
      { label: cancelText, value: false, kind: 'secondary' },
      { label: confirmText, value: true, kind: 'primary' },
    ],
  }).then((v) => v === true)
}

/**
 * 提示框：仅一个「确定」按钮，返回 Promise<void>。
 * @param {string} message 提示文案
 * @param {object} [options] { title, confirmText='知道了' }
 */
export function alert(message, options = {}) {
  const title = options.title || '提示'
  const confirmText = options.confirmText || '知道了'
  return openModal({
    title,
    message,
    buttons: [{ label: confirmText, value: undefined, kind: 'primary' }],
  }).then(() => {})
}
