import { restorePromaHome } from '../support/proma-home-guard'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// 2026-09-16 FILE-LEVEL 钉：BLOMA_GUIDE_LOOP 缺省翻转 on，本文件锁旧路径读取侧口径
// （loop 模式下约束系统行经 historyTurns→messages 送达，捕获参数不同；行为等价）
import { captureConstraints, extractConstraints, sanitizeConstraints, scanSessionConstraints } from '../../main/guide/constraint-extractor'
import { buildPrdBackplane } from '../../main/project/document-engine'
import { HISTORY_WINDOW_TURNS } from '../../main/orchestration/orchestrator'
import { setSafeStorageAdapter } from '../../main/platform/storage/safe-storage'
import { createProject, findProject } from '../../main/project/project-service'
import { getAgentSessionPath } from '../../storage/config-paths'
import type { PrdBackplane, SketchRequirement } from '../../main/coding/sketch-engine'
import type { AgentMessage } from '../../shared/types'
// 2026-10-03 删留执行：runAgent/setSDKQueryForTests/setAgentStreamPublisher/createChannel/
// SDKMessage/vi 为头注所述「端到端回灌」用例（已不存在）的死 import，已清。
/**
 * T4-L1/L2 确定性记忆主路（2026-08-18 修订版设计）：
 * 约束走门进背板（写入侧）+ 窗口改造与全量扫描（读取侧）。
 *
 * 验收核心场景「首轮约束 >30 轮仍生效」在这里以纯确定性链路锁定：
 * 提取 → 门捕获入库 → 背板组装 → 草图/MVP 提示词注入 → 全量扫描回灌，
 * 全程不依赖 LLM（L3 蒸馏是线上实测有漏才启用的兜底，另见 memory-distiller.test）。
 */
