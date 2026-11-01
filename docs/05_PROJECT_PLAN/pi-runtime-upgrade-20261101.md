# Pi 1.4.0 升级与原生接口接入

日期：2026-11-01（Asia/Shanghai）。起点 `785cee1`。用户授权继续升级，并明确优先采用成熟实现、不为旧接口保留兼容负担。本批采用Pi 1.4.0原生API，没有增加0.85.1/1.4.0双运行分支；宿主的项目权限、请求/费用准入、图片授权和交付验收继续保留。

## 依赖与实施方式

- `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai` 从0.85.1统一精确锁定为1.4.0，package-lock同步。其他直接依赖声明不变，Pi所需的传递依赖随锁文件更新。
- 已核对[官方1.4.0发布](https://github.com/earendil-works/pi/releases/tag/v1.4.0)、npm包完整性及Node要求。当前Node 22.22.2满足其 `>=22.19.0`；未使用canary。
- 先在 `run-artifacts/pi-upgrade-20261101/checkout` 的独立源码/依赖副本安装、适配和测试，通过后只同步涉及的文件与锁定依赖到主工作区。两次安装均禁用生命周期脚本，没有运行第三方安装脚本或模型调用。
- 原生SDK的会话、压缩、重试、队列继续负责执行；Bloma提供已有工具与供应商桥。不会因为安装了MCP/Codemode传递包就启用它们。

## 实际不兼容点及适配

| 新版行为 | 本批处置 |
| --- | --- |
| `shouldStopAfterTurn`不再存在，改用`finishTurn` | 使用新接口，保留SDK原有boundary hook，再执行宿主完成、取消、预算和steer判定；不模拟旧属性 |
| `finishTurn`在error/aborted响应后也会触发 | 失败响应不进入宿主完成提议，不启动C/V；先让Pi收尾或重试，再由既有外层处理预算停止后的免费宿主验证 |
| `StreamFn`接收`TranscriptContext`，系统提示/工具在system消息内 | 使用SDK的 `getCurrentSystemPrompt`、`getCurrentTools` 重放真实状态；覆盖section替换、工具加入/移除。开发期重复读取压缩后也保留SDK系统消息 |
| 工具参数要求`JsonObject` | 复用SDK的 `parseToolCallArguments`，不另写JSON修复器；非对象/循环数据明确拒绝 |
| 新版处理图片内容，旧短引用被当作base64图片，导致图片省略 | 关闭SDK像素缩放，以base64封装短引用自身，实际图像仍在Bloma授权出口水合。持久记录不含实际图片字节；读取已有普通短引用仅由同一解码器处理，无旧运行器 |
| 工具/扩展入口更多 | 明确关闭原生MCP/Codemode扩展，只启用宿主工具名单，并在请求前检查实际工具集合；项目 `.pi/extensions` 与 `.pi/mcp.json` 不获得执行权 |
| 摘要改用模型输出上限 | 传输桥继续夹紧到宿主 `input.maxTokens`，摘要归入handoff计量，仍穿过共享请求和金额守卫；不借SDK压缩另开未记账请求 |

消息配对投影保留上一批修复：孤立/重复/跨轮tool result不进入线协议，原native会话及回执不改写，不重放已完成副作用。该投影属于供应商桥，不是旧SDK兼容层。

## 测试与证据范围

日志统一在本机忽略目录 `run-artifacts/pi-upgrade-20261101/`；registry下载和GitHub只读查证不属于模型调用。测试使用受控query、本机127.0.0.1 HTTP/SSE、真实本机浏览器/Electron及临时成品，没有付费供应商请求。

- 隔离初次类型检查确认真实API变化；第一次核心回归发现图片省略和旧版本断言，保留 `isolated-types-before.log`、`isolated-core-tests.log` 等失败记录。
- 隔离适配后的类型检查、5文件32项通过：`isolated-types-r3.log`、`isolated-verified.log`。后续图片短引用存储断言按新编码核对，实际HTTP图像字节断言仍保留，未将缺图当成功。
- 新增 `pi-upgrade.test.ts`：原生v3会话自然读取且不重放写入、外部扩展/MCP不执行、系统section和工具增删被正确传输、摘要输出不超过宿主上限、工具参数走SDK解析。
- `tests/fixtures/pi-upgrade/` 的短fixture由升级前实际0.85.1 AgentSession和受控query生成，两次回复、一次真实临时文件写入；仅把cwd改为占位符。测试依靠1.4.0自身SessionManager读取，没有增加数据迁移器，也不承诺所有历史环境回退兼容。
- 主工作区的类型检查、构建和隔离Electron `S0-UI-007`通过；软件/质量/恢复/预算相关回归最终结果见下方收口记录。
- 第一轮广回归为67文件通过、1文件失败（371项通过、5项失败），不是全绿。预算停止用例超时后污染同文件父循环上下文；新增定向反例确认根因是新版错误响应也触发finishTurn，适配错误地进入完成审阅。修复后5文件38项（含整个预算停止文件）通过，未放宽超时、预算或验收。保留 `regression.log`、`finish-turn-before.log`、`finish-turn-fixed.log`。
- 另有实际Electron主进程执行Pi适配的测试：真实加载三个1.4.0包，以受控query完成两轮、一次临时文件写入，核对系统提示和工具声明；不是只看renderer启动。`electron-runtime.log`通过。金额、请求账本、生产预算和steer的6文件73项也通过。各轮重叠，最终不累加。

本批只证明上述本机工程范围，不证明真实模型生成质量、速度、费用改善，也不是安装包/干净机器验收。用户现用实例没有被重启；使用新构建需正常重启后核对运行身份。

## 收口记录

最终同一轮扩展回归 **75文件 / 451项全部通过**，无未处理错误，见 `final-regression.log`（419.64秒，两个worker）。范围是software、Pi、架构、本机HTTP/SSE、实际Electron及请求/金额/生产预算/steer/委派预算，不称全仓全部测试。`types-final.log`、`build-final.log`、`electron-final.log`通过，主bundle动态 `__require(` 调用为0，文档检查和本地链接检查通过。

依赖树和lock差异已保存为 `installed-tree.json`、`lock-delta.json`。未更改用户原有生产流程文件，hash保持 `53c7abb3aef8497d8b0522b8aab806c82b2ec164`。未push，未执行付费模型测试；不把本次升级理解成无条件自动更新所有依赖。
