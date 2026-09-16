/**
 * 向导工具面（Phase 10 向导 loop 化，2026-09-16，用户拍板「直接同步 loop，只改工具」）。
 *
 * 设计：向导的模型调用层接入 runAgentLoop（与编程 Agent 同一运行时），自由度来自
 * loop——模型可先读项目事实、可自然对话，再决定动作；结构化决策从「文本里解析
 * JSON」（parseGuideJson 家族的 PARSE_FAILED/截断旧病）变成原生 tool_use 输入。
 *
 * 护栏全部留在宿主（本模块不做任何流程决策）：
 * - guide_decide 只是决策的**提交口**（每 run 一次），收束/熔断/确认门仍由
 *   guide-agent-service 的既有路由块与平台状态机裁决；
 * - 三个只读事实工具解决「向导看不见产物」（迭代澄清时用户说「上次那个报错」，
 *   向导能查到再问）；无写类、无委派类工具。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findProject } from '../project-service'
import { readPrdBackplane } from '../document-engine'
import { getDocumentsDir } from '../../storage/config-paths'
import type { AgentLoopTool } from '../agent-loop'

/** 开关：off = 向导澄清腿维持单次流式 JSON 现状（字节级）。 */
export function guideLoopEnabled(): boolean {
  // 2026-09-16 缺省翻转 on（用户拍板「直接接向导 agent」）：向导澄清腿缺省走 agent loop
  // （自由对话 + 只读事实工具 + guide_decide 决策口），旧单次 JSON 路径退为逃生口
  // （=0/'false'）；「你是谁」类非需求输入由模型 free_chat 语义自然处理，不再依赖
  // 关键词硬门槛（isQuestionLikeTheme 仅作旧路径兑底，见 guide-agent-service）。
  const raw = process.env.BLOMA_GUIDE_LOOP
  return raw !== '0' && raw !== 'false'
}

/** 向导结构化决策（与 guide-agent-service 的 GuideParsed 同构；由服务侧归一为路由输入）。 */
export interface GuideDecision {
  action: 'ask_clarification' | 'confirm_requirements' | 'generate_sketch'
  reply: string
  questions?: Array<{ id: string; label: string; description?: string }>
  requirements?: Array<{ id: string; description: string; origin?: 'user' | 'guide' }>
  research_queries?: string[]
}

/** 决策提交回调（宿主持有；每 run 至多一次有效提交）。 */
export interface GuideToolsOptions {
  onDecide: (decision: GuideDecision) => void
}

/** guide_decide 参数校验（宽松收形：细节归一由下游 normalizeClarificationOptions/ensurePrimaryIntent 完成）。 */
function validateDecision(raw: Record<string, unknown>): { ok: true; decision: GuideDecision } | { ok: false; error: string } {
  const action = raw.action
  if (action !== 'ask_clarification' && action !== 'confirm_requirements' && action !== 'generate_sketch') {
    return { ok: false, error: 'action 只能是 ask_clarification / confirm_requirements / generate_sketch。' }
  }
  const reply = typeof raw.reply === 'string' ? raw.reply : ''
  const questions = Array.isArray(raw.questions)
    ? raw.questions.filter(
        (q): q is { id: string; label: string; description?: string } =>
          typeof q === 'object' && q !== null && typeof (q as { id?: unknown }).id === 'string' && typeof (q as { label?: unknown }).label === 'string',
      )
    : []
  const requirements = Array.isArray(raw.requirements)
    ? raw.requirements.filter(
        (r): r is { id: string; description: string; origin?: 'user' | 'guide' } =>
          typeof r === 'object' && r !== null && typeof (r as { id?: unknown }).id === 'string' && typeof (r as { description?: unknown }).description === 'string',
      )
    : []
  const researchQueries = Array.isArray(raw.research_queries)
    ? raw.research_queries.filter((q): q is string => typeof q === 'string')
    : []
  return {
    ok: true,
    decision: {
      action,
      reply,
      ...(action === 'ask_clarification' ? { questions } : {}),
      ...(action !== 'ask_clarification' ? { requirements } : {}),
      ...(action === 'confirm_requirements' ? { research_queries: researchQueries } : {}),
    },
  }
}

