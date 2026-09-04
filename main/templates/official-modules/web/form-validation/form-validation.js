// 官方模块：表单校验（声明式规则，无依赖）
// 适用：提交前校验 + 字段级错误提示（注册/设置/记账/评论等输入表单）。
// 纪律：规则可组合；返回结构化 { valid, errors }，errors 按字段名归类；文案中文。
// 使用：复制本文件到业务 src/，import { validate, attachFieldErrors } 后调用。

/**
 * 校验规则对象。每个字段是一个规则数组，规则逐条执行，首条失败即记入该字段错误。
 * 支持规则：
 *   { required: true, message: '...' }            必填（空串/null/undefined 视为空）
 *   { minLength: 6, message: '...' }              最小长度（字符串或数组）
 *   { maxLength: 20, message: '...' }             最大长度
 *   { pattern: /^\d+$/, message: '...' }          正则匹配
 *   { email: true, message: '...' }               邮箱格式
 *   { number: true, message: '...' }              纯数字（字符串或数字）
 *   { min: 1, max: 100, message: '...' }          数值范围（配合 number 或直接对数字）
 *   { custom: (v, all) => '错误' | null, message?: 兜底 }  自定义校验，返回非空字符串即失败
 *
 * @param {object} values 待校验值（字段名 → 值）
 * @param {object} schema 校验规则（字段名 → 规则数组）
 * @returns {{ valid: boolean, errors: Record<string, string> }}
 */
export function validate(values, schema) {
  const errors = {}
  for (const [field, rules] of Object.entries(schema)) {
    const value = values[field]
    for (const rule of rules) {
      const reason = checkRule(rule, value, values)
      if (reason) {
        errors[field] = reason
        break // 首条失败即停，避免刷屏
      }
    }
  }
  return { valid: Object.keys(errors).length === 0, errors }
}

function isEmpty(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

function checkRule(rule, value, all) {
  if (rule.required && isEmpty(value)) return rule.message || '此项为必填'
  if (isEmpty(value)) return null // 非必填且为空 → 跳过后续校验

  if (rule.minLength !== undefined) {
    const len = typeof value === 'string' || Array.isArray(value) ? value.length : String(value).length
    if (len < rule.minLength) return rule.message || `至少 ${rule.minLength} 个字符`
  }
  if (rule.maxLength !== undefined) {
    const len = typeof value === 'string' || Array.isArray(value) ? value.length : String(value).length
    if (len > rule.maxLength) return rule.message || `最多 ${rule.maxLength} 个字符`
  }
  if (rule.pattern && !rule.pattern.test(String(value))) return rule.message || '格式不正确'
  if (rule.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) return rule.message || '邮箱格式不正确'

  if (rule.number || rule.min !== undefined || rule.max !== undefined) {
    const num = typeof value === 'number' ? value : Number(value)
    if (Number.isNaN(num)) return rule.message || '请输入有效数字'
    if (rule.min !== undefined && num < rule.min) return rule.message || `不能小于 ${rule.min}`
    if (rule.max !== undefined && num > rule.max) return rule.message || `不能大于 ${rule.max}`
  }

  if (rule.custom) {
    const result = rule.custom(value, all)
    if (typeof result === 'string' && result !== '') return result
    if (result === false) return rule.message || '校验未通过'
  }
  return null
}

/**
 * 把字段错误渲染到 DOM：约定每个字段旁有一个 `data-error-for="字段名"` 的错误容器
 * （可为空 <span>）。传入 errors 后自动填充/清空，并给字段输入框加 `.field-invalid` 类。
 * @param {Record<string, string>} errors validate 返回的 errors
 * @param {Document|HTMLElement} [root=document]
 */
export function attachFieldErrors(errors, root = document) {
  // 先清空所有旧错误与红框
  root.querySelectorAll('[data-error-for]').forEach((el) => {
    el.textContent = ''
    el.classList.remove('field-error-visible')
  })
  root.querySelectorAll('.field-invalid').forEach((el) => el.classList.remove('field-invalid'))

  for (const [field, message] of Object.entries(errors)) {
    const slot = root.querySelector(`[data-error-for="${field}"]`)
    if (slot) {
      slot.textContent = message
      slot.classList.add('field-error-visible')
    }
    // 给同名输入框加红框（按 name 或 id 匹配）
    const input = root.querySelector(`[name="${field}"], [id="${field}"]`)
    if (input && 'classList' in input) input.classList.add('field-invalid')
  }
}
