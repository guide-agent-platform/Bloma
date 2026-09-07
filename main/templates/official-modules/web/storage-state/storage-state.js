// 官方模块：本地状态持久化（localStorage 键值状态封装）
// 适用：跨刷新保留的数据——设置、列表草稿、游戏最高分/存档、表单草稿。
// 纪律：JSON 自动序列化 + 损坏容错；localStorage 不可用（隐私模式/沙箱）降级为内存，不抛错。
// 使用：复制本文件到业务 src/ 后按需改默认命名空间；可 import 使用或并入 app.js。

/**
 * 创建一个带命名空间的本地状态仓库。
 * @param {string} namespace 命名空间（如 'myapp'），避免多项目/多模块键冲突
 * @param {object} [options]
 * @param {number} [options.debounceMs=0] 防抖落盘毫秒数；0 = 同步立即写。
 *   防抖只合并「最后一次写」，适合单键/少量键高频写（如游戏分数）；多键高频交错写请用 0。
 * @returns {object} 仓库 API：get / set / update / remove / flush
 */
export function createStateStore(namespace, options = {}) {
  const prefix = `${namespace}:`
  const debounceMs = typeof options.debounceMs === 'number' ? options.debounceMs : 0

  // localStorage 可能不可用（隐私模式 / 沙箱禁存储）→ 降级为内存 Map，读写语义不变
  const storage = (() => {
    try {
      const probe = '__bloma_probe__'
      window.localStorage.setItem(probe, '1')
      window.localStorage.removeItem(probe)
      return window.localStorage
    } catch {
      const mem = new Map()
      return {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
      }
    }
  })()

  let timer = null
  let pending = null

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  // 立即落盘 pending（若存在）；无 pending 时无操作。
  const commitNow = () => {
    cancelTimer()
    if (pending) {
      storage.setItem(prefix + pending.key, JSON.stringify(pending.value))
      pending = null
    }
  }

  const read = (key, fallback) => {
    const raw = storage.getItem(prefix + key)
    if (raw === null || raw === undefined) return fallback
    try {
      return JSON.parse(raw)
    } catch {
      // 损坏数据容错：返回默认值，不抛错（启动恢复时不因坏数据崩溃）
      return fallback
    }
  }

  const write = (key, value) => {
    pending = { key, value }
    cancelTimer()
    if (debounceMs > 0) {
      timer = setTimeout(commitNow, debounceMs)
    } else {
      commitNow()
    }
  }

  return {
    /** 读取某个键（JSON 自动反序列化；缺失或损坏返回 fallback）。 */
    get(key, fallback = null) {
      return read(key, fallback)
    },
    /** 写入某个键（按防抖策略落盘）。 */
    set(key, value) {
      write(key, value)
    },
    /** 更新某个对象键：基于当前值浅合并，返回合并结果（非对象键按空对象兜底）。 */
    update(key, patch) {
      const current = read(key, null)
      const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
      const next = { ...base, ...patch }
      write(key, next)
      return next
    },
    /** 删除某个键（丢弃其未落盘的 pending 写）。 */
    remove(key) {
      cancelTimer()
      if (pending && pending.key === key) pending = null
      storage.removeItem(prefix + key)
    },
    /** 立即同步落盘（应用退出/页面卸载前调用，防抖期间的最后一次写不丢）。 */
    flush() {
      commitNow()
    },
  }
}
