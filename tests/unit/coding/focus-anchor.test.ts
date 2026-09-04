import { afterEach, describe, expect, it } from 'vitest'
import { buildAgentLoopSystemPrompt } from '../../../main/programming-orchestrator'
import { buildSkeletonMapInjection } from '../../../main/template-injection'
import { renderGwtSkeleton } from '../../../main/document-engine'
import { focusAnchorEnabled, renderBackplaneAnchor, type PrdBackplane } from '../../../main/model/prd-backplane'
import type { ProjectSkeleton } from '../../../main/project-templates'

/**
 * P3 任务级三文档契约 · PR-C：迭代分级锚定（renderBackplaneAnchor）。
 * 关键锁定（实施稿 §6 PR-C 测试清单）：
 * - 不传 focus = 全量全文（与旧内联渲染逐字一致，字节级等价现状回归锁）；
 * - revise 分级渲染：目标项全文 + 其余项一行摘要（id+故事+优先级+断言计数，不减锚）；
 * - 断言分级只影响注入，不影响 run_gwt_tests 执行面（renderGwtSkeleton 仍全量派生）；
 * - 骨架地图分级（注入侧）：非目标文件存在性行；
 * - BLOMA_FOCUS_ANCHOR 开关矩阵（quick off / longterm on）。
 */

const BACKPLANE: PrdBackplane = {
  project_id: 'p1',
  name: '历史搜索',
  positioning: '记录与搜索想法的小工具',
  requirements: [
    { id: 'F-001', description: '记录想法', behavior_assertions: ['点击保存按钮→列表新增一条记录'], priority: 'P0' },
    {
      id: 'F-003',
      description: '搜索历史想法',
      story: '作为用户，我想搜索历史想法，以便快速找回',
      behavior_assertions: ['在搜索框输入关键词→历史列表应显示匹配的想法', '清空搜索框→历史列表恢复全部'],
      priority: 'P1',
      status: 'implemented',
    },
    { id: 'F-005', description: '导出记录', behavior_assertions: ['点击导出按钮→生成下载文件'], priority: 'P2' },
  ],
  acceptance: {},
  out_of_scope: ['排行榜'],
  assumptions: [],
}

describe('renderBackplaneAnchor — 分级渲染', () => {
  it('不传 focus：全量全文，与旧内联渲染逐字一致（字节级等价现状回归锁）', () => {
    const anchor = renderBackplaneAnchor(BACKPLANE)
    const expected = [
      '- [F-001]（P0）记录想法\n  行为断言：\n    - 点击保存按钮→列表新增一条记录',
      '- [F-003]（P1）作为用户，我想搜索历史想法，以便快速找回\n  行为断言：\n    - 在搜索框输入关键词→历史列表应显示匹配的想法\n    - 清空搜索框→历史列表恢复全部\n  执行状态：已实现',
      '- [F-005]（P2）导出记录\n  行为断言：\n    - 点击导出按钮→生成下载文件',
    ].join('\n')
    expect(anchor).toBe(expected)
    // focus=[] 与 undefined 同义（空数组=无聚焦=全量）
    expect(renderBackplaneAnchor(BACKPLANE, [])).toBe(anchor)
  })

  it('focus 命中项全文 + 其余项一行摘要（id+故事+优先级+断言计数+执行状态；断言细节折叠）', () => {
    const anchor = renderBackplaneAnchor(BACKPLANE, ['F-003'])
    // 命中项：全文（含断言与执行状态）
    expect(anchor).toContain('- [F-003]（P1）作为用户，我想搜索历史想法，以便快速找回')
    expect(anchor).toContain('    - 在搜索框输入关键词→历史列表应显示匹配的想法')
    expect(anchor).toContain('  执行状态：已实现')
    // 未命中项：一行摘要（锚不丢：id/故事/优先级/断言计数在），断言细节不在
    expect(anchor).toContain('- [F-001]（P0）记录想法（断言 1 条）——本轮未聚焦')
    expect(anchor).toContain('- [F-005]（P2）导出记录（断言 1 条）——本轮未聚焦')
    expect(anchor).not.toContain('点击保存按钮→列表新增一条记录')
    expect(anchor).not.toContain('点击导出按钮→生成下载文件')
  })

  it('多焦点：reviseId 与 append 新项同时命中（各自全文）', () => {
    const anchor = renderBackplaneAnchor(BACKPLANE, ['F-001', 'F-005'])
    expect(anchor).toContain('    - 点击保存按钮→列表新增一条记录')
    expect(anchor).toContain('    - 点击导出按钮→生成下载文件')
    expect(anchor).toContain('- [F-003]（P1）作为用户，我想搜索历史想法，以便快速找回（断言 2 条，已实现）——本轮未聚焦')
  })
})

