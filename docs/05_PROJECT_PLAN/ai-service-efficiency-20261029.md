# 通用AI服务模板与生成效率支持

起点 `ac2b62e`。用户同意组件复用、统一诊断、按改动范围验证方向，并提出通用AI服务模板。首批将已有文本/视觉客户端收敛为产品自有模板：可编辑公开路由、运行时产品Key注入、统一文本/图片调用及错误、本机契约验收。Agent填写协议/地址/模型及业务调用，真实Key由产品用户或产品密钥存储提供，不复制Bloma渠道配置，不把Key写入工程模板。

同时提供有界诊断现场读取、源码静态影响候选，帮助开发定位/选测；不把候选当成测试通过，不跳过正式交付门。无付费调用，不修改真实用户产物/渠道/账本，不push。

复用现有HTTP连接器、视觉输入处理、能力物化和宿主探针；核对Proma上游 `bf3e98c` 的协议适配/脱敏原则。使用OpenAI Docs核对[聊天兼容消息格式](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)，Anthropic格式沿用当前供应商适配。首批明确支持openai-chat与anthropic-messages，不宣称单一URL适配所有供应商、Responses、流式响应或工具调用。

## 现在怎样使用模板

`prepare_software_capability({capability:"ai"})` 物化Node产品组件：`ai_service.cjs`、`ai_routes.cjs`、`ai_secrets.cjs`、`AI_SERVICE.template.json` 和现有HTTP连接器。使用说明见 `read_production_context(ai-service)`，组合参考见 `components`。目录和准备不发真实模型请求。

Agent填写公开模板中的protocol、endpoint（含版本路径的基地址）、model、api_key_env及输出参数。默认模板地址和模型为空，不会自行选择付费供应商。配置最多16条显式路由；未知路由不回退，失败不自动重试或换付费路由。API Key字段禁止写入公开路由，APP_*只表示产品自己的Key引用，不读取Bloma渠道或ANTHROPIC_AUTH_TOKEN等平台变量。

产品用户可在生成软件的设置界面输入自己的Key和路由；Agent复用后台接口接入该产品的UI，不统一覆盖产品外观。核心调用例如：

```js
const {AIService} = require('./ai_service.cjs')
const ai = new AIService({resolveKey: name => productSecrets.get(name)})
const result = await ai.generate({route:'default',prompt,images,dataDir:process.env.APP_DATA_DIR,signal})
```

`settings(dataDir)` 返回公开路由和revision；configured只表示地址/模型已填，不表示Key、连通或效果通过。`saveSettings(dataDir,routeDocument,expectedRevision)` 用锁、fsync和原子替换保存公开运行配置 `APP_DATA_DIR/ai-service.json`，覆盖工程默认但不改模板；拒绝陈旧写入和额外api_key字段。锁冲突/中断留下的锁须产品核对，不自动抢锁或覆盖不明状态。

Key可只保留在产品后台内存，也可用 `createSecretStore` 对接产品自己的可信OS/keyring加密器；例如Electron safeStorage须先确认加密可用并绑定encrypt/decrypt回调。无codec或误用原样编码时拒绝落盘，没有明文fallback；helper本身不能证明注入的codec安全。get只供后台resolveKey调用，不应通过IPC向renderer回传Key。模板不自动透传宿主APP_*环境，服务型产品可自己启动时注入。Key不得放入发布工程；运行数据/密钥随产品自身数据策略维护。本批没有新增实际产品的完整设置UI。

文本/图片使用同一 `generate`，旧 `VisionClient.analyze` 作为薄兼容入口保留。首期openai-chat使用Bearer及chat/completions，anthropic-messages使用x-api-key/anthropic-version及messages；图片分别采用image_url或base64 image块。支持一个用户prompt、可选system和有界输出；max_tokens与max_completion_tokens按模型/协议配置。不实现SSE、Responses、多轮会话、工具调用、结构化输出强保证或自动供应商探测。Python旧客户端保持兼容，未声称已经迁移为Node模板。

宿主Node探针新增protocol声明身份，检查实际路径、鉴权头、消息体、错误和换图；OpenAI与Anthropic文本/图片四种组合分别验证。旧文本无protocol声明的配置/计数语义保留。准备和本机探针不等于真实供应商/模型质量或完整业务通过。

## 另外两项效率支持

- `read_production_context(diagnostics)` 一次汇总当前源码、执行/交付状态、本会话未决命令、本会话调试截图与近期观察、校验过哈希的历史验收失败及案例。文本有界并脱敏；未知根因保留unknown，损坏/未完成记录不当作通过；历史记录标明未重验，不生成新PASS或写预算。
- `inspect_repository({mode:"impact",paths:["src/changed.ts"]})` 对JS/TS/CJS/MJS静态相对导入做反向传递定位，给出开发期测试候选，支持已删除的被引用文件。最多扫描1500个代码文件/16MiB，单文件2MiB；动态导入、未解析引用、跨语言/缺失输入与超限明确partial。不解析所有别名、包导出、模板/数据和外部行为。无命中不能解释为无需回归；它不执行测试，也不修改正式交付必需检查。

这些是复用/定位/选测支持，没有测出生成速度提高多少；未来固定任务应比较首次可试用、设施排障、重复验收耗时、请求和独立缺陷，不以测试数或新增模块数量推导收益。

## 本次验证

日志在忽略的 `run-artifacts/ai-service-efficiency-20261029/`，全部为隔离工程、实际Node/GUI/本地HTTP或受控替身，没有付费请求、真实账号变更、账本重置或用户应用重启。

- 首轮3文件10项中9通过，新增诊断测试误以为只读预算snapshot已经落盘，ENOENT在预期断言前失败（tests.log）。修正为显式建立隔离计量fixture，再验证读取后字节不变；2项复验通过（context-recheck.log），未改变产品读取行为。
- 两协议×文本/图片4组固定候选均通过宿主实际HTTP探针；运行时路由选择、Key轮换和重开、公共配置无Key、未知/坏路由拒绝、公开配置CAS保存、密钥adapter拒绝明文均覆盖。密钥持久化使用测试自建AES-GCM codec，证明接口与非明文保存，不冒称真实OS keyring验收。既有视觉入口及换图反例继续通过。
- 诊断测试保留unknown及历史身份，拒绝坏凭据，脱敏且不改隔离计量字节；静态影响测试找到间接测试，包含删除文件，动态/跨语言标记partial，拒绝越界路径；没有据候选跳过正式验收。
- 最终 `closure.log` 为 **10文件40项一次全部通过**，包含AI模板、诊断/影响、旧视觉、HTTP、语音/OCR、仓库定位、工作摘要、旧文本探针以及真实Electron/浏览器正常入口与重开。中间regression.log也为40项通过；复跑重叠不相加。
- 类型检查（types-last.log）、完整构建（build-last.log）、文档检查（docs.log）与diff空白检查通过。源码清单scope v13覆盖850个源文件、98个重点模块，重新生成和 `--verify` 通过（source.log / source-verify.log），未解析相对引用为0。不声称全仓、真实供应商或干净机器交付。

新工具和组件说明需主进程正常重启后加载。已有产物和旧组件不自动改写升级；代码冲突保护保留，公开模板字段可编辑但须符合schema。用户原有生产流程文档两行修改保留，不纳入提交；只本地提交，不push。
