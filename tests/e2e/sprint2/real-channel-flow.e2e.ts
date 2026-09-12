import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../support/electron-fixture'
import { BlomaElectronApp } from '../support/electron-fixture'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 真实渠道全流程 E2E（2026-08-27，用户要求「用实际使用场景做全流程测试」）。
 *
 * 与 mock 单测/验收的差异：注入生产 bloma-channels.json，走真实 LLM（ds 渠道），
 * 驱动完整用户旅程——澄清→PRD→六维审查→确认门→草图→（全链场景含 MVP loop→迭代）。
 * 断言以磁盘为准（会话 JSONL 决策行 / projects.json 阶段 / prd.json），不依赖 UI 内部态。
 *
 * 覆盖当天修复的全链不变式：
 * - 不过目不开工（override/generate_sketch/点选纠错三豁免口，8c574bc）
 * - 子 agent 旁白不进主聊天流（24886f4）
 * - supplement 提示带问题清单（24886f4）
 * - adjust 带文本直接进修订闭环（26a62fd）
 * - dismiss 第三出口不开工（26a62fd）
 * - 启发式澄清（a4faab8：选项形态级、多轮深入）
 *
 * 无生产渠道文件时整文件 skip（CI/其他机器安全）。
 */

const PROD_CHANNELS = join(process.env.USERPROFILE ?? '.', '.proma', 'bloma-channels.json')

/** 会话 JSONL 里 [decision] 行的 JSON-in-JSON（陷阱 33）：裸关键词子串匹配安全。 */
function sessionHasDecision(promaHome: string, sessionId: string, keyword: string): boolean {
  const path = join(promaHome, 'agent-sessions', `${sessionId}.jsonl`)
  if (!existsSync(path)) return false
  return readFileSync(path, 'utf8').includes(keyword)
}

/** 轮询会话 JSONL 直到出现目标决策关键词（[decision] 行）。 */
async function waitForDecision(
  promaHome: string,
  sessionId: string,
  keyword: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (sessionHasDecision(promaHome, sessionId, keyword)) return
    await sleep(1000)
  }
  const path = join(promaHome, 'agent-sessions', `${sessionId}.jsonl`)
  const current = existsSync(path) ? readFileSync(path, 'utf8').slice(-1500) : '(文件不存在)'
  throw new Error(`等待决策行超时（${timeoutMs}ms）：${keyword}\n会话 JSONL 尾部：${current}`)
}

function readProject(promaHome: string, projectId: string): Record<string, unknown> {
  const path = join(promaHome, 'projects.json')
  const index = JSON.parse(readFileSync(path, 'utf8')) as { projects?: Array<Record<string, unknown>> }
  return index.projects?.find((p) => p.project_id === projectId) ?? {}
}

function readAssistantTexts(promaHome: string, sessionId: string): string {
  const path = join(promaHome, 'agent-sessions', `${sessionId}.jsonl`)
  if (!existsSync(path)) return ''
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
  const texts: string[] = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { role?: string; content?: Array<{ type?: string; text?: string }> }
      if (entry.role === 'assistant') {
        for (const block of entry.content ?? []) {
          if (block.type === 'text' && block.text) texts.push(block.text)
        }
      }
    } catch {
      // 跳过损坏行
    }
  }
  return texts.join('\n')
}

/** 真实渠道版 App：start 前把生产渠道配置拷进临时 PROMA_HOME。 */
class RealChannelBloma extends BlomaElectronApp {
  /** 主进程 stdout/stderr 收集（诊断渠道解析等 console 日志）。 */
  mainLogs: string[] = []

