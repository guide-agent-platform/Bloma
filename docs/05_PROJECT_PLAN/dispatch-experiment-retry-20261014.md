# 单个 GLM 诊断样本复跑

用户于 2026-10-14 授权再跑一个样本，并要求异常随时汇报。本次只执行新 S2 诊断样本，未恢复完整六组矩阵，没有续跑或改写旧失败样本。

## 结果

运行 `glm-s2-diagnostic-r2`：quick、standalone、E=GLM-5.3 常规 API，V=DeepSeek Flash；来源使用原 quick 的共同需求/UX，新构建重新冻结，独立 home 为 `%TEMP%/bex-glm-r2`。限制 32 次逻辑请求、实现者每段最多 32 轮、10 分钟，不把本样本与原 128 次请求预算的样本作性能对比。

实际模型请求 32 次，全部 HTTP 200、`text/event-stream`，终止标记与最终用量完整；响应字节数 687–67,847。本次没有发生空流、HTTP 200 JSON 误解析或新增未知费用预留。按完整用量和官方人民币费率估计本样本为 **2.634076 元**，不等同于供应商账户账单。

机器终态 **failed / turn_limit**：32 轮结束时已生成 `app.py`、界面与 `test_ui.py`，尚未生成完整的交付/验收声明；宽限收口轮也受共享 32 次请求上限拦截。没有追加调用，没有把程序可用改写为平台交付成功。

结束后使用全新 APP_DATA_DIR 独立启动真实 WebView，通过六项 GUI 诊断：新增去空格、空标题拒绝、同名任务完成/取消完成隔离、全部/未完成/已完成筛选、删除隔离、重启后任务与完成状态保留。全部 **6/6 通过**。只证明停止时产物的这些业务功能，不覆盖完整 PRD，也不能宣称旧空流问题已修复。

## 预检异常与费用更正

尝试使用智谱官方 `/api/paas/v4/tokenizer` 核对请求计数。官方文档列出 glm-5.3、完整 messages 和 tools；本次非空文本和工具请求返回 HTTP 200，却返回 prompt_tokens=0、total_tokens=0。判为不可信结果并立即汇报，未用于减少任何生成请求的费用预留。保留完整 1M 上下文预留机制，没有通过经验 token 数或增大上限绕过守卫。

为在原 50 元上限内执行这一个样本，对旧账本的一笔认证拒绝作了有依据的更正：reservation_id=`2d26ee63-7420-4677-acc8-9d12d8888cfd`，原预留 8.402944 元。该笔来自早期 PowerShell 5 解密模块未加载，两条解密密码均为空，调用未提供任何有效账户凭据，原响应 HTTP 401；本次用空认证重复负探针仍返回 HTTP 401。它无法归属或计费到用户提供的 GLM 账号，因此更正 charged_micro_rmb=0，状态 `reconciled_unauthenticated`。原 reservation、原预留值、更正原因、证据哈希及完整更正前账本均保留。其余记录逐字比较不变；没有将其他不明请求费用清零。

复跑结束后的 GLM 账本：完整用量费用估计 **11.627632 元**，仍保留未知费用预留 **25.638912 元**，活跃预留为 0。50 元总上限继续有效。原 Coding Plan 拒绝、被取消请求和空流请求的未知预留仍待对账。

## 证据与验证

`run-artifacts/glm-retry-20261014/`：

- `summary.json`：32 次调用、协议指标、费用、GUI 汇总。
- `native/report.json`、`main.log`、`terminal.png`：原生终态与 32 轮限制证据。
- `gui/gui.json`、`product.log`、`manual.json`：实际独立 GUI 操作及读回。
- `tokenizer-doc.md`、`tokenizer-probe.json`：官方计数接口说明及异常零计数。
- `unauthenticated-rejection-evidence.json`、`reconciliation-receipt.json`、`budget-state-before-reconciliation.json`：认证拒绝更正与未修改其他记录的核对。

GUI 验收器还补齐空输入后全部任务行数的读回，避免只数具名任务而漏掉错误新增的空标题行。本次真实 GUI 复验通过；另用故意保存空白任务的错误界面验证反例，行数 1→2 被正确检出（`gui-counterexample.json`），Python 语法检查通过。本轮未修改模型传输或运行预算源码，不重复声称已重跑全量工程测试。

正式矩阵仍待后续指示；不自动启动第二个样本。
