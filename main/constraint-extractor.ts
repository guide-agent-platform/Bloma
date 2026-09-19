import { existsSync, readFileSync } from 'node:fs'
import type { AgentMessage } from '../shared/types'
import { getAgentSessionPath } from '../storage/config-paths'
import { addConstraints, findProject } from './project-service'
import { recordDecision } from './decision-log'

/**
 * 用户约束的确定性提取（长期型改造 T4-L1/L2 主路，2026-08-18 修订版设计）。
 *
 * 「不含登录」「必须离线可用」这类约束是长期性的根——它必须在第 1 轮说过、第 30 轮
 * 依然生效。靠 LLM 记忆不可靠（窗口截断/采样漂移），靠蒸馏是第二份事实源（与密背板
 * 冗余，OMO 作者的教训）。所以主路是确定性的两层：
 *
 * - L1 写入侧：澄清门（guide）/修改归一化门（normalizer 调用方）识别约束语句 →
 *   持久化 project.constraints → 随 PRD 背板常驻注入生成/判定/意图分流；
 * - L2 读取侧：每次消息对会话 JSONL 全量做关键词级扫描，历史约束回灌上下文
 *   （并对漏网的约束回填 project.constraints）。
 *
 * 本模块是纯函数叶子（fs 只读会话 JSONL），不依赖 LLM——验收核心场景
 * 「首轮约束 >30 轮仍生效」在此层不依赖模型即结构性达成。
 */

/** 约束标记词（关键词级，宁收短语不整句）：排除类 + 要求类。 */
const CONSTRAINT_MARKER_RE =
  /(不含|不包括|不涉及|不需要|无需|不要|不想要|不用|禁止|不得|不能有|不要有|别做|别加|别用|必须|务必|一定要|只能)/

/** 子句切分：标点与换行。约束语句几乎总是一个独立短句。 */
const CLAUSE_SPLIT_RE = /[，。；！？、,;!?\n]+/

/** 单条约束语句上限：约束是短语不是段落，超长说明命中了叙述句，截断保真。 */
const CONSTRAINT_MAX_LENGTH = 60
/** 单次提取条数上限：一条消息里 5 条以上「约束」几乎必然是误报。 */
const CONSTRAINT_MAX_PER_TEXT = 5;

/**
 * 从一段自然语言提取约束语句（原话短语，不转写——转写是 LLM 的事，这里只认证据）。
 * 返回去重后的子句列表；无约束返回空数组。
 */
/**
 * 读取项目已持久化的用户约束（T4-L1 读取侧）：项目索引缺失（测试字面 id 等）
 * 返回空数组——读取侧永不抛错，不因约束读取把调用方打回降级分支。
 */
export function readProjectConstraints(projectId: string): string[] {
  try {
    // R0.4：读取侧兑底清洗存量污染（写入侧已根治；存量项目如 7601e5ae 背板仍有注入残留）
    return sanitizeConstraints(findProject(projectId).constraints ?? [])
  } catch {
    return []
  }
}

export function extractConstraints(text: string): string[] {
  const found: string[] = []
  for (const clause of text.split(CLAUSE_SPLIT_RE)) {
    const trimmed = clause.replace(/\s+/g, ' ').trim()
    if (!trimmed || trimmed.length > CONSTRAINT_MAX_LENGTH) continue
    if (!CONSTRAINT_MARKER_RE.test(trimmed)) continue
    if (!found.includes(trimmed)) found.push(trimmed)
    if (found.length >= CONSTRAINT_MAX_PER_TEXT) break
  }
  return found
}

/**
 * 全量扫描会话 JSONL 中的用户约束（T4-L2 读取侧）。
 *
 * 输入是**全量** JSONL（limit 只是别处的读取窗口，不是事实的截断）：第 1 轮说的约束
 * 在第 30 轮之后仍要被扫出来。只认 user 角色——assistant 的转述不算用户声明。
 * 消息按文件序（时间序）处理，早轮约束排前面。
 */

/** 平台合成 user 轮拦截（R0.4 根治版，2026-09-19 狗粮 7601e5ae 实锤）：旧版两点前缀
 *  黑名单追不上注入面扩张——本轮「收口指令/任务书工作方式/进度对账」等宿主注入文本
 *  全被确定性提取为「用户约束」永久入库（含「无需再读取或修改任何文件——请直接输出
 *  完成总结」，每轮常驻注入=教模型别读文件直接交卷）。改为两类结构性信号：
 *  ①开头前缀黑名单（平台注入轮均有固定开头：任务卡/任务书/循环目标/learnings 注入）；
 *  ②全文含「（宿主注入）」标记即整轮丢弃（所有【XXX（宿主注入）】类标记的统一信号）。
 *  用户真实输入不含这些开头与标记——白名单语义的确定性拦截。 */
