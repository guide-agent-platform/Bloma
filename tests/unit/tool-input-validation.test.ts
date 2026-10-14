import { describe, expect, it } from 'vitest'
import { validateToolInput } from '../../main/agent/loop/tool-input-validation'

const schema = { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' }, count: { type: 'integer' }, packages: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['read', 'write'] } } }
describe('declared tool schema validation', () => {
  it('permits empty file content and leaves extra fields to the tool', () => {
    expect(validateToolInput('write_file', { path: 'a.py', content: '', extra: true }, schema)).toBeUndefined()
  })
  it('rejects empty and whitespace-only declared file paths while preserving empty file content', () => {
    const paths = { ...schema, properties: { ...schema.properties, path: { type: 'string', minLength: 1, pattern: '\\S' } } }
    for (const path of ['', '   ', '\t']) expect(validateToolInput('write_file', { path, content: '' }, paths)).toContain('input.path')
    expect(validateToolInput('write_file', { path: 'empty.py', content: '' }, paths)).toBeUndefined()
  })
  it.each([null, [], 'raw'])('rejects non-object tool bodies', value => {
    expect(validateToolInput('write_file', value, schema)).toContain('input 应为 object')
  })
  it('identifies missing keys and bad array elements without executing', () => {
    expect(validateToolInput('write_file', { path: 'a.py', packages: ['good', 1] }, schema)).toContain('input.content 缺失')
    expect(validateToolInput('write_file', { path: 'a.py', content: '', packages: ['good', 1] }, schema)).toContain('input.packages[1] 应为 string')
  })
  it('rejects non-finite numbers, fractional integers and invalid enum values', () => {
    for (const count of [NaN, Infinity, 1.5]) expect(validateToolInput('x', { path: 'a', content: '', count }, schema)).toContain('input.count')
    expect(validateToolInput('x', { path: 'a', content: '', mode: 'delete' }, schema)).toContain('input.mode')
  })
  it('respects a declared nullable union', () => {
    expect(validateToolInput('x', { value: null }, { properties: { value: { type: ['string', 'null'] } } })).toBeUndefined()
  })
})
