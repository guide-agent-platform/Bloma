# 撤销名单与跨会话删除（§8 / D0）

> 日期：2026-09-12｜实现：`main/memory-revocation.ts`｜用例：`tests/unit/memory-revocation.test.ts`（8 例）

---

## 1. 解决什么问题

记忆被注入后会**落进会话 JSONL**（`main/coding/agent-loop.ts`：「JSONL 落注入后文本——审计=模型实际所见，continue 重放一致」），
而 `session-recall` 索引的正是那批转录（`main/session-recall.ts:101` 扫 `{PROMA_HOME}/agent-sessions/*.jsonl`）。

因此只删源文件不足以"删除"：同一段文本仍可被跨会话检索召回、再次注入。
**撤销名单是"只读侧排除"的单一裁决点**：所有受覆盖层渲染时校验，命中即跳过——不改写转录、不删审计。

## 2. 规格

| 项 | 约定 |
|---|---|
| 路径 | `~/.proma/bloma-revocation-index.json`（全局；与 `bloma-experience.jsonl` 同级——跨会话语录是全局的，指纹必须全局覆盖） |
| 存储 | `{ version: 1, updated_at, fingerprints: string[] }`；**只存归一化指纹，不存原文** |
| 指纹口径 | `sha256(escapeMemoryDelimiters(text)).slice(0,32)`——归一化与注入侧净化**同源**，保证"删除时的原文"与"注入时的净化文本"命中同一指纹 |
| 写入 | 幂等；**原子写**（`tmp` + `rename`）；损坏文件下以本次写入重建（不因坏文件丢掉本次撤销指令） |
| 增长清理 | 超 `MAX_FINGERPRINTS = 5000` 丢最旧（**数值待产品/安全批准**，见 `whitespace-values.md`） |
| 缺失语义 | 文件不存在 = 空名单（`readable: true`）→ 照常注入 |
| 损坏语义 | 存在但不可解析 = `readable: false` → **受覆盖层整体不注入（fail-closed）**；单条判定恒为"已撤销" |
| 开关 | 无（安全路径不做开关，见指令总原则） |

> 「名单不可读时整体不注入」而非「这一条不注入」：名单读不出时**无法判断哪些条目被撤销**，只能整体 fail-closed。

## 3. 覆盖表

| 层 | 覆盖 | 名单不可读时 |
|---|---|---|
| learnings | 是 | 整体不注入（`renderLearningsSection` 直接返回空串） |
| 跨会话召回（session-recall） | 是 | 整体不注入（待接入统一出口，见 §5） |
| memory.json | 冻结中（无注入面） | — |
| 经验卡 | 否（自有 `retired` 状态） | 照常 |
| 项目地图 | 否（非用户记忆） | 照常 |
| 使用埋点 sidecar | 否 | 照常（损坏只影响 UI） |

**文件解耦约定**：撤销名单（低频写、安全机制）与使用埋点（高频写、UI 元数据）**必须两个独立文件**：
`~/.proma/bloma-revocation-index.json` 与 `~/.proma/bloma-memory-usage.json`。
否则高频埋点的损坏概率会放大到安全机制上（一个 UI 元数据把三层记忆打成不注入）。

## 4. 与删除的关系

1. 删除动作 = `revokeMemoryText(原文)` 写指纹（**不写原文**）；
2. 原始账本不动（append-only 审计）；
3. 所有受覆盖层下次渲染即排除；
4. 删除后**可验证**：单测覆盖"删除 → 渲染为空 / 召回不再命中 / 原始数据仍可读"。

## 5. 接线状态（4a 已落地，2026-09-12）

- ✅ **learnings**：`renderLearningsSection` 渲染时校验名单；名单不可读 → 本层返回空串（整体不注入）。
- ✅ **session-recall**（4a，`prepareRecallBlock`）：名单不可读 → 本层返回 null（整体不注入）；命中撤销 → **整条 hit 丢弃**（既查命中片段，也查该会话文件内任何被索引消息，防同一文本经 intent/同会话其他片段泄漏）。单测 `[S4-RECALL-015/016]`。
- ⏳ **§11 统一出口 `renderMemory()`**：落地后撤销校验收敛为单一出口（各层不再各自读取名单）；本阶段两处接线均为**临时补丁**，代码已标迁移路径。
- ⏳ 删除入口（UI / IPC）落地时调用 `revokeMemoryText`（UI 排下一批）。

## 5.1 IO 记账（重要）

`loadRevocationIndex` **每次调用读文件、无模块级缓存**（`existsSync` + `readFileSync` + `JSON.parse`）。原因：缓存 TTL = 删除生效延迟 = 复活窗口，与 fail-closed 目标冲突。

→ 注入侧 IO 暂为 **5 处**：learnings 读写、会话索引构建、项目地图扫描、sidecar 埋点写、**撤销名单读**。
每次频率为**任务级**（每轮 loop 渲染各一次），相对 `buildSessionIndex`（全量重扫会话 JSONL，实测 ~1.0s）可忽略；收敛点 = §11 契约（一次读取、多出口复用）。

## 6. 已验证用例

见 `tests/unit/memory-revocation.test.ts`：缺失=空名单、指纹同源（转义前后命中）、幂等、**不存原文**（文件内容断言）、损坏 fail-closed、损坏下可重建、超限丢最旧、原子写无残留。
learnings 侧集成断言见 `tests/unit/learnings-log.test.ts`（撤销条目不注入 + 名单损坏整体不注入 + 原始账本仍可读）。
session-recall 侧集成断言见 `tests/unit/session-recall.test.ts` `[S4-RECALL-015/016]`（撤销后不再召回 + 名单不可读整体不注入）。

## 7. 未决：截断 vs 可恢复载体（进第 2 项决策一并裁定）

撤销名单现有 `MAX_FINGERPRINTS` 上限（丢最旧）。若某文本**仍可能从其他载体恢复**（会话转录、含 documents 的历史快照、回滚），则其指纹**不得被截断**——否则该文本会重新变为可注入，「删除不可复活」被截断策略破坏。

候选方案（待裁定）：① 指纹加 `retain_until` / `recoverable` 标记，与快照保留期联动；② 取消截断或大幅提高上限（代价：文件增长）；③ 做归档排除（①-a）后确认无载体残留，再允许截断。

