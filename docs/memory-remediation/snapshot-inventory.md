# 存量快照记忆文件清单（只读扫描报告）

> 日期：2026-09-12｜命令：只读扫描，**未修改任何数据**｜扫描根：`PROMA_HOME = C:/Users/23968/.proma`
> 用途：为「快照通道处置（①-b）」提供决策依据；在威胁模型独立复核签字前**不做任何清理**

---

## 1. 扫描方法与路径形状（含实证）

归档由 `main/platform-services.ts` 生成：

```text
:504  snapshotDir  = {workspace}/snapshots/{projectId}
:507  documentsArchivePath = {snapshotRoot}/documents          # include_documents=true 时
:518  cpSync(documentsDir, documentsArchivePath, { recursive: true, force: true })
```

`cpSync(src, dest)` 在 dest 不存在时把 **src 的内容**复制到 dest，因此归档内**没有 projectId 层**。
真实数据实证（本机唯一含 documents 的快照）：

```text
{workspace}/snapshots/07dbf2c2…/5d911b0c…/documents/
├── .document-manifest.json
├── decisions.md
├── plantuml/
├── prd.json
└── requirement_confirmed.md
```

→ 扫描口径：`{PROMA_HOME}/agent-workspaces/*/snapshots/*/*/documents/{learnings.jsonl,memory.json,project-map.md}`；
**只扫 `documents/`，不递归 `files/`**（后者是项目整树副本，成本高且不含记忆层）。

## 2. 扫描结果

| 指标 | 数值 |
|---|---|
| 扫描工作区数 | 15（`agent-workspaces/*`） |
| 含 `snapshots/` 的工作区 | 1（`default-software-builder`） |
| 扫描快照总数 | **1** |
| **含记忆文件的快照数** | **0** |
| 记忆文件总大小 | 0 字节 |
| 衍生痕迹命中（`decisions.md` / `loop-log.md`） | 1（该快照的 `decisions.md`） |

**唯一快照详情**：`default-software-builder` / project `07dbf2c2…` / snapshot `5d911b0c…`，kind=`sketch`，created_at=`2026-08-26T15:40:51Z`，含 documents 归档（`prd.json`、`decisions.md`、`requirement_confirmed.md`、`plantuml/`），**不含任何记忆文件**。

## 3. 附带观测（live 数据，非快照）

| 文件 | 数量（`agent-workspaces/*/documents/*/`，排除快照） |
|---|---|
| `learnings.jsonl` | 0 |
| `memory.json` | 0（L3 已冻结，从未产出） |
| `project-map.md` | 16 |

→ 本机 PROMA_HOME 下**没有已产出的执行经验账本**；`project-map.md` 有 16 份（由写盘后防抖重生成）。

## 4. 结论与建议

1. **存量快照复活风险面 ≈ 0**：唯一含 documents 的历史快照里没有记忆文件 →「回滚恢复已删记忆」在当前数据上**无对象**。
2. **不做数据清理**（无对象；且删用户数据不可逆，须等威胁模型签字 + UI 提示上线）——维持裁定。
3. **改用真正的过渡控制（推荐优先于 ①-b 清理）**：在**回滚恢复路径**上做读取侧排除——恢复 `documents` 归档时跳过撤销名单命中的记忆文件/条目。理由：
   - 它**不删任何存量数据**（因此不受"签字前不得删数据"约束），却直接消除复活通道；
   - UI 提示只是**告知**，不是控制；仅靠提示无法消除"回滚即复活"。
4. 若将来扫描出现含记忆文件的快照，判定阈值建议（**待产品/安全批准**，写入 `whitespace-values.md`）：
   - 含记忆快照数 **≥ 3** 或最早一条 mtime **早于 2 个发布版本** → 走「登记不可逆边界 + UI 提示」，不清理；
   - 含记忆快照数 **≤ 2 且均为近 30 天** → 可做 ①-b 清理（须 `--dry-run` + 备份 + UI 提示已上线）。
5. **覆盖边界**：本报告只覆盖 `C:/Users/23968/.proma`。若 Bloma 曾以其他 `PROMA_HOME` 运行（例如自定义 env/dev 实例），需在对应根重跑同一扫描；扫描脚本见会话工作台 `scan-snapshots.mjs`（一次性只读工具，未入库）。

## 5. 复跑方式

```bash
PROMA_HOME=<目标根> node <workbench>/scan-snapshots.mjs    # 只读，输出计数 + 逐快照明细 + 时间分布
```
