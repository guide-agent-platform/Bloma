import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { realFullstackServerFingerprint, writeRealScaffoldMarker } from '../../../main/coding/preview-runtime'
import { isScopeInversion, resolveRoutedRequirementId } from '../../../main/guide/requirement-normalizer'
import { extractConstraints, sanitizeConstraints, scanSessionConstraints } from '../../../main/guide/constraint-extractor'
import { getAgentSessionPath } from '../../../storage/config-paths'
import { restorePromaHome } from '../../support/proma-home-guard'

/**
 * R0 批（2026-09-19 狗粮 7601e5ae「日常收支本」七宗病灶）单测：
 * - R0.3 realFullstackServerFingerprint：变体门控 + server 文件变化可感知
 * - R0.4 约束抓取宿主注入拦截 + 存量指纹清洗
 * - R0.5 out_of_scope 语义反转守卫
 * dist-rebuild 的终验接线属集成面（编程编排器 mock 面大），陈旧检测逻辑经
 * fingerprint/构建门禁单测锁定；此处锁纯函数面。
 */

describe('R0.3 realFullstackServerFingerprint', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let root: string
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'r03-home-'))
    root = mkdtempSync(join(tmpdir(), 'r03-proj-'))
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
    rmSync(root, { recursive: true, force: true })
  })

  it('无变体标记 → null（旧路径守卫直通）', () => {
    expect(realFullstackServerFingerprint(root)).toBeNull()
  })

  it('real-static → null；real-fullstack → 指纹随 server 文件变化', () => {
    writeRealScaffoldMarker(root, 'real-static')
    expect(realFullstackServerFingerprint(root)).toBeNull()
    writeRealScaffoldMarker(root, 'real-fullstack')
    writeFileSync(join(root, 'server.js'), 'const a = 1\n', 'utf8')
    const before = realFullstackServerFingerprint(root)
    expect(typeof before).toBe('string')
    // server/ 子树变化可感知
    mkdirSync(join(root, 'server', 'routes'), { recursive: true })
    writeFileSync(join(root, 'server', 'routes', 'records.js'), 'module.exports = {}\n', 'utf8')
    const afterRoutes = realFullstackServerFingerprint(root)
    expect(afterRoutes).not.toBe(before)
    // 内容不变只改 mtime 也应感知（size 相同、mtime 不同）
    const p = join(root, 'server', 'routes', 'records.js')
    const st = statSync(p)
    utimesSync(p, st.atime, new Date(st.mtimeMs + 5_000))
    expect(realFullstackServerFingerprint(root)).not.toBe(afterRoutes)
  })
})

