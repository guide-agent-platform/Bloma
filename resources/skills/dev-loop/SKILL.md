---
name: dev-loop
description: Bloma 开发循环 SOP——取号对齐、TDD 三步、质量门与提交纪律的团队标准流程（A 工程负责人视角）
---

# Bloma 开发循环 SOP

单轮 = 交付一个用户故事/功能。按以下顺序执行，不得跳步：

## 1. 取号与文档对齐
- 读 `docs/05_PROJECT_PLAN/sprint-plan.md` 取当前 Sprint 待办（P0 > P1 > P2、无阻塞）
- 对齐 PRD / user-stories / 交互规格 / API spec，产出「文档化期望行为」清单（逐条有出处）
- 文档冲突 → 停止并报告，不自行裁决

## 2. 测试先行（TDD 铁律）
- 先写失败测试确认红 → 最小实现转绿 → 重构补边界
- 每个功能至少 1 GWT + 1 单元 + 相关组件测试
- 测试独立于实现设计：期望行为来自第 1 步清单，实现只用于找可执行边界

## 3. 质量门（全绿才可提交）
```bash
npm run typecheck
npm run test:unit
npm run test:regression:sprint0 && npm run test:regression:sprint1
git diff --check
```

## 4. 提交纪律
- 提交信息：`feat(scope): 描述（TDD）`；不触碰 docs/（只读）
- 失败自动修复 ≤3 次，第 3 次熔断回滚并报告
