# L3 蒸馏层冻结验收清单（§6 / D0）

> 日期：2026-09-12｜基线：`sprint2`（本地 HEAD；冻结动作见 commit `d943b7a`）
> 结论口径：冻结（生产不触发），**删层留待单独决策**

---

## 1. 冻结动作（已完成）

| 动作 | 位置 | 说明 |
|---|---|---|
| 移除生产触发点 ①  | `main/coding/programming-orchestrator.ts` `runMvpTask` | 原「草图确认后 fire-and-forget」 |
| 移除生产触发点 ② | 同文件 `runIterationTask` | 原「每轮迭代完成后 fire-and-forget」 |
| 头注如实化 | `main/memory-distiller.ts` | 标注"未接注入面、生产不触发、启用前置条件" |
| 单测注释纠错 | `tests/unit/memory-distiller.test.ts` | 原称"注入 MVP 提示词为提示级参考"——该注入从未实现 |
| 默认关闭 | `main/memory-distiller.ts:53` | `BLOMA_MEMORY_DISTILL === '1'` 才启用（已成立，无需改） |

**根因**：`readProjectMemory()` 全仓只有定义与单测引用，`rejected_ideas / verbal_preferences / non_functional_notes / distilled_at` 字段级搜索零命中 → 生产一旦启用即"写了没人读"。

## 2. 残留面逐项结论

| # | 残留项 | 结论 | 依据 |
|---|---|---|---|
| 1 | `main/memory-distiller.ts:107`（`category: 'summary'`） | **保留（文件级）** | 该文件作实验资产保留；其内用法随冻结失效，不影响其他功能 |
| 2 | `main/category-routing.ts:38,248`（`ROUTABLE_CATEGORIES` / `KNOWN_CATEGORIES` 含 `'summary'`） | **保留** | `'summary'` 是**产品面类别**：`buildCategoryRoutingViews()`（:214）→ `main/ipc.ts:978` → `shared/types.ts:537,555,1471-1476`（`CategoryRoutingView` / `categoryRoutingList` / `categoryRoutingUpdate` / `categoryRoutingRole*`）。单方面清理 = 静默变更产品行为；如需变更走产品决策 |
| 3 | `main/model-resolution.ts:48`（`summary: { category: 'summary', capability: 'strongest' }`） | **保留** | 同上：渠道/模型解析的产品面映射，非 L3 专属 |
| 4 | `main/decision-log.ts:47`（`memory_distilled` 类型联合成员） | **保留** | 历史 JSONL 与 `decisions.md` 已有该类型记录，删除只减历史可读性；**无 exhaustive 映射**（`Record<DecisionEntryType,…>` / `case '…'` 零命中；renderer 的 "decision" 指 `user_decision_required` 卡片，与此无关；`shared/types.ts` 不含该类型）→ 无编译收益亦无风险 |
| 5 | 3 个单测文件（`memory-distiller.test.ts` / `constraint-extractor.test.ts` / `session-recall.test.ts`） | **保留** | 前者直接调用 `distillProjectMemory` 验证落库/降级/背板去重（已改为直接调用口径）；后两者仅注释提及 |
| 6 | `main/` 对 `memory-distiller` 的引用 | **零 import**（仅 3 处注释引用：`experience/types.ts:19`、`learnings-log.ts:10`、`session-recall.ts:11`） | 由可达性门禁持续保证 |

## 3. 门禁（本条由 D0 新增）

- `tests/unit/memory-reachability.test.ts`：从 `main/index.ts` 出发的可达集**不含** `main/memory-distiller`；覆盖 `export *` 过渡桩解析、动态 `import()`/`require()` 兜底；**模块被删层时视为通过**。
- **变异自证**：夹具链 `index → a → memory-distiller` 必须被判可达；断链夹具不得误报（两条负例/正例用例）。
- 并入 `tests/unit`（不新造平行门禁）。

## 4. 启用前置条件（未来若要做）

1. 先实现**注入面**（把蒸馏产物拼进统一出口 `renderMemory()`），**不得只接触发点**；
2. 过产品决策（LLM 成本 + 投毒面）；
3. 注入必须走统一净化出口 + 撤销名单校验；
4. 交付前补：产物 schema 校验用例、注入面单测、投毒用例、成本/延迟预算（见 `whitespace-values.md`）。

## 5. 未决

- 是否最终删层：留待单独决策（当前选择"冻结 + 保留实验资产"）。
