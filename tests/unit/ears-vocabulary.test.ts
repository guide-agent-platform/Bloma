import { describe, expect, it } from 'vitest'
import {
  deriveGwtSkeleton,
  hasForbiddenResponse,
  isCompoundTrigger,
  matchResponseAssertion,
  matchTriggerAction,
  parseEarsAssertion,
  renderForbiddenTermsForPrompt,
  renderResponseVocabularyForPrompt,
  renderTriggerVocabularyForPrompt,
  RESPONSE_FORBIDDEN_TERMS,
} from '../../main/guide/ears-vocabulary'
import { parseBehaviorAssertion } from '../../main/verification/behavior-assertions'

describe('ears-vocabulary（P1：词表单点模块）', () => {
  describe('parseEarsAssertion：句式解析', () => {
    it('WHEN 前缀 + 中轴 → when 句式，两侧内容提取', () => {
      const parsed = parseEarsAssertion('WHEN 点击保存按钮 → 列表新增一条记录')
      expect(parsed.kind).toBe('when')
      expect(parsed.trigger).toBe('点击保存按钮')
      expect(parsed.response).toBe('列表新增一条记录')
      expect(parsed.wellFormed).toBe(true)
      expect(parsed.compoundTrigger).toBe(false)
      expect(parsed.forbiddenResponse).toBe(false)
    })

    it('中文前缀「当/如果/当处于」同样识别', () => {
      expect(parseEarsAssertion('当 点击开始 → 计时启动').kind).toBe('when')
      expect(parseEarsAssertion('IF 输入负数 → 提示金额无效').kind).toBe('if')
      expect(parseEarsAssertion('处于 列表为空 → 显示空状态提示').kind).toBe('while')
    })

    it('WHILE 先于 WHEN 匹配（防「当处于」被「当」截走）', () => {
      const parsed = parseEarsAssertion('WHILE 列表为空 → 显示「暂无记录」')
      expect(parsed.kind).toBe('while')
      expect(parsed.trigger).toBe('列表为空')
    })

    it('无前缀存量断言 → when（现状语义兼容，零迁移）', () => {
      const parsed = parseEarsAssertion('点击保存按钮→列表新增一条记录')
      expect(parsed.kind).toBe('when')
      expect(parsed.wellFormed).toBe(true)
    })

    it('无中轴的断言 → 非良构（wellFormed=false，走 presenceFallback 由调用方兜底）', () => {
      const parsed = parseEarsAssertion('该功能项在产物中可见且可交互')
      expect(parsed.wellFormed).toBe(false)
      expect(parsed.trigger).toBeUndefined()
    })

    it('既有中轴家族（之后就/时/后）同样良构', () => {
      expect(parseEarsAssertion('按右方向键时车辆 x 坐标增加').wellFormed).toBe(true)
    })
  })

  describe('单 trigger 纪律（Mavin 消歧 + Cucumber 单 When）', () => {
    it('两类触发动词并存 → 复合违规', () => {
      expect(isCompoundTrigger('点击保存按钮并输入备注')).toBe(true)
      expect(isCompoundTrigger('输入金额后点击提交')).toBe(true)
    })

    it('显式并列连接词（并且/然后/同时）→ 复合违规', () => {
      expect(isCompoundTrigger('点击开始然后点击暂停')).toBe(true)
      expect(isCompoundTrigger('点击甲和乙')).toBe(false) // 单类动词+「和」字不孤立判复合（「总和」误伤防护）
    })

    it('单一动作不违规', () => {
      expect(isCompoundTrigger('点击保存按钮')).toBe(false)
      expect(isCompoundTrigger('按右方向键')).toBe(false)
      expect(isCompoundTrigger('输入书名')).toBe(false)
    })

    it('解析结果携带 compoundTrigger 标记', () => {
      const parsed = parseEarsAssertion('WHEN 点击保存并点击取消 → 列表不变')
      expect(parsed.compoundTrigger).toBe(true)
    })
  })

  describe('response 禁词表（内审 EARS 可测性维度直查）', () => {
    it('禁词命中', () => {
      expect(hasForbiddenResponse('系统优雅处理异常')).toBe(true)
      expect(hasForbiddenResponse('给出合理的结果')).toBe(true)
      expect(hasForbiddenResponse('界面友好')).toBe(true)
      expect(hasForbiddenResponse('尽量保持布局')).toBe(true)
    })

    it('可测措辞不命中', () => {
      expect(hasForbiddenResponse('显示「保存成功」提示')).toBe(false)
      expect(hasForbiddenResponse('列表新增一条记录')).toBe(false)
      expect(hasForbiddenResponse('按钮禁用')).toBe(false)
    })

    it('解析结果携带 forbiddenResponse 标记', () => {
      expect(parseEarsAssertion('IF 输入超长文本 → 系统优雅处理').forbiddenResponse).toBe(true)
    })

    it('禁词表覆盖方案 §4.2 指定词', () => {
      for (const term of ['优雅处理', '合理', '正确地', '友好', '尽量', '适当']) {
        expect(RESPONSE_FORBIDDEN_TERMS).toContain(term)
      }
    })
  })

  describe('词表匹配（GWT 派生路由）', () => {
    it('trigger 词表命中 Playwright 动作', () => {
      expect(matchTriggerAction('点击保存按钮')?.playwrightAction).toBe('click')
      expect(matchTriggerAction('输入书名')?.playwrightAction).toBe('fill')
      expect(matchTriggerAction('上传头像')?.playwrightAction).toBe('setInputFiles')
      expect(matchTriggerAction('按右方向键')?.playwrightAction).toBe('press')
    })

    it('response 词表命中可断言终态', () => {
      expect(matchResponseAssertion('显示空状态提示')?.assertionKind).toBe('visible')
      expect(matchResponseAssertion('列表新增一条记录')?.assertionKind).toBe('item-added')
      expect(matchResponseAssertion('按钮置灰不可点')?.assertionKind).toBe('disabled')
    })
  })

  describe('GWT 骨架派生（§九验收 2：纯句式转换）', () => {
    it('WHEN → Given 默认入口 + When=trigger + Then=response', () => {
      const gwt = deriveGwtSkeleton('WHEN 点击保存按钮 → 列表新增一条记录')
      expect(gwt).not.toBeNull()
      expect(gwt!.kind).toBe('when')
      expect(gwt!.when).toBe('点击保存按钮')
      expect(gwt!.then).toBe('列表新增一条记录')
      expect(gwt!.given).toBeTruthy()
    })

    it('WHILE → Given 承载状态（空态/加载态映射 GWT Given）', () => {
      const gwt = deriveGwtSkeleton('WHILE 列表为空 → 显示「暂无记录」')
      expect(gwt!.kind).toBe('while')
      expect(gwt!.given).toBe('列表为空')
      expect(gwt!.when).toContain('进入')
      expect(gwt!.then).toBe('显示「暂无记录」')
    })

    it('IF → 异常类别标记（Given 默认 + When=条件）', () => {
      const gwt = deriveGwtSkeleton('IF 金额输入为负 → 提示金额无效且不保存')
      expect(gwt!.kind).toBe('if')
      expect(gwt!.when).toBe('金额输入为负')
    })

    it('非良构断言 → null（不硬造场景，调用方走 presenceFallback）', () => {
      expect(deriveGwtSkeleton('该功能项在产物中可见且可交互')).toBeNull()
    })
  })

  describe('与 behavior-assertions 解析链兼容（第四处口径：词表不降探针率）', () => {
    it('EARS 化产物（前缀+中轴）仍被 parseBehaviorAssertion 解析为行为探针', () => {
      const plan = parseBehaviorAssertion('WHEN 点击保存按钮 → 列表新增一条记录')
      expect(plan.presenceFallback).toBe(false)
      expect(plan.trigger?.kind).toBe('click')
      expect(plan.effect?.kind).toBe('add-item')
    })

    it('WHEN+按键类 EARS 断言仍解析出按键探针', () => {
      const plan = parseBehaviorAssertion('WHEN 按右方向键 → 车辆 x 坐标增加')
      expect(plan.presenceFallback).toBe(false)
      expect(plan.trigger?.kind).toBe('key')
    })

    it('WHILE 状态段经既有探针链 → presenceFallback（状态是 Given 不是 When；While 映射由 deriveGwtSkeleton 承担）', () => {
      const plan = parseBehaviorAssertion('WHILE 列表为空 → 显示空状态提示')
      expect(plan.presenceFallback).toBe(true) // 无动作词 → 存在性检查兑底，与现状同构
      const gwt = deriveGwtSkeleton('WHILE 列表为空 → 显示空状态提示')
      expect(gwt!.kind).toBe('while')
      expect(gwt!.given).toBe('列表为空')
    })
  })

  describe('prompt 词表渲染（三处同源：EARS 化 prompt 用同一常量）', () => {
    it('trigger/response/禁词表渲染非空', () => {
      expect(renderTriggerVocabularyForPrompt()).toContain('点击')
      expect(renderResponseVocabularyForPrompt()).toContain('新增条目')
      expect(renderForbiddenTermsForPrompt()).toContain('优雅处理')
    })
  })
})