const SYNTHETIC_USER_TURN_PREFIXES = [
  '## 修复任务',
  '【传输事故反馈】',
  '目标：',
  '<untrusted-memory',
  '【收口指令',
  '【进度对账',
  '【任务清单工作流',
  '【修改模式】',
  '【本轮任务】',
  '【工作方式】',
  // R0.4 补丁（2026-09-19 狗粮 a602709f）：审查答题回写轮是 UI 选项回显不是用户
  // 原话——其中的选项描述碎片（「做的人只能自己猜」「要不要拦」）被提取成约束入库
  '我选好了，',
  '补充说明：',
]
const HOST_INJECTION_MARKER = '（宿主注入）'

/** 历史污染指纹（R0.4 消费端防御性清洗）：狗粮实锤入库的宿主注入话术原文片段。
 *  只列确定性指纹（宁漏勿误：疑似但不确定的知「无需登录配置」不入列——用户真会说）。 */
const HOST_CONSTRAINT_FINGERPRINTS = [
  '（宿主注入）',
  '无需再读取或修改任何文件',
  '禁止先全读再全写',
  '读过的内容不要重读',
  '不要整文件重写（已完成清单项勿重做）',
  '若确已不需要请在旁白说明原因',
  '三项硬约束',
  '禁止重构与本轮修复无关的代码',
  '不要把验证全部留到收尾',
  '不要动其他任何文件',
  '不要改动其他任何文件',
  '完成总结：逐项说明已完成的实施清单项',
]

/** 约束列表防御性清洗：剔除命中毒词指纹的宿主注入残留（写入侧已根治，此处兑底
 *  存量污染——读取/注入两侧共用，不带状态、幂等）。 */
export function sanitizeConstraints(constraints: string[] | undefined | null): string[] {
  if (!constraints || constraints.length === 0) return []
  return constraints.filter(
    (entry) => typeof entry === 'string' && !HOST_CONSTRAINT_FINGERPRINTS.some((fp) => entry.includes(fp)),
  )
}

export function scanSessionConstraints(sessionId: string): string[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  const constraints: string[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let message: AgentMessage
    try {
      message = JSON.parse(line) as AgentMessage
    } catch {
      continue
    }
    if (message.role !== 'user') continue
    const text = (message.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    if (SYNTHETIC_USER_TURN_PREFIXES.some((prefix) => text.trimStart().startsWith(prefix))) continue
    if (text.includes(HOST_INJECTION_MARKER)) continue
    for (const constraint of extractConstraints(text)) {
      if (!constraints.includes(constraint)) constraints.push(constraint)
    }
  }
  return constraints
}

/**
 * 约束走门（T4-L1 写入侧统一入口）：提取出的约束持久化 project.constraints，
 * 确有新增时落 T2 决策日志。供三个门复用——澄清门（guide_gate）、修改门
 * （sketch_ready_modification / iteration_modification）、L2 全量扫描回填
 * （session_scan）。项目索引缺失（测试字面 id）时静默跳过落库，不卡主流程。
 * 返回实际新增的约束（供调用方判断是否需要额外动作）。
 */
export function captureConstraints(opts: {
  project_id: string
  session_id: string
  /** 已提取的约束语句（调用方经 extractConstraints 得到） */
  constraints: string[]
  /** 入库点标记：guide_gate / sketch_ready_modification / iteration_modification / session_scan */
  source: string
}): string[] {
  if (opts.constraints.length === 0) return []
  let added: string[]
  try {
    added = addConstraints(opts.project_id, opts.constraints)
  } catch {
    // 项目索引缺失等：本轮约束仍可经读取侧注入，不因落库失败卡主流程
    return []
  }
  if (added.length > 0) {
    recordDecision({
      project_id: opts.project_id,
      session_id: opts.session_id,
      entry: {
        type: 'constraint_captured',
        title: '捕获用户约束',
        why: `约束语句确定性入库（随 PRD 背板常驻注入，历轮生效）：${added.join('；')}`,
        detail: { constraints: added, source: opts.source },
      },
    })
  }
  return added
}