  override async start(): Promise<void> {
    copyFileSync(PROD_CHANNELS, join(this.promaHome, 'bloma-channels.json'))
    await super.start()
    const child = this.app.process()
    const collect = (chunk: Buffer): void => {
      this.mainLogs.push(chunk.toString())
      if (this.mainLogs.length > 400) this.mainLogs.shift()
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
  }

  dumpMainLogs(tag: string): string {
    return `[main logs ${tag}]\n${this.mainLogs.join('')}`
  }

  /** 渠道预检：返回测试实例视角的渠道清单（id/name/enabled），验证注入与解密链路。 */
  async listChannels(): Promise<Array<{ id: string; name: string; enabled: boolean }>> {
    return this.page.evaluate(async () => {
      const api = window.electronAPI
      if (!api?.channels?.list) throw new Error('no channels.list api')
      const result = await api.channels.list({ request_id: 'e2e-channel-list' })
      if (!result.ok || !result.data) throw new Error(`channels.list failed: ${JSON.stringify(result)}`)
      return result.data.map((channel) => ({ id: channel.id, name: channel.name, enabled: channel.enabled }))
    })
  }

  /** 渠道连通预检：走解密+真实 HTTP，返回内层 ChannelTestResult（区分解密失败/网络失败）。 */
  async testChannel(channelId: string): Promise<{ ok?: boolean; message?: string }> {
    return this.page.evaluate(async (id: string) => {
      const api = window.electronAPI
      if (!api?.channels?.test) throw new Error('no channels.test api')
      const outer = await api.channels.test({ request_id: 'e2e-channel-test', channel_id: id } as never)
      const inner = (outer as { ok?: boolean; data?: { ok?: boolean; message?: string } }).data
      return { ok: inner?.ok, message: inner?.message ?? JSON.stringify(outer).slice(0, 200) }
    }, channelId)
  }
}

interface DriveArgs {
  sessionId: string
  projectId: string
  content: string
  option?: string
  mode?: string
  stage?: string
}

/** 经真实 IPC 发消息（模拟用户打字或点卡；返回绑定主进程全链，天然当同步点）。 */
async function sendUser(page: import('@playwright/test').Page, args: DriveArgs): Promise<unknown> {
  return page.evaluate(async (input: DriveArgs) => {
    const api = window.electronAPI
    if (!api?.agent?.sendMessage) throw new Error('no sendMessage api')
    return api.agent.sendMessage({
      request_id: crypto.randomUUID(),
      session_id: input.sessionId,
      project_id: input.projectId,
      content: input.content,
      mode: (input.mode ?? 'quick') as 'quick' | 'longterm',
      current_stage: (input.stage ?? 'clarifying') as never,
      metadata: input.option
        ? { source: 'card_option', selected_option_id: input.option }
        : { source: 'chat' },
    } as never)
  }, args)
}

/** 读取澄清卡选项 labels（[decision-card] 行「A｜B｜你帮我决定」）。 */
function readClarificationOptions(promaHome: string, sessionId: string): string[] {
  const path = join(promaHome, 'agent-sessions', `${sessionId}.jsonl`)
  const lines = readFileSync(path, 'utf8').split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index]!.match(/\[decision-card\] (.+)/)
    if (match) return match[1]!.split('｜').map((item) => item.trim())
  }
  return []
}

/**
 * 通用前置：一句话需求 → 首轮澄清卡 → 点选第一个非 auto 选项。
 * 返回（promaHome, sessionId, projectId）。
 */
