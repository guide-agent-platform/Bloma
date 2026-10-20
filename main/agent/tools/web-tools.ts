/**
 * Web 工具族（PR4d 自 agent-tools 拆出）：web_fetch（公网守卫抓取+预览同源放行）与
 * web_research（fork 调研子代理+超时兜底）。纯机械搬移；角色裁剪由调用方装配。
 */
import type { AgentLoopTool } from '../loop/agent-loop'
import { withAbort } from '../loop/agent-loop';
import {
  assertPublicHttpUrl,
  htmlToText,
  NET_FETCH_DEFAULT_CHARS,
  NET_FETCH_MAX_BYTES,
  NET_FETCH_MAX_CHARS_LIMIT,
  NET_FETCH_TIMEOUT_MS,
} from '../../platform/net/net-guard'
import { startDelegation, stopDelegation, waitForDelegations, type StartDelegationResult } from '../delegation/agent-collaboration'
import { numberOr, WEB_RESEARCH_MAX_CHARS } from './agent-tools'


export const WEB_RESEARCH_TIMEOUT_MS = 90_000
let webResearchTimeoutMs = WEB_RESEARCH_TIMEOUT_MS

/** 测试 seam：缩短 web_research 等待上限（超时/取消用例不等真实 90s）。 */
export function setWebResearchTimeoutForTests(ms: number): void {
  webResearchTimeoutMs = ms
}

