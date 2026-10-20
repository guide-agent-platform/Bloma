# bench — 生成质量基准

> 历史范围：本目录原为2026-09的Web生成基准。现仅保留旧样本和离线采集、比较、重算工具；旧在线执行入口l1-run/l1-batch/b0-ensure/p1-ensure已退役删除。以下旧方案说明用于理解历史口径，不是当前制作流程的运行指南。当前桌面实验以docs/05_PROJECT_PLAN/production-workflow-v2-20261020.md及dispatch-experiment CLI为准。

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
│   ├── l1-run.mjs        # L1 在线驱动：Electron+真 IPC 全流程 → runs/<seed>/<run-id>/ 档案
│   ├── metrics.mjs       # 指标纯函数（零依赖、可单测）
│   └── scan.mjs          # L0 CLI：采集 + 指标 + 失败特征检测 → reports/
├── runs/                 # L1 运行档案（证据目录，不入库）
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
# 离线扫描（L0）：14 个历史项目 → 指标报告 + 失败特征提示
node bench/harness/scan.mjs

# 指定项目子集/输出目录（后续扩展）
node bench/harness/scan.mjs --projects 7ae665fc --out bench/reports/seed-a.md
```

### L1 在线评测（2026-09-09）

```bash
npm run build   # 先构建 dist-main（Electron 实例跑构建产物）

# 渠道预检（生产 userData 上下文解 key → L1 实例内重存 → 全渠道连通测试）
node bench/harness/l1-run.mjs --seed seed-b-crud-calculator --probe

# 单次全流程：新项目 → 注入 seed 需求 → 澄清/需求确认/PRD 门脚本应答 → MVP loop → 终态 → 采集档案
node bench/harness/l1-run.mjs --seed seed-b-crud-calculator --mode quick --timeout-min 25 --label b0

# 参数：--mode quick|longterm｜--keep-home（保留临时 PROMA_HOME 排查）｜--dry（仅环境自检）
```

- 终态 ∈ {converged@ready|completed, blocked, stalled, timeout}；run 档案落 `bench/runs/<seed>/<ts-label>/`
  （manifest/run.log/evidence/metrics/events/session-raw/artifacts.sha/main.log，P0 稿 §5 清单）。
- 渠道注入链：safeStorage 密文绑定 userData（陷阱 45）——生产密文先在 Roaming/bloma 上下文
  （channel-key-reader.cjs）解出，再经 L1 实例 `channel:update` 重存（明文只过内存/临时文件，用后删）。
- 决策驱动以会话 JSONL 的 `[decision]` JSON 行为权威（type ∈ clarification_card /
  requirement_confirm_card / prd_review / prd_confirm）；生成中阶段（generating_mvp/testing/…）不碰卡。
- 脚本用户行为基线：澄清按 seed.clarificationPath 匹配（失配选首个非让渡项，耗尽让渡）；
  需求确认=全量勾选；PRD 审查退回=override 忽略；草图=accepted。每次应答落 run.log 审计。
- 汇总报告：`node bench/harness/l1-report.mjs [--label b0]` → reports/l1-report-*.md/.json（按 seed 报分布，不报最好）。

## 指标矩阵（14 项，Phase 0.5 扩容）

| # | 指标 | 口径（全确定性，L0/L1 同源） |
|---|---|---|
| 1 | e2e 成功率 | 终态 converged（ready/completed）/ 总 run |
| 2 | 首轮成功率 | repairRounds=0 且 converged |
| 3 | 成本-轮数 | agent_loop_completed turns（均值/中位/p95/逐 run） |
| 4 | 成本-耗时 | run 起止时间 |
| 5 | 修复轮数 | repair_round_completed 计数 |
| 6 | judge 判定 | judge_verdict pass/fail |
| 7 | GWT 运行 | run_gwt_tests 计数 + test_completed 事件（round/total/failed） |
| 8 | 风险标记数 | computeFlags 非 info 计数 |
| 9 | 首次约束违规 | 产物扫描：localStorage 唯一数据源（435ca2c 渠道绕过特征）+ 密钥入码模式 |
| 10 | 核心能力保留率 | AI 意图任务：PRD 保留 AI 语义且产物有接入痕迹=1；仅 PRD=0.5；蒸馏=0；非 AI=n/a |
| 11 | 协议泄漏率 | assistant 正文含工具协议原文（<tool_calls>/DSML/裸工具 JSON）轮次占比 |
| 12 | 有效交付 token | converged 且 mvpDelivered 的 input_tokens 合计（未收敛不计入均值） |
| 13 | 空正文率 | 无 text 且无 tool_use 的 assistant 轮占比（思考耗尽特征） |
| 14 | 错误触发计数 | 会话【历史经验】/【常见错法】注入段计数（开关 off 恒 0；P0a 占位口径，相关性人工校准） |

## 纪律

1. **不污染生产数据**：scan 只读；不写入 `~/.proma`；在线重跑须用独立临时 PROMA_HOME。
2. **seed 验收判据需人工冻结**：`seed-v0.json` 中 `acceptance` 为草稿，确认后才可作回归基准。
3. **不写入敏感内容**：会话抽取只保留 user 需求轮与澄清选项，不含系统提示/工具载荷。
4. 本基准改动**不触碰平台源码与工作树在途改动**；提交时机由用户决定。

## 阶段

- **L0 离线扫描（当前）**：用 14 个历史项目校准指标与失败分类，零 LLM 成本。
- **L1 在线重跑（后续）**：以 seed-v0 固定任务 + 澄清脚本驱动新项目完整流水线（复用 `tests/e2e/support/electron-fixture.ts` 通道与临时 PROMA_HOME），跑固定预算下真实成功率。
