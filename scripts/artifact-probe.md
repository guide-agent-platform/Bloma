# artifact-probe.mjs —— 产出物「机器探测层」CLI

给 Bloma 生成物（游戏/软件）做**零 LLM 的界面真实性探测**：视觉模型看不出 `div` 伪装按钮、
死点击、验收断言印进页面，这一层能。

## 用法

```bash
node scripts/artifact-probe.mjs <url> [--out probe.json] [--click-limit N]
npm run audit:artifact -- <url>            # 等价的 npm 入口
```

- `<url>`：产物入口，`file:///C:/path/index.html` 或 `http://127.0.0.1:PORT` 均可。
- `--out`：把 JSON 结果写盘（便于归档/工单引用）。
- `--click-limit`：按钮类元素点击活性采样上限，缺省 8。

## 退出码（可挂 CI / 门禁）

| 码 | 含义 |
|---|---|
| 0 | 未发现假界面风险 |
| 1 | 发现风险（`fakeUiRisk` / `assertionLeak` / `deadClicks` 任一为真） |
| 2 | 用法错误 |

## 检测项与判定

| 字段 | 含义 | 风险判定 |
|---|---|---|
| `interactive.realControls` | 真交互控件数（button/input/textarea/select/contenteditable/带 href 链接/role） | 为 0 且存在伪装控件 → `fakeUiRisk` |
| `pretendWidgets` | class 含 `btn` 却是 `div`/`span` 的伪装控件 | 同上 |
| `clickResults` | 逐个点击按钮类元素后的 DOM 变化采样 | 全部无变化 → `deadClicks` |
| `leaks` | 内部验收话术泄漏（`可见且可交互`、`该功能项在产物中`、`F-\d{3}`、Given/When/Then） | 命中（除占位人设）→ `assertionLeak` |
| `sanity` | 白屏（body 文本 < 20 字）/ 空标题 | 人工判读 |

## 与内置门禁的关系

- **产品内自动执行**：`main/coding/artifact-ui-gate.ts` 是同一套判定规则的模块化版本，已挂在
  终验链 `runGwtWithApiContract` 内（初验与修复轮重验都跑，失败进修复回流，无法旁路）。
- **本 CLI 的用途**：存量产物回审、单页快速排查、CI/本地手动门禁、给工单附证据。
- 两者判定口径由测试锁定：`tests/unit/coding/artifact-ui-gate.test.ts`。

## 示例

```bash
# 拦假界面（退出码 1）
node scripts/artifact-probe.mjs file:///C:/path/to/fake/index.html

# 放行合法产物（退出码 0），并把证据写盘
node scripts/artifact-probe.mjs http://127.0.0.1:5173 --out evidence/probe.json
```