describe('buildAgentLoopSystemPrompt — focus 接线', () => {
  it('不传 focus 字节级等价：第 5 参缺省与显式 undefined 输出一致；无聚焦提示行', () => {
    const promptDefault = buildAgentLoopSystemPrompt(BACKPLANE, 'diff', undefined, null)
    const promptExplicit = buildAgentLoopSystemPrompt(BACKPLANE, 'diff', undefined, null, undefined)
    expect(promptDefault).toBe(promptExplicit)
    expect(promptDefault).not.toContain('本轮迭代聚焦')
    // 全量断言都在（现状行为）
    expect(promptDefault).toContain('在搜索框输入关键词→历史列表应显示匹配的想法')
  })

  it('focus 生效：聚焦提示行 + 命中项全文 + 其余项摘要（P0 执行面提示保留）', () => {
    const prompt = buildAgentLoopSystemPrompt(BACKPLANE, 'diff', undefined, null, ['F-003'])
    expect(prompt).toContain('本轮迭代聚焦：F-003')
    expect(prompt).toContain('run_gwt_tests 仍会全量验证全部 P0 断言')
    expect(prompt).toContain('    - 在搜索框输入关键词→历史列表应显示匹配的想法')
    expect(prompt).toContain('- [F-001]（P0）记录想法（断言 1 条）——本轮未聚焦')
    expect(prompt).not.toContain('点击保存按钮→列表新增一条记录')
  })

  it('P1-7：game 类型背板带 GDD → 注入玩法真相源段；无 GDD → 零注入', () => {
    const withGdd: PrdBackplane = {
      ...BACKPLANE,
      gdd: {
        core_fantasy: '扮演蛇在有限空间吃食物',
        pillars: ['操作反馈即时', '风险与成长并存'],
        core_loop: ['移动', '吃食物', '变长'],
        numbers: ['生命 1', '初始长度 3'],
      },
    }
    const prompt = buildAgentLoopSystemPrompt(withGdd, 'diff')
    expect(prompt).toContain('玩法设计文档（GDD，机制真相源）')
    expect(prompt).toContain('核心幻想：扮演蛇在有限空间吃食物')
    expect(prompt).toContain('核心循环：移动 → 吃食物 → 变长')
    expect(prompt).toContain('数值基准：生命 1；初始长度 3')

    const noGdd = buildAgentLoopSystemPrompt(BACKPLANE, 'diff')
    expect(noGdd).not.toContain('玩法设计文档')
  })
})

describe('断言分级只影响注入不影响探针执行面（D3+硬约束 4）', () => {
  it('system 折叠了未聚焦 P0 项断言，renderGwtSkeleton 仍为全部功能项派生场景', () => {
    const prompt = buildAgentLoopSystemPrompt(BACKPLANE, 'diff', undefined, null, ['F-003'])
    // 注入面：F-001（P0）断言被折叠
    expect(prompt).not.toContain('点击保存按钮→列表新增一条记录')
    // 执行面：GWT 骨架派生不受 focus 影响（全部功能项都有 feature，含未聚焦 P0 项断言）
    const features = renderGwtSkeleton(BACKPLANE)
    expect(features.map((feature) => feature.fileName)).toEqual(['F-001.feature', 'F-003.feature', 'F-005.feature'])
    expect(features[0].content).toContain('点击保存按钮→列表新增一条记录')
  })
})

describe('buildSkeletonMapInjection — 骨架地图分级（注入侧）', () => {
  const skeleton: ProjectSkeleton = {
    template_type: 'web_fullstack',
    version: 1,
    source: 'builtin',
    files: [
      { path: 'index.html', role: '入口页面' },
      { path: 'src/app.js', role: '交互逻辑' },
      { path: 'src/styles.css', role: '样式' },
      { path: 'src/examples/data-module.js', role: '只读示例', readonly: true },
    ],
  } as unknown as ProjectSkeleton

  it('未传 focusFiles：全量现状（含职责与只读标注）', () => {
    const map = buildSkeletonMapInjection(skeleton, { written: ['index.html'], skipped: [] })!
    expect(map).toContain('- index.html：入口页面')
    expect(map).toContain('- src/examples/data-module.js：只读示例（只读）')
  })

  it('focusFiles 生效：命中文件全文，其余降为存在性行（路径锚不丢）', () => {
    const map = buildSkeletonMapInjection(skeleton, { written: [], skipped: ['index.html'] }, ['src\\app.js', 'index.html'])!
    expect(map).toContain('- index.html：入口页面')
    expect(map).toContain('- src/app.js：交互逻辑')
    // 未命中：路径在、职责折叠
    expect(map).toContain('- src/styles.css（本轮未涉及：保持现状勿改写）')
    expect(map).toContain('- src/examples/data-module.js（本轮未涉及：保持现状勿改写）')
    expect(map).not.toContain('src/styles.css：样式')
  })
})

describe('focusAnchorEnabled — 开关矩阵（D7 连锁）', () => {
  const original = process.env.BLOMA_FOCUS_ANCHOR
  afterEach(() => {
    if (original === undefined) delete process.env.BLOMA_FOCUS_ANCHOR
    else process.env.BLOMA_FOCUS_ANCHOR = original
  })

  it('未设：longterm=on / quick=off；0/1 覆盖', () => {
    delete process.env.BLOMA_FOCUS_ANCHOR
    expect(focusAnchorEnabled('longterm')).toBe(true)
    expect(focusAnchorEnabled('quick')).toBe(false)
    process.env.BLOMA_FOCUS_ANCHOR = '0'
    expect(focusAnchorEnabled('longterm')).toBe(false)
    process.env.BLOMA_FOCUS_ANCHOR = '1'
    expect(focusAnchorEnabled('quick')).toBe(true)
  })
})
