# 多模态与外部集成：首批

用户优先多模态和外部系统集成，明确首批为通用HTTP API／Webhook。起点 `a02524a`。沿用现有能力准备、产品组件、命令监管和宿主验收；已有语音复用保留。

计划：

1. 本机图片OCR：产品Node桥接Windows自带OCR，探测实际可用语言，识别产品数据目录内的图片，返回原图摘要、行和文字位置。不下载语言包、不请求视觉供应商；缺语言或引擎明确阻塞。首期不声称图像语义理解、手写准确性、视频或跨平台能力。
2. 通用HTTP：产品独立JSON客户端，固定来源和允许方法、产品自有鉴权、DNS出口检查、有界响应、总超时/取消、结构化错误。写操作须产品显式配置，失败不自动重放。不继承Bloma渠道密钥，不对真实账号写入。
3. Webhook：提供原始字节HMAC校验与时间窗口检查，辅助应用实现重复通知去重；明确它是接入辅助组件，不是自动公网托管、OAuth或第三方协议通吃。
4. 将准备和使用说明接入现有能力工具/目录。在本机真实OCR与本地HTTP服务验证，保留发布候选、语音、文档与验收边界的相关回归。只本地提交，不push；真实外部效果/付费模型测试另行取证。

核对本地Proma上游 `bf3e98c`，未找到可直接复用的产品OCR或HTTP连接器。参考现有语音产品桥、资源准备方式和上游凭据脱敏原则；依据[Windows OCR文档](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine)、[Node HTTP](https://nodejs.org/docs/latest-v22.x/api/http.html)及[Crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html)实现适配，不更换执行引擎。

## 已实现的首批入口

- `prepare_software_capability({capability:"ocr"})` 物化 `ocr_runtime.cjs` / `ocr_worker.ps1`，探测Windows内置OCR和实际语言列表；可指定列表中的language，缺语言返回environment_blocked，不安装系统语言包。当前本机实测只有 `zh-Hans-CN`。产品后端 `recognizeImage(file,{dataDir:APP_DATA_DIR,language,signal,timeoutMs})` 识别PNG/JPEG/BMP，返回原图SHA-256、尺寸、行、词框、实际识别语言和recognized/no_text。
- OCR上限16MiB、引擎实际最大图像尺寸、单次最长60秒、输出上限2MiB；请求文件在产品数据目录内唯一创建并清理。桥仅启动自有Windows PowerShell进程，无子进程命令，使用execFile总超时及AbortSignal。不调用视觉模型、截图用户桌面或打开摄像头。图片解析与OCR仍是原生运行时行为，限额不构成OS沙箱。
- `prepare_software_capability({capability:"http"})` 物化 `http_connector.cjs` / `webhook_inbox.cjs` 并检查Node模块加载。准备不访问服务、读取账号或获取凭据。旧默认speech、documents依赖准备、父负责人权限及已有冲突文件保护保留。
- `read_production_context(multimodal / http-integration)` 和能力目录、实际制作指令已接入使用说明。ocr/http仅是准备工具选择器，没有放松需求能力标签或新增自报通过的验证器。

## HTTP与Webhook边界

客户端默认GET、HTTPS公网、固定来源，公共DNS答复检查后固定至同一连接；拒绝私网/回环/已列出的保留地址，拒绝重定向，响应以流式方式限制2MiB，总时限覆盖DNS/连接/读取。显式 `network:"loopback"` 只用于已指定的本机服务。非2xx不返回错误响应体，401/403、429、重定向、超时、取消、坏JSON及响应过大分别返回状态；429可给出有界retry-after，不自动重试写操作。产品须自己验证业务字段、权限与实际效果。

凭据通过产品自有配置传入内存，不读取Bloma渠道或平台密钥，不自动创建账号配置页/OAuth。默认方法不含POST等写操作；产品确认实际业务授权后才配置写方法。本批没有接通任何真实账号、第三方付费API或模型供应商。

通用Webhook约定为 `HMAC-SHA256(timestamp + "." + rawBody)`，签名为 `sha256=` 加小写hex，时间窗±300秒，密钥至少16字节；当前时间由本机产生，忽略调用输入伪造的nowSeconds。它不是GitHub/飞书/Stripe等供应商协议适配。应用在签名覆盖的负载中取eventId，多来源时使用可信连接器身份作前缀；不能拿未签名的投递头冒充业务身份。

收件箱先排他创建并fsync持久化pending记录，再允许业务执行；成功后标done。相同事件ID重复pending/done均拒绝自动执行，相同ID不同负载冲突，损坏记录保持错误，1万记录满额不静默遗忘去重。原始内容与密钥不写收件记录。崩溃留下pending必须核对业务是否提交；收件记录和外部业务存储不是一个事务，**不承诺跨系统恰好一次**。公网入口、TLS终止、供应商重试策略、OAuth与业务撤销仍需服务专用适配。

## 验证与观察

`run-artifacts/multimodal-http-20261029/` 保存本机日志和固定输入结果，均为隔离工程，无付费模型请求，不修改真实用户项目/渠道/账本，不重启用户Bloma。

- 初始图片“外部集成测试 7263”真实识别为“夕 卜 部 集 成 测 试 7263”，首字被拆分。此观察保留为识别质量边界；不宣称中文通用准确率。后续固定清晰印刷图“集成测试 7263”经去空白核对全文成功，保留真实词框与原图摘要。空白图为no_text；损坏图片、越界路径、缺语言和取消均验证拒绝。
- 第一次原型因受控进程环境中没有Get-FileHash命令失败，改用.NET SHA256对流取摘要后通过，未修改机器模块或环境。真实OCR在封存候选的正常Node入口运行，不用固定文字替身。
- HTTP使用真实本地HTTP服务：鉴权/中文JSON GET和POST、配置快照、默认拒写、跨来源拒绝、401错误体隔离、429、拒跳转、非法/超大响应、204、总超时和取消；DNS替身只用于控制答复，另实际连接localhost验证校验后的固定答复仅查询一次。没有真实公网TLS或第三方业务验证结论。
- Webhook使用真实HMAC字节：篡改、过期、未来时间和伪造当前时间拒绝；收件箱在重开后保留pending/done去重，拒绝事件ID冲突、坏凭据和损坏记录。未注入真实断电，不把fsync/重开测试当作跨存储原子性证明。
- **组合链路**：封存产品中的真实图片OCR → 产品客户端POST至本地受控API → 同一签名通知接收两次。API请求1次、业务效果1次、第二次duplicate_done；输出在 `workflow.json`，真实OCR在 `real-ocr.json`。这是手写固定后端的组件接线验证，不是模型自主生成、UI完整验收或真实外部服务成功。
- 初轮2文件8项通过（tests.log）。扩大8文件57项中56通过、旧测试把ocr当未知能力而失败（regression.log）；将原未知能力样例改为unsupported-provider，仍保留未知拒绝与子任务不能准备的原断言。最终相同范围 **8文件57项一次全部通过**（closure.log），包括原语音、文档、候选发布、独立设计和证据分层；重复检查不相加。
- 类型检查（types-closure.log）、完整构建（build-final.log）、文档检查（docs.log）与diff空白检查通过。源码清单scope v11覆盖841个源文件、90个重点模块，重新生成及 `--verify` 通过（source.log / source-verify.log），未解析相对引用为0。原型图已实际查看，首字拆分结果另存prototype-ocr.json。以上不构成全仓或干净机器验收。

首批能力需主进程正常重启后加载。接下来优先验证真实供应商的字段/鉴权适配与明确授权的集成场景，以及多种真实图片的OCR质量；音视频处理、图像语义模型、OCR替代引擎、OAuth和托管Webhook不在本批完成范围。用户原有生产流程文档两行修改保留，不纳入提交；只本地提交，不push。
