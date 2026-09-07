---
name: ui-walkthrough
description: Bloma UI 走查 SOP——测试→截屏→视觉诊断→修复→回归的显示/交互巡检流程（B 前端/UX 视角）
---

# Bloma UI 走查 SOP

## 1. 代码与测试检查
```bash
npm run typecheck
npm run test:unit
npm run test:acceptance:sprint2   # 显示/交互组件测试
```

## 2. 截屏
```bash
npm run dev:renderer   # http://127.0.0.1:5173/
node scripts/_screenshot-worker.cjs "http://127.0.0.1:5173/" <截图路径> 1440 900
```

## 3. 视觉诊断
用 `scripts/vision-diagnose.mjs` 诊断截图（布局/对比度/间距/状态反馈），输出 issues 清单。
无视觉凭据时降级为「DOM 分析 + 组件测试」检查。

## 4. 修复与回归
- 按 issues 逐项修复，尊重既有设计约定与测试契约；每修一项重跑相关测试
- 完成标准：原失败测试转通过 + typecheck + 相关回归全绿
- 每次修 3 个缺陷或推进 1 个迭代项即收尾，控制范围
