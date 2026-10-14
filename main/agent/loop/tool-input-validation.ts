/** Adapt Proma bf3e98c agent-tool-input-validator's pre-execution validation.
 * Bloma uses declared JSON schemas rather than upstream SDK tool-name mappings.
 * Validate only the supported structural subset; tool-specific semantics stay in tools.
 */
export function validateToolInput(name: string, input: unknown, schema: Record<string, unknown>): string | undefined {
  const errors: string[] = []
  const check = (value: unknown, definition: Record<string, unknown>, path: string, depth: number): void => {
    if (depth > 8 || errors.length >= 8) return
    const types = typeof definition.type === 'string' ? [definition.type] : Array.isArray(definition.type) ? definition.type : []
    const matches = (type: unknown) => {
      switch (type) {
        case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
        case 'array': return Array.isArray(value)
        case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
        case 'number': return typeof value === 'number' && Number.isFinite(value)
        case 'null': return value === null
        case 'string': return typeof value === 'string'
        case 'boolean': return typeof value === 'boolean'
        default: return true
      }
    }
    if (types.length && !types.some(matches)) { errors.push(`${path} 应为 ${types.join('/')}`); return }
    if (Array.isArray(definition.enum) && !definition.enum.some(option => option === value)) errors.push(`${path} 不在允许值中`)
    if (typeof value === 'string') {
      if (Number.isSafeInteger(definition.minLength) && value.length < Number(definition.minLength)) errors.push(`${path} 长度小于 ${definition.minLength}`)
      if (Number.isSafeInteger(definition.maxLength) && value.length > Number(definition.maxLength)) errors.push(`${path} 长度大于 ${definition.maxLength}`)
      if (typeof definition.pattern === 'string') {
        try { if (!new RegExp(definition.pattern).test(value)) errors.push(`${path} 不匹配允许格式`) }
        catch { errors.push(`${path} 的宿主 schema 正则无效`) }
      }
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      for (const key of Array.isArray(definition.required) ? definition.required : []) {
        if (typeof key === 'string' && (!Object.hasOwn(record, key) || record[key] === undefined)) errors.push(`${path}.${key} 缺失`)
      }
      const properties = definition.properties
      if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
        for (const [key, child] of Object.entries(properties)) {
          if (Object.hasOwn(record, key) && child && typeof child === 'object' && !Array.isArray(child)) check(record[key], child, `${path}.${key}`, depth + 1)
        }
      }
    } else if (Array.isArray(value) && definition.items && typeof definition.items === 'object' && !Array.isArray(definition.items)) {
      for (let i = 0; i < value.length && errors.length < 8; i++) check(value[i], definition.items as Record<string, unknown>, `${path}[${i}]`, depth + 1)
    }
  }
  // A malformed tool-call body must never reach a side-effecting implementation.
  check(input, { ...schema, type: 'object' }, 'input', 0)
  return errors.length ? `工具「${name}」参数不合法：${errors.slice(0, 8).join('；')}。按该工具的 input_schema 修正后重试；本次未执行、不消耗工具预算。` : undefined
}
