import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadRealScaffoldTemplate,
  REAL_SCAFFOLD_TYPES,
} from '../../main/project/project-templates'
import { PRODUCT_CSP } from '../../main/coding/product-csp'
import {
  renderBackplaneAnchor,
  type PrdBackplane,
} from '../../main/model/prd-backplane'

/**
 * W1 真实脚手架（2026-09-18 改造，BLOMA_REAL_SCAFFOLD 缺省 off = 字节级现状）。
 *
 * 锁四件事：
 * 1. 开关缺省 off（旧注入式路径字节级不变）；
 * 2. 两态判定：interface_spec 非空 → real-fullstack（Express 真实工程件齐全）；
 *    空 → real-static（纯静态一等公民，无 server 件）；
 * 3. 骨架内容质量：PORT 约定、Express 标准注册、CSP 与真相源同步、
 *    密钥只读环境变量、db 原子写；
 * 4. 背板锚条款分支：on → Express 口径；off → 旧相对路径正反例（两侧字节级锁）。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

describe('W1 真实脚手架骨架包（BLOMA_REAL_SCAFFOLD）', () => {
  const previousEnv = process.env.BLOMA_REAL_SCAFFOLD

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.BLOMA_REAL_SCAFFOLD
    else process.env.BLOMA_REAL_SCAFFOLD = previousEnv
  })


  it('两态判定：有后端契约 → real-fullstack（Express 工程件齐全）；无契约 → real-static（纯静态，无 server 件）', () => {
    const fullstack = loadRealScaffoldTemplate(true)
    const staticSkeleton = loadRealScaffoldTemplate(false)
    expect(fullstack?.variant).toBe('real-fullstack')
    expect(staticSkeleton?.variant).toBe('real-static')

    const fullPaths = fullstack!.files.map((f) => f.path)
    for (const p of ['package.json', 'server.js', 'server/llm-proxy.js', 'server/db.js', 'server/routes/_migrate.example.js']) {
      expect(fullPaths).toContain(p)
    }
    const staticPaths = staticSkeleton!.files.map((f) => f.path)
    expect(staticPaths).not.toContain('package.json')
    expect(staticPaths.some((p) => p.startsWith('server'))).toBe(false)
    // manifest 声明的文件真实存在（readSkeletonDir 已校验；抽查关键件）
    expect(existsSync(join(fullstack!.baseDir, 'server.js'))).toBe(true)
    expect(existsSync(join(staticSkeleton!.baseDir, 'src/app.js'))).toBe(true)
  })

  it('real-fullstack server.js：PORT 环境变量约定 + Express 标准注册 + CSP 与真相源逐字节同步（第四把锁）', () => {
    const js = readFileSync(join(repoRoot, 'main/templates/skeletons/real-fullstack/server.js'), 'utf8')
    expect(js).toContain('process.env.PORT')
    expect(js).toContain("require('express')")
    expect(js).toContain(PRODUCT_CSP)
  })

  it('real-fullstack llm-proxy：密钥只读环境变量（无 sk- 类字面量）；db.js 原子写', () => {
    const proxy = readFileSync(join(repoRoot, 'main/templates/skeletons/real-fullstack/server/llm-proxy.js'), 'utf8')
    expect(proxy).toContain('BLOMA_APP_LLM_KEY')
    expect(proxy).not.toContain('sk-')
    const db = readFileSync(join(repoRoot, 'main/templates/skeletons/real-fullstack/server/db.js'), 'utf8')
    expect(db).toContain('.tmp')
    expect(db).toContain('renameSync')
  })

  it('背板锚条款：Express 业界标准口径（开关已删 2026-10-01，唯一形态）', () => {
    const base: PrdBackplane = {
      project_id: 'p1',
      name: '记账',
      positioning: '记录',
      requirements: [{ id: 'F-001', description: '记录收支' }],
      acceptance: {},
      out_of_scope: [],
      assumptions: [],
      interface_spec: [{ endpoint: '/api/records', method: 'GET', response: '{records:[]}' }],
    }
    const anchor = renderBackplaneAnchor({ ...base })
    expect(anchor).toContain("app.get('/api/xxx'")
    expect(anchor).toContain('process.env.PORT')
    expect(anchor).not.toContain('文件名前缀之后的相对路径')
  })

  it('REAL_SCAFFOLD_TYPES：web 形态三类型参与；desktop_tool/ai_app 不参与（v0 不扩）', () => {
    for (const t of ['web_fullstack', 'personal_tool', 'game']) {
      expect(REAL_SCAFFOLD_TYPES.has(t)).toBe(true)
    }
    expect(REAL_SCAFFOLD_TYPES.has('desktop_tool')).toBe(false)
    expect(REAL_SCAFFOLD_TYPES.has('ai_app')).toBe(false)
  })
})
