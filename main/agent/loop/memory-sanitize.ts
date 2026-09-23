/**
 * 记忆注入面统一净化（2026-09-12，记忆栈审计裁定 ②：安全修复，不依赖产品决策）。
 *
 * 背景：三类记忆注入面防护强度曾不一致——跨会话检索有 `< >` 转义、经验卡有
 * self-cert-guard 绕过检测，而**执行经验（learnings）是模型输出逐字进 system prompt、
 * 两侧零防护**。记忆一旦被第三方内容（用户贴的文档/网页/邮件）污染，就是
 * **持久化 prompt injection**：写一次、此后每轮注入。
 *
 * 收敛口径（单一出口，勿在别处散写转义/检测正则）：
 * 1. `escapeMemoryDelimiters` 边界转义：`<`/`>` 全角化 + 控制字符剔除 + 空白归一
 *    ——防伪造闭合标签越界（`</session-recall>`、`</memory>`、`</experience>` 之流）；
 * 2. `containsBypassInstruction` 绕过指令检测：教唆关闭/跳过/绕过受保护门禁的文本
 *    禁止进入注入面（**拦注入不删数据**，与 self-cert-guard 同语义）；
 * 3. `sanitizeForStorage`（转义 + 截断）用于**写入侧**，`sanitizeForInjection`
 *    （转义 + 绕过检测 + 截断）用于**注入侧**——两侧都过，防脏数据入库后被别处消费。
 *
 * 全链静默：任何异常返回安全降级值（注入侧宁可不注入），绝不阻断生成主链路。
 */

/**
 * 教唆绕过受保护面的指令模式（保守窄匹配：动词 + 受保护面组合；**诊断性提及不命中**）。
 * 单一来源：self-cert-guard 的经验卡检测与本模块共用此判定（勿复制到别处）。
 * 例命中：「关闭 typecheck 让构建通过」「跳过 judge 门禁」「绕过安全扫描」。
 * 例不命中：「typecheck 失败导致构建中断」「GWT 断言未过」（无教唆动词）。
 */
const BYPASS_INSTRUCTION_RE =
  /(关闭|跳过|绕过|禁用|注释掉|删掉|去掉|mock\s*掉)[^。\n;；]{0,24}(typecheck|构建门禁|build\s*gate|judge|裁判|门禁|断言|gwt|探针|安全扫描|security|api\s*contract|契约探测)/i

/** 控制字符（C0/C1 中无显示意义者）——连同 DEL 一并剔除。 */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export interface SanitizeOptions {
  /** 截断上限（字符）；缺省不截断。 */
  limit?: number
}

export interface InjectionSanitizeResult {
  /** 净化后的可注入文本；blocked 为 true 时是空串。 */
  text: string
  /** true = 命中绕过指令、禁止注入（拦注入不删原始数据）。 */
  blocked: boolean
}

/**
 * 边界转义（注入/存储共用底座）：控制字符剔除 → `<`/`>` 全角化 → 空白归一。
 * 幂等：已转义文本再次调用结果不变（全角字符不在替换集内）。
 */
export function escapeMemoryDelimiters(text: string): string {
  return String(text ?? '')
    .replace(CONTROL_CHARS_RE, '')
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 文本是否教唆绕过受保护面。检测自身失败一律**视为命中**（fail-safe：
 * 少注入一条经验的代价，远小于门禁被教唆绕过的代价）。
 */
export function containsBypassInstruction(text: string): boolean {
  try {
    return BYPASS_INSTRUCTION_RE.test(String(text ?? ''))
  } catch {
    return true
  }
}

/** 写入侧净化：转义 + 截断（不做绕过检测——数据可留，注入时再拦）。 */
export function sanitizeForStorage(text: string, opts: SanitizeOptions = {}): string {
  const escaped = escapeMemoryDelimiters(text)
  return typeof opts.limit === 'number' ? escaped.slice(0, opts.limit) : escaped
}

/**
 * 注入侧净化：转义 → 截断 → 绕过检测。命中绕过指令返回 `{ text: '', blocked: true }`
 * （调用方跳过该条，**不删除**原始数据）；净化自身异常同样返回 blocked（fail-safe）。
 */
export function sanitizeForInjection(text: string, opts: SanitizeOptions = {}): InjectionSanitizeResult {
  try {
    const escaped = escapeMemoryDelimiters(text)
    const limited = typeof opts.limit === 'number' ? escaped.slice(0, opts.limit) : escaped
    if (containsBypassInstruction(limited)) return { text: '', blocked: true }
    return { text: limited, blocked: false }
  } catch {
    return { text: '', blocked: true }
  }
}
