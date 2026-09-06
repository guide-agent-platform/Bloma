import { describe, expect, it } from 'vitest'
import { parseInterfaceSpec } from '../../main/guide/prd-engine-llm'
import { renderBackplaneAnchor, type PrdBackplane } from '../../main/model/prd-backplane'

/**
 * 完整程序阶段 2：interface_spec 契约清洗与锚定注入。
 * - 解析侧：/api/ 前缀自动补齐、方法白名单、上限 6 条（防脏端点打穿挂载/探针）；
 * - 锚定侧：契约随背板注入 loop（前后端真相源每轮可见）；无契约零注入（旧背板/纯展示）。
 */
describe('parseInterfaceSpec（契约清洗）', () => {
  it('缺 /api/ 前缀自动补齐；方法白名单外回退 GET；缺省字段剥离', () => {
    const parsed = parseInterfaceSpec([
      { endpoint: '/notes', method: 'get', request: '无', response: '{notes:[]}' },
      { endpoint: 'api/records', method: 'DELETE' },
      { endpoint: '/weird', method: 'TRACE' },
      { endpoint: '  ' },
      'not-an-object',
    ])
    expect(parsed).toEqual([
      { endpoint: '/api/notes', method: 'GET', request: '无', response: '{notes:[]}' },
      { endpoint: '/api/records', method: 'DELETE' },
      { endpoint: '/api/weird', method: 'GET' },
    ])
  })

  it('非数组 → 空数组；条目超 6 条截断', () => {
    expect(parseInterfaceSpec('nope')).toEqual([])
    const many = Array.from({ length: 9 }, (_, i) => ({ endpoint: `/api/e${i}` }))
    expect(parseInterfaceSpec(many)).toHaveLength(6)
  })
})

describe('renderBackplaneAnchor 接口契约注入', () => {
  const base: PrdBackplane = {
    project_id: 'p1',
    name: '随心记',
    positioning: '记录与总结',
    requirements: [{ id: 'F-001', description: '记录想法' }],
    acceptance: {},
    out_of_scope: [],
    assumptions: [],
  }

  it('有 interface_spec → 追加契约段（方法/路径/响应/请求齐全）', () => {
    const anchor = renderBackplaneAnchor({
      ...base,
      interface_spec: [
        { endpoint: '/api/notes', method: 'GET', response: '{notes:[{id,text}]}' },
        { endpoint: '/api/notes', method: 'POST', request: '{text:string}', response: '{ok:true}' },
      ],
    })
    expect(anchor).toContain('【后端 API 契约（interface_spec，前后端真相源）】')
    expect(anchor).toContain('- GET /api/notes → 响应：{notes:[{id,text}]}')
    expect(anchor).toContain('- POST /api/notes → 响应：{ok:true}；请求：{text:string}')
    expect(anchor).toContain('server/routes/')
  })

  it('无 interface_spec → 零注入（字节级现状，旧背板/纯展示零回归）', () => {
    const anchor = renderBackplaneAnchor(base)
    expect(anchor).not.toContain('API 契约')
    expect(anchor).toContain('[F-001]')
  })
})
