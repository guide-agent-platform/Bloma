# bench — 生成质量基准

> P0a 落地件之一。度量「平台把固定需求稳定变成高质量可验收产物」的能力，
> 作为后续能力契约（CAP）/ 可信测试边界 / 故障签名 / 事务化修复等改造的回归基线。
>
> 依据：桌面《Bloma-咨询A-确定性收敛与质量护栏-20260909.md》P0 项
> ＋《Bloma-P0生成质量基准实施稿-20260909.md》。

## 为什么需要

- 平台自身测试（unit/acceptance/e2e）测的是「平台代码没坏」，回答不了「平台生成的东西好不好」；
- 14 个历史生成项目 + analytics 已自动落盘，是免费的回放样本；
- 大量 `BLOMA_*` 开关没有判别力任务集可跑 A/B。

## 目录结构

```text
bench/
├── README.md
├── tasks/seed-v0.json    # 首批任务卡（六类各 1，从历史项目提炼）
├── harness/
│   ├── collector.mjs     # 离线采集：projects/documents/analytics/agent-sessions → evidence
│   ├── metrics.mjs       # 指标纯函数（零依赖、可单测）
│   └── scan.mjs          # CLI：采集 + 指标 + 失败特征检测 → reports/
└── reports/              # offline-report-<ts>.md / .json（不入库）
```

## 数据源映射（默认 `~/.proma`，可用环境变量 `BLOMA_PROMA_HOME` 覆盖）

| 数据 | 路径 | 用途 |
|---|---|---|
| 项目索引 | `<home>/projects.json` | id/name/stage/created |
| PRD/测试/loop 文档 | `<home>/agent-workspaces/default-software-builder/documents/<id>/` | prd.json、test-report.json、loop-log.md |
| loop 运行事件 | `<home>/agent-workspaces/default-software-builder/analytics.jsonl` | 轮数/token/修复轮/judge |
| 项目工作区 | `<home>/agent-workspaces/default-software-builder/generated-projects/<id>/` | 产物 |
| 原始对话 | `<home>/agent-sessions/<sid>.jsonl` | user 原始需求、decision-card 澄清选项 |

## 用法

```bash
# 离线扫描：14 个历史项目 → 指标报告 + 失败特征提示
node bench/harness/scan.mjs

# 指定项目子集/输出目录（后续扩展）
node bench/harness/scan.mjs --projects 7ae665fc --out bench/reports/seed-a.md
```

## 纪律

1. **不污染生产数据**：scan 只读；不写入 `~/.proma`；在线重跑须用独立临时 PROMA_HOME。
2. **seed 验收判据需人工冻结**：`seed-v0.json` 中 `acceptance` 为草稿，确认后才可作回归基准。
3. **不写入敏感内容**：会话抽取只保留 user 需求轮与澄清选项，不含系统提示/工具载荷。
4. 本基准改动**不触碰平台源码与工作树在途改动**；提交时机由用户决定。

## 阶段

- **L0 离线扫描（当前）**：用 14 个历史项目校准指标与失败分类，零 LLM 成本。
- **L1 在线重跑（后续）**：以 seed-v0 固定任务 + 澄清脚本驱动新项目完整流水线（复用 `tests/e2e/support/electron-fixture.ts` 通道与临时 PROMA_HOME），跑固定预算下真实成功率。