describe('R0.4 约束抓取宿主注入拦截与存量清洗', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'r04-home-'))
    process.env.PROMA_HOME = home
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
    rmSync(home, { recursive: true, force: true })
  })

  it('宿主注入轮不产生约束：收口指令/任务书/进度对账/learnings 注入全拦截', () => {
    const sessionId = 'r04-injected'
    const lines = [
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: '【收口指令（宿主注入）】工具调用已全部停用。无需再读取或修改任何文件——请直接输出完成总结' }], timestamp: 1 }),
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: '【进度对账（宿主注入）】已完成 3/10，不要动其他任何文件/功能' }], timestamp: 2 }),
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: '目标：处理用户的修改诉求（局部优化）。【本轮任务】把数据存到服务端\n【工作方式】\n1. 先用 grep 定位，再 read_file 只读命中段落——禁止全项目通读\n2. 不要盲改' }], timestamp: 3 }),
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: '<untrusted-memory source="learnings" trust="advisory">历史经验：不要整文件重写</untrusted-memory>' }], timestamp: 4 }),
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: '【任务清单工作流（宿主注入）】已完成清单项勿重做；不要把验证全部留到收尾' }], timestamp: 5 }),
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: '不用做成手机 App，必须离线可用' }], timestamp: 6 }),
    ]
    writeFileSync(getAgentSessionPath(sessionId), lines.join('\n') + '\n', 'utf8')
    const scanned = scanSessionConstraints(sessionId)
    // 真实用户轮的两条约束保留；宿主注入轮一条都不入库
    expect(scanned).toContain('不用做成手机 App')
    expect(scanned).toContain('必须离线可用')
    expect(scanned.some((entry) => entry.includes('无需再读取或修改任何文件'))).toBe(false)
    expect(scanned.some((entry) => entry.includes('禁止全项目通读'))).toBe(false)
    expect(scanned.some((entry) => entry.includes('不要盲改'))).toBe(false)
    expect(scanned.some((entry) => entry.includes('不要整文件重写'))).toBe(false)
    expect(scanned.some((entry) => entry.includes('勿重做'))).toBe(false)
    expect(scanned.some((entry) => entry.includes('留到收尾'))).toBe(false)
    expect(scanned.some((entry) => entry.includes('不要动其他任何文件'))).toBe(false)
  })

  it('审查答题回写轮不产生约束（狗粮 a602709f 补丁：「我选好了…」「补充说明：…」是 UI 选项回显）', () => {
    const sessionId = 'r04-review-echo'
    const lines = [
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: '我选好了，按下面的选择修订：' }], timestamp: 1 }),
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: '补充说明：F-001 / requirements 全表：要，关掉还在；工程模板追加检查·章节完备性：做的人只能自己猜；要不要拦' }], timestamp: 2 }),
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: '确认这份 PRD，开始画草图。' }], timestamp: 3 }),
    ]
    writeFileSync(getAgentSessionPath(sessionId), lines.join('\n') + '\n', 'utf8')
    const scanned = scanSessionConstraints(sessionId)
    expect(scanned).toEqual([])
  })

  it('sanitizeConstraints 剔除狗粮实锤的注入残留，保留正常约束', () => {
    const polluted = [
      '无需登录配置',
      '无需再读取或修改任何文件——请直接输出完成总结：逐项说明已完成的实施清单项与自测情况',
      '禁止先全读再全写',
      '读过的内容不要重读',
      '三项硬约束（必须遵守）：',
      '3. 禁止重构与本轮修复无关的代码',
      '不用做云端同步',
    ]
    const cleaned = sanitizeConstraints(polluted)
    expect(cleaned).toEqual(['无需登录配置', '不用做云端同步'])
  })

  it('extractConstraints 纯函数面不受影响（正常约束仍可提取）', () => {
    expect(extractConstraints('界面要全中文，必须支持离线')).toContain('必须支持离线')
  })
})

describe('R0.5 out_of_scope 语义反转守卫', () => {
  it('狗粮实锤案例：正向诉求 × 否定式范围声明 → 判反转', () => {
    expect(isScopeInversion('把数据存到服务端', '不做服务端存储，流水数据仅保存在本机')).toBe(true)
  })

  it('正常范围声明不受影响：否定诉求 × 否定式声明', () => {
    expect(isScopeInversion('不要排行榜', '不做排行榜功能')).toBe(false)
    expect(isScopeInversion('别做登录', '不做登录')).toBe(false)
  })

  it('正向诉求 × 正面范围澄清不是反转（如仅本机单用户）', () => {
    expect(isScopeInversion('加一个导出功能', '仅支持导出为 JSON')).toBe(true) // 仅 开头视为否定式口径
    expect(isScopeInversion('加一个导出功能', '导出为 JSON 或 CSV')).toBe(false)
  })
})

describe('审查答案路由 resolveRoutedRequirementId（狗粮 a602709f 答案蒸发修复）', () => {
  const ids = new Set(['F-001', 'F-002', 'F-005', 'F-006'])

  it('全等定位照田命中', () => {
    expect(resolveRoutedRequirementId('F-002', ids)).toBe('F-002')
  })

  it('复合定位命中首个存在的功能项 id（旧版全等匹配漏进补充说明旁路的形态）', () => {
    expect(resolveRoutedRequirementId('F-001 / requirements 全表', ids)).toBe('F-001')
    expect(resolveRoutedRequirementId('F-002 / F-006', ids)).toBe('F-002')
    expect(resolveRoutedRequirementId('F-005：分类默认值', ids)).toBe('F-005')
  })

  it('章节类/不存在 id 返回 undefined 走补充说明旁路', () => {
    expect(resolveRoutedRequirementId('工程模板追加检查·章节完备性', ids)).toBeUndefined()
    expect(resolveRoutedRequirementId('F-099 / 不存在的项', ids)).toBeUndefined()
  })
})