/** 向导工具集：一个决策出口 + 三个只读事实工具。 */
export function buildGuideTools(projectId: string, options: GuideToolsOptions): AgentLoopTool[] {
  let decided = false

  const guide_decide: AgentLoopTool = {
    name: 'guide_decide',
    description:
      '提交本轮结构化决策（每轮至多一次，是收敛的唯一出口）。action=ask_clarification 时带 questions（2~4 条互斥具体选项，最后一条固定 auto「你帮我决定」）；action=confirm_requirements 时带 requirements（3~5 条主线闭环功能项，origin 标 user/guide）与 research_queries（≤2 条）；action=generate_sketch 仅在需求已成型时使用。reply 是给用户看的最终话术（≤200 字，口语化）。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'ask_clarification / confirm_requirements / generate_sketch' },
        reply: { type: 'string', description: '给用户的回复话术（简体中文，口语化）' },
        questions: {
          type: 'array',
          description: 'ask_clarification 的可点选选项（reply 问句的候选答案）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string', description: '名词短语 ≤12 字' },
              description: { type: 'string', description: '选它之后会做成什么样 ≤20 字' },
            },
            required: ['id', 'label'],
          },
        },
        requirements: {
          type: 'array',
          description: 'confirm_requirements / generate_sketch 的功能项清单',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '小写字母+连字符，如 daily-tool' },
              description: { type: 'string', description: '动词开头 ≤40 字' },
              origin: { type: 'string', description: 'user=用户原话；guide=你补充' },
            },
            required: ['id', 'description'],
          },
        },
        research_queries: {
          type: 'array',
          description: 'confirm_requirements 的市调检索词（≤2 条，产品形态+功能名词）',
          items: { type: 'string' },
        },
      },
      required: ['action', 'reply'],
    },
    execute: async (toolInput) => {
      if (decided) {
        return { output: '本轮已提交过决策，不要重复调用；等待用户回应即可。', isError: true }
      }
      const validated = validateDecision(toolInput)
      if (!validated.ok) return { output: `决策参数不合法：${validated.error}请修正后重新提交。`, isError: true }
      decided = true
      options.onDecide(validated.decision)
      const summary =
        validated.decision.action === 'ask_clarification'
          ? `已提交澄清问题（${validated.decision.questions?.length ?? 0} 个选项）`
          : validated.decision.action === 'confirm_requirements'
            ? `已提交需求清单（${validated.decision.requirements?.length ?? 0} 条）待用户确认`
            : '已提交开工决策（PRD 确认门兜底）'
      return { output: summary, detail: { action: validated.decision.action } }
    },
  }

  const read_prd_backplane: AgentLoopTool = {
    name: 'read_prd_backplane',
    parallelSafe: true,
    description: '读取本项目的 PRD 背板摘要（功能项/断言数/接口契约）。需求尚未收敛时返回「尚未生成」。',
    input_schema: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const backplane = readPrdBackplane(projectId)
        if (!backplane) return { output: '尚未生成 PRD（需求还在澄清阶段）。' }
        const requirements = (backplane.requirements ?? []).map((item) => {
          const assertions = Array.isArray((item as unknown as { assertions?: unknown[] }).assertions) ? ((item as unknown as { assertions?: unknown[] }).assertions ?? []).length : 0
          return `- [${item.id}] ${item.description}${assertions ? `（断言 ${assertions} 条）` : ''}`
        })
        const spec = (backplane.interface_spec ?? []).map((ep) => `- ${ep.method ?? 'GET'} ${ep.endpoint}`).join('\n')
        return {
          output:
            `PRD 背板（${requirements.length} 条功能项）：\n${requirements.join('\n') || '（空）'}` +
            (spec ? `\n接口契约：\n${spec}` : '\n接口契约：无（纯前端形态）'),
        }
      } catch {
        return { output: 'PRD 背板读取失败（项目可能尚未初始化）。', isError: true }
      }
    },
  }

  const read_test_report: AgentLoopTool = {
    name: 'read_test_report',
    parallelSafe: true,
    description: '读取最近一次终验测试报告摘要（通过/失败计数与失败清单前 5 条）。尚未生成时如实返回。',
    input_schema: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const project = findProject(projectId)
        const path = join(getDocumentsDir(project.workspace_slug, projectId), 'test-report.json')
        if (!existsSync(path)) return { output: '尚未生成测试报告（项目还没有跑过终验）。' }
        const report = JSON.parse(readFileSync(path, 'utf-8')) as {
          total_count?: number
          passed_count?: number
          failed_count?: number
          failure_summary?: Array<{ scenario?: string; reason?: string }>
        }
        const failures = (report.failure_summary ?? []).slice(0, 5).map((f) => `- ${f.scenario ?? '?'}：${(f.reason ?? '').slice(0, 80)}`)
        return {
          output:
            `最近测试报告：共 ${report.total_count ?? 0} 项，通过 ${report.passed_count ?? 0}，失败 ${report.failed_count ?? 0}。` +
            (failures.length ? `\n失败清单：\n${failures.join('\n')}` : ''),
        }
      } catch {
        return { output: '测试报告读取失败。', isError: true }
      }
    },
  }

  const list_project_files: AgentLoopTool = {
    name: 'list_project_files',
    parallelSafe: true,
    description: '列出项目产物文件清单（相对路径，≤100 条；跳过归档/依赖/构建产物目录）。',
    input_schema: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const project = findProject(projectId)
        const files: string[] = []
        const visit = (dir: string, rel: string, depth: number): void => {
          if (files.length >= 100 || depth > 4) return
          let entries: Array<{ name: string; isDirectory: () => boolean }>
          try {
            entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean }>
          } catch {
            return
          }
          for (const entry of entries) {
            if (files.length >= 100) return
            const childRel = rel ? `${rel}/${entry.name}` : entry.name
            if (entry.isDirectory()) {
              if (SKIP_DIRS.has(entry.name)) continue
              visit(join(dir, entry.name), childRel, depth + 1)
            } else {
              files.push(childRel)
            }
          }
        }
        visit(project.root_path, '', 0)
        return { output: files.length ? `项目文件（${files.length} 个）：\n${files.join('\n')}` : '项目目录为空。' }
      } catch {
        return { output: '项目文件清单读取失败。', isError: true }
      }
    },
  }

  return [guide_decide, read_prd_backplane, read_test_report, list_project_files]
}

const SKIP_DIRS = new Set(['archive', 'node_modules', 'dist', '.git', 'documents'])