export function buildWebFetch(): AgentLoopTool {

  const web_fetch: AgentLoopTool = {
    name: 'web_fetch',
    parallelSafe: true,
    description:
      '抓取公网网页/文档并转为纯文本（只查资料，不能修改任何东西）。参数：url（http/https 公网地址）、max_chars（返回文本上限，默认 12000，最大 50000）。内网/本机地址会被拒绝；例外：与当前预览地址同源的 URL 放行（可用于自查 /api 端点与页面实况）。HTML 只保留可见文本。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的公网 http/https 地址' },
        max_chars: { type: 'number', description: '返回文本字符上限（默认 12000）' },
      },
      required: ['url'],
    },
    execute: async (toolInput, ctx) => {
      if (typeof toolInput.url !== 'string' || !toolInput.url.trim()) {
        return { output: '缺少 url 参数。', isError: true }
      }
      const rawUrl = toolInput.url.trim()
      // W3：预览 origin 放行（真实脚手架产物需要能探自己的 /api 与健康端点；仅限当前
      // 预览 origin——run_preview 已把地址放进 state；外域照走公网守卫不变）
      let previewOrigin: string | null = null
      try {
        previewOrigin = ctx.state.preview_url ? new URL(ctx.state.preview_url).origin : null
      } catch {
        previewOrigin = null
      }
      let localUrl: URL | null = null
      if (previewOrigin) {
        try {
          const candidate = new URL(rawUrl)
          if (candidate.origin === previewOrigin) localUrl = candidate
        } catch {
          /* 非法 URL 落回公网守卫拿规范报错 */
        }
      }
      const guarded = localUrl ? { ok: true as const, url: localUrl } : assertPublicHttpUrl(rawUrl)
      if (!guarded.ok) return { output: guarded.error, isError: true }
      const maxChars = Math.min(
        Math.max(Math.trunc(numberOr(toolInput.max_chars, NET_FETCH_DEFAULT_CHARS)), 500),
        NET_FETCH_MAX_CHARS_LIMIT,
      )
      let response: Response
      try {
        response = await fetch(guarded.url, {
          signal: AbortSignal.timeout(NET_FETCH_TIMEOUT_MS),
          redirect: 'follow',
          headers: { accept: 'text/html,application/json,text/plain,*/*' },
        })
      } catch (error) {
        return {
          output: `抓取失败（${guarded.url.hostname}）：${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        }
      }
      // 重定向终态复检：防公网 302 跳内网（redirect:'follow' 后 response.url 为终态）；
      // W3 补丁（2026-09-18 21:07 狗粮实锤）：预览 origin 内的响应（含同源重定向）放行——
      // 上批只改了初审，终态仍把 localhost 同源响应当「重定向到不允许的地址」拒掉，
      // 修复轮自查通路全断（模型只能读文件打转→noop→熔断白修）
      const finalRaw = response.url || guarded.url.toString()
      let finalOk: boolean
      if (previewOrigin) {
        try {
          finalOk = new URL(finalRaw).origin === previewOrigin
        } catch {
          finalOk = false
        }
        if (!finalOk) finalOk = assertPublicHttpUrl(finalRaw).ok
      } else {
        finalOk = assertPublicHttpUrl(finalRaw).ok
      }
      if (!finalOk) {
        return { output: `重定向到了不允许的地址（${response.url}），已拒绝。`, isError: true }
      }
      if (!response.ok) {
        return { output: `目标返回 HTTP ${response.status}（${guarded.url.hostname}），未抓取正文。`, isError: true }
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!/text\/|json|xml|javascript/i.test(contentType)) {
        return { output: `不支持的响应类型（content-type: ${contentType || '未知'}），只支持文本类内容。`, isError: true }
      }
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > NET_FETCH_MAX_BYTES) {
        return { output: `响应过大（${buffer.byteLength} 字节 > 上限 ${NET_FETCH_MAX_BYTES}），已放弃。`, isError: true }
      }
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
      const text = /html/i.test(contentType) ? htmlToText(raw) : raw
      if (!text.trim()) return { output: `抓取成功但页面无可提取文本（${response.url}）。` }
      const truncated = text.length > maxChars
      const body = truncated
        ? `${text.slice(0, maxChars)}\n…（已截断，原文 ${text.length} 字符，可用 max_chars 调大上限重试）`
        : text
      return {
        output: `（${response.url} · HTTP ${response.status} · ${contentType.split(';')[0]}）\n${body}`,
        detail: { url: response.url, status: response.status, chars: text.length, truncated },
      }
    },
  }
  return web_fetch
}

export function buildWebResearch(projectId: string): AgentLoopTool {
  const web_research: AgentLoopTool = {
    name: 'web_research',
    parallelSafe: true,
    description:
      '针对一个问题或一个 URL 派出只读调研子代理：抓取/检索后总结成精干结论返回（≤4000 字），' +
      '不占用当前上下文。适合查文档、找方案、比对做法；只需抓单页原文时用 web_fetch。' +
      '参数：question（要查清的问题，或直接给 URL）、focus（关注点，可选）。',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要查清的问题或目标 URL' },
        focus: { type: 'string', description: '重点关注哪方面（可选）' },
      },
      required: ['question'],
    },
    execute: async (toolInput, ctx) => {
      const question = String(toolInput.question ?? '').trim()
      if (!question) return { output: '缺少 question 参数。', isError: true }
      const focus = typeof toolInput.focus === 'string' && toolInput.focus.trim() ? toolInput.focus.trim() : undefined
      let started: StartDelegationResult | undefined
      try {
        started = startDelegation(ctx, {
          task:
            `联网调研并总结（你是只读调研子代理，不能修改任何文件）：\n问题：${question}` +
            `${focus ? `\n重点关注：${focus}` : ''}\n` +
            `要求：用 web_fetch 抓取必要页面后，输出不超过 2000 字的中文结论（要点+出处 URL），不要贴原文大段。`,
          role: 'research',
          expectedOutput: '≤2000 字中文结论 + 出处 URL',
        })
        // withAbort：主 loop 取消时立即解除等待（waitForDelegations 本体不监听外部
        // signal，见 abb1a19f 缺陷①的同类问题）；孤儿清理由 runMvpViaAgentLoop 的
        // finally disposeParentDelegationState 兑底。
        const summaries = await withAbort(
          waitForDelegations(ctx, { strategy: 'all', delegationIds: [started.delegation_id], timeout_ms: webResearchTimeoutMs }),
          ctx.signal,
        )
        const summary = summaries[0]
        if (!summary || summary.status === 'running') {
          stopDelegation(ctx.sessionId, started.delegation_id)
          // 子代理冒泡提问（审查 P1-3）：waitForDelegations 对 askSignal 提前返回，这不是超时；
          // 如实转述问题并建议改路，不得谎报「未收敛」击杀有进展的子代理
          if (summary?.pending_question) {
            return {
              output: `调研子代理中途需要澄清问题：「${summary.pending_question.slice(0, 200)}」。这类问题不适合委派调研：可把 question 拆得更具体后重试，或改用 web_fetch 直接抓取。`,
              isError: true,
            }
          }
          return {
            output: `调研子代理 ${Math.round(webResearchTimeoutMs / 1000)}s 内未收敛，已停止。请基于已有信息继续，或缩小问题后重试。`,
            isError: true,
          }
        }
        if (summary.status !== 'completed' || !summary.result_summary) {
          return { output: `调研子代理未成功（status=${summary.status}）。可改用 web_fetch 直接抓取。`, isError: true }
        }
        // 剥「子代理状态：」头行（同 review-delegation），内部运行指标不进模型上下文
        const body = summary.result_summary.split('\n').slice(1).join('\n').trim()
        // 空结论显式化（审查 P2-3）：完成但无产出不能假装成功，给重试/替代建议
        if (!body) {
          return { output: '调研子代理完成了任务但没有产出结论（可能空响应）。可重试一次，或改用 web_fetch 直接抓取。', isError: true }
        }
        return { output: `调研结论：\n${body.slice(0, WEB_RESEARCH_MAX_CHARS)}`, detail: { delegation_id: started.delegation_id } }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (ctx.signal.aborted || message.includes('AGENT_CANCELLED')) {
          return { output: `调研等待已随主任务取消中止（委派 ${started?.delegation_id ?? '未知'}，由平台收尾停止）。`, isError: true }
        }
        return { output: `调研委派失败：${message}。可改用 web_fetch 直接抓取。`, isError: true }
      }
    },
  }
  return web_research
}
