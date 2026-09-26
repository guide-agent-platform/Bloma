/**
 * 能力档案（2026-09-26 运行审计 P1-08：总体能力承诺、品类能力和工具注册分别手写）。
 *
 * 审计点名的三处矛盾（loop-prompt）：
 * 1. 九条纪律要求按实际架构实现、非 Web 产品不得降为网页模拟，同一 system 却无条件
 *    固定「入口 index.html / src/app.js / styles.css」；
 * 2. 前段允许静态项目本地存储，后段对非游戏数据留存一律要求后端并禁止 localStorage
 *    （豁免集合与品类判定源不一致）；
 * 3. 并行协作段统一声称「子会话拥有同一项目的完整读写与验证工具」，实际工具面按角色
 *    裁剪（explore/research 只读、review 无写入）。
 *
 * 本模块是这三处的**单一真相源**：目标平台 / 产物形态 / 数据策略 / 角色能力事实。
 * 提示词段由它生成；角色能力事实与工具注册面有机器校验（capability-profile.test.ts）。
 */

import type { TemplateType } from '../../shared/types'

/** 目标平台（产物形态与验证 driver 的提纲）。 */
export type ProductPlatform =
  | 'web-static' // 纯前端静态（无构建步骤）
  | 'web-modular' // 工程骨架 + 构建门禁（模块化解禁）
  | 'web-fullstack' // 前后端分离（服务端 + 数据）
  | 'local-first' // 本地工具（localStorage 一等）
  | 'game-local' // 街机/小游戏（本地轻留存）
  | 'ai-local' // AI 应用（本地 + 同源 /api/llm）
  | 'desktop' // 桌面形态（驱动契约产物）

/** 数据策略（与「留存信号词是否催生后端」判定同源）。 */
export type DataPolicy = 'local-first-ok' | 'server-required'

/**
 * 本地优先品类集合——**必须与 prd-backplane.LOCAL_FIRST_TYPES 同源**；
 * 一致性测试锁定两边集合相等（防两处手写漂移，审计根因即「分别手写」）。
 */
export const LOCAL_FIRST_TEMPLATE_TYPES: ReadonlySet<string> = new Set(['personal_tool', 'desktop_tool', 'game', 'ai_app'])

export interface CapabilityProfile {
  templateType: TemplateType
  platform: ProductPlatform
  dataPolicy: DataPolicy
}

/**
 * 解析能力档案。`persistenceExempt` 由判定的单一源给出（prd-backplane 的
 * localFirstPersistenceExempt：本地优先品类 ∧ 无强后端信号）——此处不重复实现判定。
 */
export function resolveCapabilityProfile(input: {
  templateType: TemplateType
  /** 工程骨架存在（带构建门禁） */
  skeletonMap?: string | null
  /** 前后端分离渠道（real-fullstack） */
  realFullstack?: boolean
  /** 留存豁免（单一源判定结果） */
  persistenceExempt?: boolean
}): CapabilityProfile {
  const t = input.templateType
  // 判定顺序（P1-08 修正）：构建能力优先于品类措辞——有工程骨架即解禁模块化
  //（数据策略由 dataPolicy 独立给出，本地优先品类 + 骨架 = 模块化 + localStorage 一等，不矛盾）；
  // 无骨架才按品类给产物形态措辞（桌面形态/小游戏/AI 应用/本地工具/纯静态）。
  const platform: ProductPlatform =
    input.realFullstack === true
      ? 'web-fullstack'
      : input.skeletonMap
        ? 'web-modular'
        : t === 'desktop_tool'
          ? 'desktop'
          : t === 'game'
            ? 'game-local'
            : t === 'ai_app'
              ? 'ai-local'
              : t === 'personal_tool'
                ? 'local-first'
                : 'web-static'
  // 数据策略：豁免（本地优先品类且无强后端信号）→ 本地存储一等；否则后端持久化。
  // desktop 品类当前无网页产物形态，仍按 server-required 口径兜底（不鼓励本地糊）。
  const dataPolicy: DataPolicy = input.persistenceExempt === true ? 'local-first-ok' : 'server-required'
  return { templateType: t, platform, dataPolicy }
}

