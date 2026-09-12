import { afterEach, describe, expect, it } from 'vitest'
import { parseInterfaceSpec } from '../../main/guide/prd-engine-llm'
import { deriveInterfaceSpec, renderBackplaneAnchor, requirementImpliesBackend, type PrdBackplane } from '../../main/model/prd-backplane'

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

describe('deriveInterfaceSpec（数据留存信号确定性兜底，阶段 2.5 计算器案）', () => {
  it('功能项命中留存信号（历史/记录/清空）→ 派生 records 最小契约', () => {
    const derived = deriveInterfaceSpec([
      { id: 'F-001', description: '做一个计算器' },
      { id: 'F-005', description: '计算历史从用户首次输入开始记录，手动清空才清空' },
    ])
    expect(derived).toBeDefined()
    expect(derived?.map((ep) => `${ep.method} ${ep.endpoint}`)).toEqual(['GET /api/records', 'POST /api/records'])
  })

  it('无留存信号（纯展示）→ undefined 零注入', () => {
    expect(deriveInterfaceSpec([{ id: 'F-001', description: '展示当前时间' }])).toBeUndefined()
  })
})

describe('requirementImpliesBackend（C1a 后端架构后果显影，与 deriveInterfaceSpec 同源词表）', () => {
  it('留存信号词命中（描述或 story）→ true；纯展示 → false', () => {
    expect(requirementImpliesBackend({ id: 'F-008', description: '显示并本地留存历史最高分' })).toBe(true)
    expect(requirementImpliesBackend({ id: 'F-001', description: '展示当前时间', story: '作为用户看时间' })).toBe(false)
    expect(requirementImpliesBackend({ id: 'F-002', description: '玩游戏', story: '保存游戏进度' })).toBe(true)
  })

  it('与 deriveInterfaceSpec 聚合判定一致：任一项命中即派生，逐项判定覆盖同一批项', () => {
    const items = [
      { id: 'F-001', description: '打飞机' },
      { id: 'F-008', description: '显示并本地留存历史最高分' },
    ]
    expect(deriveInterfaceSpec(items)).toBeDefined()
    expect(items.filter((i) => requirementImpliesBackend(i)).map((i) => i.id)).toEqual(['F-008'])
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

  it('A2 路由模块契约显影：契约段末尾追加 CJS 模块格式条款（快照）', () => {
    const anchor = renderBackplaneAnchor({
      ...base,
      interface_spec: [{ endpoint: '/api/records', method: 'GET', response: '{records:[…]}' }],
    })
    // 锚点渲染快照：契约段头部 → 端点行 → CJS 条款（顺序与全文逐字锁定，防漂移）
    const contractIndex = anchor.indexOf('【后端 API 契约（interface_spec，前后端真相源）】')
    expect(contractIndex).toBeGreaterThan(0)
    expect(anchor.slice(contractIndex)).toBe(
      [
        '【后端 API 契约（interface_spec，前后端真相源）】按此实现 server/routes/ 下的路由并保持一致：',
        '- GET /api/records → 响应：{records:[…]}',
        '路由文件模块格式（static-server 以 CommonJS require 加载，禁用 ESM import/export）：每个 server/routes/<资源>.js 写 `module.exports = { \'METHOD /path\': async (req, res, ctx) => {...} }`，键格式为 \'方法 路径\'，文件名即 /api/ 前缀（records.js → /api/records/*，样例见骨架 server/routes/_example.js）；数据用 ctx.readData/ctx.writeData 落 data/。',
      ].join('\n'),
    )
    expect(anchor).not.toContain('localStorage')
  })

  it('无 interface_spec → 零注入（字节级现状，旧背板/纯展示零回归）', () => {
    const anchor = renderBackplaneAnchor(base)
    expect(anchor).not.toContain('API 契约')
    expect(anchor).toContain('[F-001]')
  })
})

describe('C1b game 豁免留存派生（BLOMA_GAME_DERIVE_EXEMPT，2026-09-11 拍板）', () => {
  const previousEnv = process.env.BLOMA_GAME_DERIVE_EXEMPT
  const shmup = [{ id: 'F-008', description: '显示并本地留存历史最高分' }]

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.BLOMA_GAME_DERIVE_EXEMPT
    else process.env.BLOMA_GAME_DERIVE_EXEMPT = previousEnv
  })

  it('开关 off：game 类照派（字节级现状——街机游戏仍升级前后端）', () => {
    delete process.env.BLOMA_GAME_DERIVE_EXEMPT
    expect(deriveInterfaceSpec(shmup, 'game')).toBeDefined()
    expect(requirementImpliesBackend(shmup[0], 'game')).toBe(true)
  })

  it('开关 on：game 类轻留存豁免——不派生契约、徽标不亮；LLM 明确报告不受影响（调用方 LLM 优先逻辑）', () => {
    process.env.BLOMA_GAME_DERIVE_EXEMPT = '1'
    expect(deriveInterfaceSpec(shmup, 'game')).toBeUndefined()
    expect(requirementImpliesBackend(shmup[0], 'game')).toBe(false)
  })

  it('开关 on 但非 game：照派照亮（豁免只限 game；重数据工具类项目完整程序口径不变）', () => {
    process.env.BLOMA_GAME_DERIVE_EXEMPT = '1'
    expect(deriveInterfaceSpec(shmup, 'web_fullstack')).toBeDefined()
    expect(requirementImpliesBackend(shmup[0], 'personal_tool')).toBe(true)
    // 不传 type（旧调用兼容）：照派
    expect(deriveInterfaceSpec(shmup)).toBeDefined()
  })
})