const originalPromaHome = process.env.PROMA_HOME
function useTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'bloma-constraint-'))
  process.env.PROMA_HOME = home
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  })
  return home
}
function writeSession(sessionId: string, messages: AgentMessage[]): void {
  const path = getAgentSessionPath(sessionId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, messages.map((message) => JSON.stringify(message)).join('\n') + '\n', 'utf8')
}
function turn(role: 'user' | 'assistant', text: string, index: number): AgentMessage {
  return { role, content: [{ type: 'text', text }], timestamp: index }
}
/** 生成 n 轮对话：第 1 轮用户消息带约束，其余是普通往返。 */
function longSession(turns: number): AgentMessage[] {
  const messages: AgentMessage[] = [turn('user', '帮我做一个记账应用，不含登录', 1), turn('assistant', '好的，先确认几个关键点。', 2)]
  for (let i = 3; i < turns * 2; i += 2) {
    messages.push(turn('user', `第 ${i} 轮：再细化一下界面`, i))
    messages.push(turn('assistant', `第 ${i + 1} 轮：已记录。`, i + 1))
  }
  return messages
}
describe('T4-L1 extractConstraints 确定性提取', () => {
  it('提取排除类与要求类约束短语', () => {
    expect(extractConstraints('做一个记账 app，不含登录，必须离线可用')).toEqual(['不含登录', '必须离线可用'])
    expect(extractConstraints('界面要克制，禁止联网，数据只能存本地')).toEqual(['禁止联网', '数据只能存本地'])
    expect(extractConstraints('不要排行榜')).toEqual(['不要排行榜'])
    expect(extractConstraints('别用英文，务必中文界面')).toEqual(['别用英文', '务必中文界面'])
  })
  it('无约束的普通诉求/寒暄不产生噪声', () => {
    expect(extractConstraints('帮我做一个记账本')).toEqual([])
    expect(extractConstraints('好的，就这样')).toEqual([])
    expect(extractConstraints('')).toEqual([])
  })
})
describe('T4-L2 全量扫描：首轮约束历轮可回', () => {
  beforeEach(() => {
    useTempHome()
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })
  it('>30 轮会话，第 1 轮约束仍被扫出（读取侧不靠窗口）', () => {
    writeSession('session-long', longSession(32))
    expect(scanSessionConstraints('session-long')).toContain('不含登录')
  })
  it('只认 user 角色——assistant 的转述不算用户声明', () => {
    writeSession('session-assistant-only', [
      turn('assistant', '我会遵守不含登录这个要求', 1),
      turn('user', '帮我做个工具', 2),
    ])
    expect(scanSessionConstraints('session-assistant-only')).toEqual([])
  })
  it('平台合成 user 轮（修复任务卡/退行反馈）不参与约束提取', () => {
    writeSession('session-synthetic', [
      turn('user', '## 修复任务（共 1 项）\n三项硬约束（必须遵守）：1. 不要动其他任何文件或功能；2. 禁止重构无关代码。', 1),
      turn('user', '【传输事故反馈】请重新输出这一轮，不要复述无效文本。', 2),
      turn('user', '帮我做个工具，不要排行榜', 3),
    ])
    const constraints = scanSessionConstraints('session-synthetic')
    expect(constraints).toEqual(['不要排行榜'])
  })
  it('拒收续接指令轮（[system·拒收续接]）不进约束流——批10 旧账②：拒因话术「不要去补报告文件」曾入库', () => {
    writeSession('session-continuation', [
      turn('user', '帮我做个工具，不含登录', 1),
      turn('assistant', '好的。', 2),
      turn(
        'user',
        '[system·拒收续接] 阶段「desktop-verify」的推进声明被裁决边界拒绝（gate-deny，拒因=driver-blocked），请立即按以下指引继续工作：\n门禁未过：驱动执行未达验收结论（driver-blocked=环境阻塞如超时/装配，不是产物缺失，不要去补报告文件；driver-fail=断言未过）——请按下方「门禁拒因详情」修复后重新声明推进。\n输出纪律提醒：面向用户文本一律中文、≤2 句要点。',
        3,
      ),
    ])
    const constraints = scanSessionConstraints('session-continuation')
    expect(constraints).toEqual(['不含登录'])
    expect(constraints.some((c) => c.includes('补报告'))).toBe(false)
  })
  it('平台壳前缀剥离（批10.5 审查B P1-1）：迭代/steer 壳只剥模板部分，用户真话约束照常提取', () => {
    writeSession('session-shell-strip', [
      turn('user', '【交付前迭代】用户对验收通过产物的修改意见，按此修改实现（其余功能与已验证行为保持不变）：不要加登录页', 1),
      turn('user', '【交付后迭代】用户对已交付产物的反馈，按此修改实现（其余功能与已验证行为保持不变）：不要用外部 API', 2),
      turn('user', '【用户中途补充】列表必须是卡片式', 3),
    ])
    const constraints = scanSessionConstraints('session-shell-strip')
    expect(constraints).toContain('不要加登录页')
    expect(constraints).toContain('不要用外部 API')
    expect(constraints).toContain('列表必须是卡片式')
    // 壳文本本身不得混入任何一条约束
    expect(constraints.some((c) => c.includes('按此修改实现') || c.includes('保持不变') || c.includes('【'))).toBe(false)
  })
  it('存量污染兑底：入库的拒因话术「不要去补报告文件」被读取侧清洗（批10 旧账②）', () => {
    expect(sanitizeConstraints(['不含登录', '不要去补报告文件'])).toEqual(['不含登录'])
  })
  it('历史窗口是显式常量（默认 10 轮，不再静默写死 20）', () => {
    expect(HISTORY_WINDOW_TURNS).toBe(10)
  })
})
describe('T4-L1 约束走门：捕获入库与决策留痕', () => {
  beforeEach(() => {
    useTempHome()
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })
  it('captureConstraints 持久化 project.constraints 并落决策行；重复声明不重复入库', () => {
    const project = createProject({ request_id: 'req-c', mode: 'quick', initial_message: '记账本' })
    const first = captureConstraints({
      project_id: project.project_id,
      session_id: 'session-c',
      constraints: extractConstraints('不含登录，必须离线可用'),
      source: 'guide_gate',
    })
    expect(first).toEqual(['不含登录', '必须离线可用'])
    expect(findProject(project.project_id).constraints).toEqual(['不含登录', '必须离线可用'])
    // 重复声明：不加噪声、不再落决策
    const second = captureConstraints({
      project_id: project.project_id,
      session_id: 'session-c',
      constraints: ['不含登录'],
      source: 'session_scan',
    })
    expect(second).toEqual([])
    expect(findProject(project.project_id).constraints).toEqual(['不含登录', '必须离线可用'])
    const sessionLines = readFileSync(getAgentSessionPath('session-c'), 'utf8')
    expect(sessionLines.match(/constraint_captured/g)?.length).toBe(1)
  })
  it('项目索引缺失（测试字面 id）时静默跳过，不抛错不阻塞主流程', () => {
    expect(() =>
      captureConstraints({ project_id: 'literal-id', session_id: 'session-x', constraints: ['不含登录'], source: 'guide_gate' }),
    ).not.toThrow()
  })
  it('buildPrdBackplane 组装 constraints 常驻注入', () => {
    const project = createProject({ request_id: 'req-bp', mode: 'quick', initial_message: '记账本' })
    captureConstraints({ project_id: project.project_id, session_id: 'session-bp', constraints: ['不含登录', '必须离线可用'], source: 'guide_gate' })
    const requirements: SketchRequirement[] = [{ id: 'F-001', description: '记账本' }]
    const backplane = buildPrdBackplane(findProject(project.project_id), requirements, 'sketch_confirmed')
    expect(backplane.constraints).toEqual(['不含登录', '必须离线可用'])
  })
})