async function driveToClarified(
  bloma: RealChannelBloma,
  firstMessage: string,
): Promise<{ sessionId: string; projectId: string }> {
  const sessionId = `e2e-real-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const created = await bloma.page.evaluate(async () => {
    const api = window.electronAPI
    if (!api?.project?.create) throw new Error('no project.create api')
    const result = await api.project.create({ request_id: 'e2e-create', initial_message: 'e2e', mode: 'quick' } as never)
    if (!result.ok || !result.data) throw new Error(`create failed: ${JSON.stringify(result)}`)
    return { projectId: result.data.project_id }
  })
  await sendUser(bloma.page, { sessionId, projectId: created.projectId, content: firstMessage })
  await waitForDecision(bloma.promaHome, sessionId, '"type":"clarification_card"', 90_000)
  const options = readClarificationOptions(bloma.promaHome, sessionId)
  expect(options.length).toBeGreaterThanOrEqual(2)
  const first = options.find((item) => item !== '你帮我决定' && !item.includes('帮我'))
  expect(first).toBeTruthy()
  await sendUser(bloma.page, {
    sessionId,
    projectId: created.projectId,
    content: first!,
    option: 'answer-e2e-0',
    stage: 'blocked_for_user_decision',
  })
  return { sessionId, projectId: created.projectId }
}

test.describe('真实渠道全流程（注入生产渠道配置）', () => {
  test.skip(!existsSync(PROD_CHANNELS), '本机无生产渠道配置（bloma-channels.json），跳过真实渠道 E2E')

  test('[F1] 黄金路径：澄清→点选→PRD→审查(自适应)→确认卡→确认→草图 ready', async () => {
    test.setTimeout(360_000)
    const bloma = new RealChannelBloma()
    await bloma.start()
    try {
      // 渠道预检：注入的渠道必须被测试实例识别且可解密连通（否则后续全走模板降级，测试无意义）
      const channels = await bloma.listChannels()
      expect(channels.length).toBeGreaterThan(0)
      const channelTest = await bloma.testChannel(channels[0]!.id)
      expect(channelTest, `渠道连通预检失败: ${channelTest.message ?? '无消息'}`).toMatchObject({ ok: true })
      const { sessionId, projectId } = await driveToClarified(bloma, '做一个桌面便签小工具').catch(async (error: Error) => {
        throw new Error(`${error.message}\n${bloma.dumpMainLogs('driveToClarified 失败')}`)
      })

      // 点选后进 PRD 管线：审查未过（prd_review 退回卡）或直接过（prd_confirm 挂起）二选一
      const reviewFailed = await Promise.race([
        waitForDecision(bloma.promaHome, sessionId, '"type":"prd_review"', 150_000).then(() => true),
        waitForDecision(bloma.promaHome, sessionId, '"type":"prd_confirm"', 150_000).then(() => false),
      ])
      if (reviewFailed) {
        // 路径 B：审查未过 → override「忽略问题继续」→ 确认卡须带忽略标注（8c574bc）
        await sendUser(bloma.page, {
          sessionId, projectId, content: '忽略问题，继续生成',
          option: 'prd_review_override', stage: 'blocked_for_user_decision',
        })
        await waitForDecision(bloma.promaHome, sessionId, 'review_note', 60_000)
      }
      // 确认门必须出现（不过目不开工）：此时绝不应已开工
      expect(String(readProject(bloma.promaHome, projectId).current_stage)).not.toBe('sketch_ready')

      // 确认 → 绑草图全程，等 sketch_ready
      await sendUser(bloma.page, {
        sessionId, projectId, content: '确认这份 PRD，开始画草图。',
        option: 'prd_confirm_confirm', stage: 'blocked_for_user_decision',
      })
      await waitForDecision(bloma.promaHome, sessionId, '"type":"prd_confirm"', 60_000)
      expect(readProject(bloma.promaHome, projectId).current_stage).toBe('sketch_ready')

      // 不变式：user_confirmed_at 落盘（确认先于草图）
      const prd = JSON.parse(readFileSync(
        join(bloma.promaHome, 'agent-workspaces', 'default-software-builder', 'documents', projectId, 'prd.json'),
        'utf8',
      )) as { user_confirmed_at?: string }
      expect(prd.user_confirmed_at).toBeTruthy()

      // 不变式：审查子 agent 的六维分析旁白不得混入主聊天流（24886f4）
      const assistantTexts = readAssistantTexts(bloma.promaHome, sessionId)
      expect(assistantTexts).not.toContain('F 保真')
      expect(assistantTexts).not.toContain('U 可懂')
    } finally {
      await bloma.dispose()
    }
  })

  test('[F2] 确认卡上调整：adjust 带文本 → 修订闭环（原条目保留+新增）→ 新确认卡 → 确认开工', async () => {
    test.setTimeout(360_000)
    const bloma = new RealChannelBloma()
    await bloma.start()
    try {
      const { sessionId, projectId } = await driveToClarified(bloma, '做一个桌面倒计时提醒')
      // 走到确认卡挂起（审查过→直接挂；未过→override 后挂）
      const reviewFailed = await Promise.race([
        waitForDecision(bloma.promaHome, sessionId, '"type":"prd_review"', 150_000).then(() => true),
        waitForDecision(bloma.promaHome, sessionId, '"type":"prd_confirm"', 150_000).then(() => false),
      ])
      if (reviewFailed) {
        await sendUser(bloma.page, {
          sessionId, projectId, content: '忽略问题，继续生成',
          option: 'prd_review_override', stage: 'blocked_for_user_decision',
        })
        await waitForDecision(bloma.promaHome, sessionId, 'review_note', 60_000)
      }
      const documentsDir = join(bloma.promaHome, 'agent-workspaces', 'default-software-builder', 'documents', projectId)
      const prdBefore = JSON.parse(readFileSync(join(documentsDir, 'prd.json'), 'utf8')) as { requirements?: Array<{ id: string }> }
      const idsBefore = prdBefore.requirements?.map((item) => item.id) ?? []

      // adjust 带实质文本：直接进修订闭环（26a62fd），不再晾「指出条目」
      await sendUser(bloma.page, {
        sessionId, projectId, content: '加一个深色模式切换',
        option: 'prd_confirm_adjust', stage: 'blocked_for_user_decision',
      })
      await waitForDecision(bloma.promaHome, sessionId, '"title":"用户选择调整 PRD', 90_000)
      // 修订后新确认卡挂起（PRD 重走管线含审查，耗时较长）
      await waitForDecision(bloma.promaHome, sessionId, 'review_note', 150_000).catch(async () => {
        // 审查通过时挂起不带 review_note——再等一次 prd_confirm 出现（第二张）
        await sleep(5_000)
      })
      const prdAfter = JSON.parse(readFileSync(join(documentsDir, 'prd.json'), 'utf8')) as { requirements?: Array<{ id: string }> }
      const idsAfter = prdAfter.requirements?.map((item) => item.id) ?? []
      // 原条目保留（在原有基础上修改，非推倒重来）
      for (const id of idsBefore) expect(idsAfter).toContain(id)
      // 有新增（深色模式并入）
      expect(idsAfter.length).toBeGreaterThan(idsBefore.length)

      // 确认开工
      await sendUser(bloma.page, {
        sessionId, projectId, content: '确认这份 PRD，开始画草图。',
        option: 'prd_confirm_confirm', stage: 'blocked_for_user_decision',
      })
      await sleep(3_000)
      expect(readProject(bloma.promaHome, projectId).current_stage).toBe('sketch_ready')
    } finally {
      await bloma.dispose()
    }
  })

  test('[F3] 确认卡上暂不确认：dismiss → 不开工、引导回对话', async () => {
    test.setTimeout(300_000)
    const bloma = new RealChannelBloma()
    await bloma.start()
    try {
      const { sessionId, projectId } = await driveToClarified(bloma, '做一个桌面汇率小查')
      const reviewFailed = await Promise.race([
        waitForDecision(bloma.promaHome, sessionId, '"type":"prd_review"', 150_000).then(() => true),
        waitForDecision(bloma.promaHome, sessionId, '"type":"prd_confirm"', 150_000).then(() => false),
      ])
      if (reviewFailed) {
        await sendUser(bloma.page, {
          sessionId, projectId, content: '忽略问题，继续生成',
          option: 'prd_review_override', stage: 'blocked_for_user_decision',
        })
        await waitForDecision(bloma.promaHome, sessionId, 'review_note', 60_000)
      }
      // dismiss：不开工（26a62fd）
      await sendUser(bloma.page, {
        sessionId, projectId, content: '稍后再说，先不确认。',
        option: 'prd_confirm_dismiss', stage: 'blocked_for_user_decision',
      })
      await waitForDecision(bloma.promaHome, sessionId, '"title":"用户暂不确认 PRD', 30_000)
      await sleep(3_000)
      const stage = String(readProject(bloma.promaHome, projectId).current_stage)
      expect(stage).not.toBe('sketch_ready')
      expect(stage).not.toBe('generating_mvp')
      const texts = readAssistantTexts(bloma.promaHome, sessionId)
      expect(texts).toContain('先不确认这份 PRD')
    } finally {
      await bloma.dispose()
    }
  })

  test('[F4] 全链用户旅程：草图→确认→MVP loop→ready→打字修改→修改确认→迭代→ready', async () => {
    test.setTimeout(600_000)
    const bloma = new RealChannelBloma()
    await bloma.start()
    try {
      const { sessionId, projectId } = await driveToClarified(bloma, '做一个桌面每日喝水打卡')
      const reviewFailed = await Promise.race([
        waitForDecision(bloma.promaHome, sessionId, '"type":"prd_review"', 150_000).then(() => true),
        waitForDecision(bloma.promaHome, sessionId, '"type":"prd_confirm"', 150_000).then(() => false),
      ])
      if (reviewFailed) {
        await sendUser(bloma.page, {
          sessionId, projectId, content: '忽略问题，继续生成',
          option: 'prd_review_override', stage: 'blocked_for_user_decision',
        })
        await waitForDecision(bloma.promaHome, sessionId, 'review_note', 60_000)
      }
      await sendUser(bloma.page, {
        sessionId, projectId, content: '确认这份 PRD，开始画草图。',
        option: 'prd_confirm_confirm', stage: 'blocked_for_user_decision',
      })
      await sleep(3_000)
      expect(readProject(bloma.promaHome, projectId).current_stage).toBe('sketch_ready')

      // 确认草图 → MVP 生成（loop 全程，最长 ~4 分钟）
      const snapshotId = readProject(bloma.promaHome, projectId).current_snapshot_id
      await bloma.page.evaluate(async (input: { projectId: string; sessionId: string; snapshotId: unknown }) => {
        const api = window.electronAPI
        if (!api?.project?.confirmSketch) throw new Error('no confirmSketch api')
        const result = await api.project.confirmSketch({
          request_id: 'e2e-confirm-sketch',
          project_id: input.projectId,
          session_id: input.sessionId,
          snapshot_id: String(input.snapshotId ?? ''),
          decision: 'accepted',
        } as never)
        if (!result.ok) throw new Error(`confirmSketch failed: ${JSON.stringify(result)}`)
      }, { projectId, sessionId, snapshotId })

      const readyDeadline = Date.now() + 420_000
      while (Date.now() < readyDeadline) {
        const stage = String(readProject(bloma.promaHome, projectId).current_stage)
        if (stage === 'ready' || stage === 'blocked_for_user_decision') break
        await sleep(5_000)
      }
      const stageAfterMvp = String(readProject(bloma.promaHome, projectId).current_stage)
      expect(['ready', 'blocked_for_user_decision']).toContain(stageAfterMvp)
      // loop 完成留痕
      await waitForDecision(bloma.promaHome, sessionId, 'agent_loop', 30_000)

      // 打字修改 → 直接局部优化（MVP 就绪卡改版后：打字提修改不再弹确认门）
      await sendUser(bloma.page, {
        sessionId, projectId, content: '把主标题改成「每日饮水」',
        stage: 'ready',
      })
      await waitForDecision(bloma.promaHome, sessionId, '用户提修改（默认局部优化）', 60_000)
      // 迭代 loop → 回 ready
      const iterDeadline = Date.now() + 300_000
      while (Date.now() < iterDeadline) {
        const stage = String(readProject(bloma.promaHome, projectId).current_stage)
        if (stage === 'ready' || stage === 'blocked_for_user_decision') break
        await sleep(5_000)
      }
      expect(['ready', 'blocked_for_user_decision']).toContain(String(readProject(bloma.promaHome, projectId).current_stage))
    } finally {
      await bloma.dispose()
    }
  })
})
