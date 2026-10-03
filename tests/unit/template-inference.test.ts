import { describe, expect, it } from 'vitest'
import { DEFAULT_TEMPLATE_TYPE, inferTemplateType, refineTemplateType } from '../../main/guide/template-inference'
import type { TemplateType } from '../../shared/types'

describe('template-inference（P2 注入点①：PRD 12.2 关键词→类型）', () => {
  describe('inferTemplateType：12.2 官方表', () => {
    const cases: Array<[string, TemplateType]> = [
      // 「做个网站/网页/博客/商城/后台」→ Web 全栈
      ['帮我做一个网站，放我的作品', 'web_fullstack'],
      ['做个网页版的公司介绍', 'web_fullstack'],
      ['我想写一个博客记录生活', 'web_fullstack'],
      ['开个在线商城卖手工饰品', 'web_fullstack'],
      ['做一个后台管理系统', 'web_fullstack'],
      ['给门店做个官网', 'web_fullstack'],
      ['做个论坛让大家交流', 'web_fullstack'],
      // 「做个电脑工具/桌面软件」→ 桌面工具
      ['做个电脑上的工具批量改名', 'desktop_tool'],
      ['帮我开发一个桌面软件管库存', 'desktop_tool'],
      ['要一个本地应用，断网也能用', 'desktop_tool'],
      ['做个 Windows 程序监控温度', 'desktop_tool'],
      ['效率工具，装在电脑上', 'desktop_tool'],
      // 2026-09-25 狗粮实证：「桌面+具体产品名」也是强载体信号（桌面计算器案例）
      ['桌面计算器', 'desktop_tool'],
      ['做一个桌面日历带倒计时', 'desktop_tool'],
      // M-2：功能词不得抢跑载体词——「效率工具网站/在线效率工具」是网页载体
      ['效率工具网站', 'web_fullstack'],
      ['在线效率工具', 'web_fullstack'],
      ['网页版效率工具', 'web_fullstack'],
      // 「帮我处理数据/批量操作/脚本」→ 桌面线（桌面唯一品类对齐，2026-10-03：
      // 本地小工具词原归 personal_tool，10-01 web 线退役后直进唯一生成线）
      ['帮我处理一批数据的格式', 'desktop_tool'],
      ['批量操作：把 500 张图片压缩', 'desktop_tool'],
      ['写个脚本自动化报表', 'desktop_tool'],
      // 个人小工具词族（fc3f6fab 实证：裸「做一个计算器」曾误判 personal_tool
      // 走 web 文案——现直进桌面线）
      ['做个番茄钟', 'desktop_tool'],
      ['我想要一个记账的小账本', 'desktop_tool'],
      ['做个待办清单', 'desktop_tool'],
      ['一个简单的计算器', 'desktop_tool'],
      ['做一个计算器', 'desktop_tool'],
      // 载体词优先级不变：显式网页载体仍是 web（PRD 后形态卡引导桌面）
      ['网页版计算器', 'web_fullstack'],
      ['在线记账小工具', 'web_fullstack'],
      // AI 关键词暂归个人小工具（模板包二期）
      ['调用 AI 做一个自动回复', 'personal_tool'],
      ['做一个智能问答助手', 'personal_tool'],
      // P1-8/P1-9：游戏/互动媒体类目归独立 game 类型（复用 web_fullstack 骨架，必测类别差异化）
      ['做一个贪吃蛇小游戏', 'game'],
      ['做个网页游戏，闯关玩法', 'game'],
      ['以撒复刻', 'game'],
      ['复刻一个扫雷', 'game'],
      ['做个 2048 游戏', 'game'],
      // 「复刻」不抢跑网页词：复刻网站仍是 web_fullstack
      ['复刻一个博客网站', 'web_fullstack'],
    ]
    for (const [text, expected] of cases) {
      it(`「${text}」→ ${expected}`, () => {
        expect(inferTemplateType(text)).toBe(expected)
      })
    }

    it('无命中 → desktop_tool 兜底（桌面唯一品类对齐，2026-10-03：唯一生成线直进）', () => {
      expect(inferTemplateType('帮我做个东西')).toBe(DEFAULT_TEMPLATE_TYPE)
      expect(DEFAULT_TEMPLATE_TYPE).toBe('desktop_tool')
      expect(inferTemplateType('')).toBe('desktop_tool')
    })

    it('桌面优先于网页（载体信号更稀有）', () => {
      expect(inferTemplateType('做一个装在电脑上的软件，不要网页')).toBe('desktop_tool')
    })

    it('浏览器形态词归 web（「就在浏览器里用」）', () => {
      expect(inferTemplateType('就要个计算器，在浏览器里用')).toBe('web_fullstack')
    })
  })

  describe('refineTemplateType：澄清轮修正（显式信号才变）', () => {
    it('strong 形态信号修正既有判断', () => {
      expect(refineTemplateType('personal_tool', '要在网页上打开给别人用')).toBe('web_fullstack')
      expect(refineTemplateType('personal_tool', '做成桌面软件吧')).toBe('desktop_tool')
      expect(refineTemplateType('web_fullstack', '不，我要装在电脑上的')).toBe('desktop_tool')
    })

    it('weak 信号不动已有判断（说到计算器≠把 web 项目改成小工具）', () => {
      expect(refineTemplateType('web_fullstack', '里面要有个计算器功能')).toBeUndefined()
      expect(refineTemplateType('desktop_tool', '顺便加个待办清单')).toBeUndefined()
    })

    it('无信号/同类型 → 维持现状（返回 undefined 不写盘）', () => {
      expect(refineTemplateType('web_fullstack', '颜色用蓝色')).toBeUndefined()
      expect(refineTemplateType('personal_tool', '做个番茄钟')).toBeUndefined()
    })
  })
})