/** 产物形态段（替代 loop-prompt 的无条件固定入口文案）。 */
export function renderProductShapeSection(profile: CapabilityProfile): string {
  switch (profile.platform) {
    case 'web-modular':
      return (
        '【产物形态】入口 index.html，交互逻辑入口 src/app.js，样式 src/styles.css；' +
        '模块化优先：按技术合同的目标文件拆分为 src/ 下多个 .js 文件用 import 组织（loop 结束后构建门禁' +
        '会打包校验模块图，import 路径错误会在构建期暴露）；仅当功能极简单、单文件已足够时才可合并，且须在旁白说明合并原因。' +
        '预览沙箱直接加载源码，前端禁止直连外网。'
      )
    case 'web-fullstack':
      return (
        '【产物形态】前后端分离：前端入口 index.html + src/app.js/styles.css（模块化组织，构建门禁打包校验）；' +
        '服务端按技术合同落 server/（路由 + ctx.readData/writeData 数据落 data/），构建产物 dist/。' +
        '本地存储不得承载业务数据（走服务端持久化）。预览沙箱直接加载源码，前端禁止直连外网。'
      )
    case 'local-first':
    case 'game-local':
    case 'ai-local':
      return (
        '【产物形态】入口 index.html，静态前端产物（平台用静态服务器托管，无构建步骤）；' +
        '交互逻辑放 src/app.js，样式放 src/styles.css；数据留存走本地持久化（localStorage）为合法一等实现。' +
        (profile.platform === 'game-local' ? '游戏产物可暴露 window.__g 状态通道（探针读游戏状态判定位移等断言）。' : '') +
        '不使用 import/ESM 模块语法。'
      )
    case 'desktop':
      return (
        '【产物形态】桌面形态产物：按技术合同落盘（如 app.py 与驱动契约 contract.json），入口不是 index.html——' +
        '不要为方便预览把桌面产品做成网页模拟。若当前运行时不具备桌面驱动验证能力，如实上报阻塞（交付纪律第 9 条），' +
        '不得静默降格为局部 Web 修改。'
      )
    case 'web-static':
    default:
      return (
        '【产物形态】入口 index.html，纯前端静态产物（平台用静态服务器托管，无构建步骤）；' +
        '交互逻辑放 src/app.js，样式放 src/styles.css；不使用 import/ESM 模块语法。'
      )
  }
}

/** 数据留存条款（替代 loop-prompt 里与品类判定源不一致的三态分支）。 */
export function renderDataPolicyClause(profile: CapabilityProfile): string {
  if (profile.dataPolicy === 'local-first-ok') {
    return (
      '数据留存类需求（保存/历史/记录/收藏/刷新或重开后仍在）以本地持久化（localStorage）为合法一等实现；' +
      '仅当需求明确要求跨端/多端同步/云端共享（强后端信号）时才落后端 server/routes/ + ctx.readData/writeData 落 data/ 目录；'
    )
  }
  if (profile.platform === 'web-fullstack') {
    return (
      '数据留存类需求（保存/历史/记录/收藏/刷新或重开后仍在）一律用后端持久化：server/routes/ 路由 + ctx.readData/writeData 落 data/ 目录，' +
      '禁止 localStorage/sessionStorage 存业务数据——PRD 说「刷新后仍在」不构成 localStorage 例外的理由，后端持久化同样满足且必须用后者；'
    )
  }
  return (
    '数据留存类需求（保存/历史/记录/收藏/刷新或重开后仍在）一律用后端持久化：server/routes/ 路由 + ctx.readData/writeData 落 data/ 目录，' +
    '禁止 localStorage/sessionStorage 存业务数据——PRD 说「刷新后仍在」不构成 localStorage 例外的理由，后端持久化同样满足且必须用后者；'
  )
}

/**
 * 并行协作段的能力描述——**如实**（子会话工具面按角色裁剪，见 DELEGATE_ROLE_FACTS
 * 与工具注册面的一致性测试）。旧口径统一声称「完整读写与验证工具」，对
 * explore/research/review 不成立（审计原文）。
 */
export const DELEGATE_CAPABILITY_LINE =
  '（子会话按角色裁剪工具面：implement/custom 子角色有完整读写与验证工具、产出直接落项目目录；' +
  'explore/research 子角色只读（探索/调研）；review 子角色只读且不改产物（审查）——按任务性质选角色）'

/** 角色能力事实（与 buildAgentTools/buildDomainTools 实际注册面机器校验一致）。 */
export const DELEGATE_ROLE_FACTS: ReadonlyArray<{ role: string; writable: boolean; domainVerification: boolean }> = [
  { role: 'implement/custom', writable: true, domainVerification: true },
  { role: 'review', writable: false, domainVerification: true },
  { role: 'explore/research', writable: false, domainVerification: false },
]
