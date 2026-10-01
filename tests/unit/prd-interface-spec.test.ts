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

  it('A2 路由模块契约显影：契约段末尾追加 Express 业界标准条款（快照，2026-10-01 唯一口径）', () => {
    const anchor = renderBackplaneAnchor({
      ...base,
      interface_spec: [{ endpoint: '/api/records', method: 'GET', response: '{records:[…]}' }],
    })
    // 锚点渲染快照：契约段头部 → 端点行 → Express 条款（顺序与全文逐字锁定，防漂移）
    const contractIndex = anchor.indexOf('【后端 API 契约（interface_spec，前后端真相源）】')
    expect(contractIndex).toBeGreaterThan(0)
    expect(anchor.slice(contractIndex)).toBe(
      [
        '【后端 API 契约（interface_spec，前后端真相源）】按此实现 server/routes/ 下的路由并保持一致：',
        '- GET /api/records → 响应：{records:[…]}',
        "路由实现（Express 业界标准）：后端路由写在 server.js 或 server/ 下模块，用 app.get('/api/xxx', handler) 等标准写法注册；数据经 server/db.js 的 readData/writeData 落 data/；服务从 process.env.PORT 读端口（平台拉起时注入）。/api/llm 代理已在 server/llm-proxy.js 预置（读 BLOMA_APP_LLM_* 环境变量，禁把密钥写进代码）。",
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

  it('开关 off：game 类留存腿豁免（2026-09-25 拍板「本地工具不上后端」——game 属本地优先品类，C1b 开关被品类语义覆盖）', () => {
    delete process.env.BLOMA_GAME_DERIVE_EXEMPT
    expect(deriveInterfaceSpec(shmup, 'game')).toBeUndefined()
    expect(requirementImpliesBackend(shmup[0], 'game')).toBe(false)
  })

  it('开关 on：game 类轻留存豁免——不派生契约、徽标不亮；LLM 明确报告不受影响（调用方 LLM 优先逻辑）', () => {
    process.env.BLOMA_GAME_DERIVE_EXEMPT = '1'
    expect(deriveInterfaceSpec(shmup, 'game')).toBeUndefined()
    expect(requirementImpliesBackend(shmup[0], 'game')).toBe(false)
  })

  it('开关 on 但非 game：照派照亮（豁免只限 game；重数据工具类项目完整程序口径不变）', () => {
    process.env.BLOMA_GAME_DERIVE_EXEMPT = '1'
    expect(deriveInterfaceSpec(shmup, 'web_fullstack')).toBeDefined()
    // 2026-09-25 拍板：personal_tool 同属本地优先——留存徽标不再亮（localStorage 合法）
    expect(requirementImpliesBackend(shmup[0], 'personal_tool')).toBe(false)
    // 不传 type（旧调用兼容）：照派
    expect(deriveInterfaceSpec(shmup)).toBeDefined()
  })
})

describe('W1.2 外部服务信号派生（Phase 9，B 站播放器案 214397c3）', () => {
  // B 站案原始需求形态：留存词表零命中 → interface_spec 空 → 契约豁免 → 前端发明
  // /api/bili 后端缺失无人拦。外部服务信号命中后必须强制走通契约四环节。
  const bili = [{ id: 'F-001', description: '输入 BV 号在线播放对应 B 站视频，画面加简介信息' }]
  const localOnly = [{ id: 'F-001', description: '打开本地视频文件并播放，支持常见格式' }]
  const voice = [{ id: 'F-001', description: '语音输入转文字保存笔记' }]
  const plain = [{ id: 'F-001', description: '展示当前时间和一句问候' }]

  it('B 站式在线播放需求：派生 /api/external 占位代理端点（B 站案零派生修复）', () => {
    const derived = deriveInterfaceSpec(bili, 'personal_tool')
    expect(derived).toBeDefined()
    expect(derived!.some((ep) => ep.endpoint === '/api/external')).toBe(true)
    // 响应必须携带同源代理语义与路由落点（喂给背板锚定与 plan）
    const ext = derived!.find((ep) => ep.endpoint === '/api/external')!
    expect(ext.response).toContain('同源代理')
    expect(ext.response).toContain('server/routes/')
  })

  it('纯本地文件播放（B 站案另一半需求）：不触发外部信号（本地 blob 播放无需后端）', () => {
    expect(deriveInterfaceSpec(localOnly, 'personal_tool')).toBeUndefined()
    expect(requirementImpliesBackend(localOnly[0], 'personal_tool')).toBe(false)
  })

  it('语音输入词命中（输入侧才触发；语音播报类纯前端词不在词表）', () => {
    const derived = deriveInterfaceSpec(voice, 'personal_tool')!
    // 2026-09-25 拍板：personal_tool 留存腿豁免（保存笔记走 localStorage）——只派生外部服务代理端点
    expect(derived.some((ep) => ep.endpoint === '/api/records')).toBe(false)
    expect(derived.some((ep) => ep.endpoint === '/api/external')).toBe(true)
    expect(requirementImpliesBackend(voice[0], 'personal_tool')).toBe(true)
  })

  it('纯展示需求：零派生（词表不泛化，误伤为零）', () => {
    expect(deriveInterfaceSpec(plain, 'personal_tool')).toBeUndefined()
  })

  it('requirementImpliesBackend 徽标同步亮（C1a 显影路沿旧链路自动生效）', () => {
    expect(requirementImpliesBackend(bili[0], 'personal_tool')).toBe(true)
    // 故事字段命中同口径
    expect(requirementImpliesBackend({ id: 'F-002', description: '视频管理', story: '扫码登录后同步收藏' }, 'personal_tool')).toBe(true)
  })
})

describe('本地优先豁免（2026-09-25 拍板「向 Proma-Easy 靠齐」——随手计算器案根治）', () => {
  const calculatorTape = [{ id: 'F-009', description: '参考市面做法：PCalc 纸带式记录' }]
  const strongBackend = [{ id: 'F-001', description: '记账数据多端同步，云端保存' }]
  const webLedger = [{ id: 'F-001', description: '记录每笔收入与支出并持久保存' }]

  it('灵感劫持案原文：personal_tool 计算器「纸带式记录」零派生（localStorage 合法）', () => {
    expect(deriveInterfaceSpec(calculatorTape, 'personal_tool')).toBeUndefined()
    expect(requirementImpliesBackend(calculatorTape[0], 'personal_tool')).toBe(false)
  })

  it('强后端词（多端同步/云端）不受豁免：照派照亮', () => {
    expect(deriveInterfaceSpec(strongBackend, 'personal_tool')).toBeDefined()
    expect(requirementImpliesBackend(strongBackend[0], 'personal_tool')).toBe(true)
  })

  it('web_fullstack 品类保留原信号词判定（记录/保存照派）', () => {
    expect(deriveInterfaceSpec(webLedger, 'web_fullstack')).toBeDefined()
    expect(requirementImpliesBackend(webLedger[0], 'web_fullstack')).toBe(true)
  })

  it('desktop_tool 同属本地优先（桌面线品类语义一致）', () => {
    expect(deriveInterfaceSpec([{ id: 'F-1', description: '剪贴板历史记录' }], 'desktop_tool')).toBeUndefined()
    expect(requirementImpliesBackend({ id: 'F-1', description: '剪贴板历史记录' }, 'desktop_tool')).toBe(false)
  })
})
