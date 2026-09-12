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

## 5. 待接线（本 Sprint / Sprint2）

- `session-recall` 的召回结果接入撤销过滤（当前 `prepareRecallBlock` 尚未校验名单）；
- 统一出口 `renderMemory()`（§11 契约）落地后，撤销校验收敛为**单一出口**，各层不再各自读取名单；
- 删除入口（UI / IPC）落地时调用 `revokeMemoryText`（UI 排下一批）。

## 6. 已验证用例

见 `tests/unit/memory-revocation.test.ts`：缺失=空名单、指纹同源（转义前后命中）、幂等、**不存原文**（文件内容断言）、损坏 fail-closed、损坏下可重建、超限丢最旧、原子写无残留。
learnings 侧集成断言见 `tests/unit/learnings-log.test.ts`（撤销条目不注入 + 名单损坏整体不注入 + 原始账本仍可读）。
