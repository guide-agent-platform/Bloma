// 官方模块：搜索过滤列表（数据层，渲染分离）
// 适用：列表型产品（记账、待办、商品、笔记）的「搜索/筛选/排序」。
// 纪律：只算数据不碰 DOM——业务层拿 getVisible() 渲染；防抖搜索；空态由 isEmpty 判断。
// 使用：复制本文件到业务 src/，import { createFilteredList } 后调用。

/**
 * 创建一个列表数据层（搜索结果/过滤/排序/空态判断）。
 * @param {Array} data 原始条目数组
 * @param {object} options
 * @param {function} [options.getText] 提取条目可搜索文本（默认 String(item)）
 * @param {object} [options.filters] 过滤条件定义：{ 状态: item => boolean, ... }
 * @param {function} [options.sort] 排序比较函数（默认保持原顺序）
 * @param {number} [options.debounceMs=200] 搜索防抖毫秒数
 * @returns {object} 数据层 API：getVisible / setQuery / setFilter / getState / isEmpty
 */
export function createFilteredList(data, options = {}) {
  const getText = options.getText || ((item) => String(item))
  const filters = options.filters || {}
  const sortFn = options.sort || null
  const debounceMs = typeof options.debounceMs === 'number' ? options.debounceMs : 200

  let query = '' // 搜索词
  let activeFilter = null // 当前激活的过滤条件 key
  let visible = [...data] // 当前结果缓存

  let timer = null

  const recompute = () => {
    let result = data.filter((item) => {
      // 过滤条件
      if (activeFilter && filters[activeFilter]) {
        if (!filters[activeFilter](item)) return false
      }
      // 搜索词（大小写不敏感，包含匹配）
      if (query) {
        const text = String(getText(item)).toLowerCase()
        if (!text.includes(query.toLowerCase())) return false
      }
      return true
    })
    if (sortFn) result = [...result].sort(sortFn)
    visible = result
  }

  return {
    /** 当前可见条目（业务层据此渲染）。 */
    getVisible() {
      return visible
    },
    /** 设置搜索词（防抖后重算）。 */
    setQuery(text) {
      query = String(text || '')
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        recompute()
      }, debounceMs)
    },
    /** 立即以当前搜索词重算（表单提交/回车时跳过防抖）。 */
    applyQueryNow() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      recompute()
    },
    /** 设置过滤条件（key 为 options.filters 的键，null 清除过滤）。 */
    setFilter(key) {
      activeFilter = key && filters[key] ? key : null
      recompute()
    },
    /** 当前状态（搜索词 + 激活过滤键）。 */
    getState() {
      return { query, activeFilter }
    },
    /** 当前是否为空（用于渲染空态提示——「无匹配结果」而非空白）。 */
    isEmpty() {
      return visible.length === 0
    },
    /** 更新底层数据（如新增/删除一条后），重算可见结果。 */
    setData(next) {
      data = next
      recompute()
    },
  }
}
