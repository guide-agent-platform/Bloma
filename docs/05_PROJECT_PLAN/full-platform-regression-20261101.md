# 最终版本全量回归与平台主流程验收

日期：2026-11-01（Asia/Shanghai）。起点`58f6983`，最终受测代码为`995ee2e332e513aeded6422d6878d5e99422bfd3`。本文件是测试结束后的记录，不改变受测应用代码。全程隔离`PROMA_HOME`、原生窗口profile和产物数据，不调用付费模型。

## 最终结果

| 验证范围 | 结果 | 证据 |
| --- | --- | --- |
| 全部unit、integration、regression、acceptance目录 | **332文件、2294项通过；0失败、0跳过、0 todo**，855.54秒 | `run-artifacts/full-platform-20261101/full-final.log`、`full-final.json` |
| 当前构建的真实Bloma界面与产物流程 | **18组通过**；38次本机受控HTTP/SSE请求；0外部请求、0页面异常 | `final-native/ui-1793525512165/report.json` |
| 脚本级Node测试 | 9项通过、0失败 | `script-tests.log` |
| 渠道路由设置 | 6组通过、重启留存 | `final-routing/native-report.json` |
| 长期里程碑、待办与版本 | 6组通过；真实CLI检查；0模型请求 | `final-longterm/report.json` |
| lean-v1及未标记历史项目 | 各4组通过；只读拒绝旧执行，显式复制不继承旧确认/PASS | `final-migration/report.json`、`final-migration-unmarked/report.json` |
| 类型、完整构建、源码清单 | 通过；855源文件、94重点模块，相对导入缺失0 | `types-final.log`、`build-final.log`、`source-final.json` |

上述证据均在本机忽略目录`run-artifacts/full-platform-20261101/`，不上传大型运行样本。不同套件有重叠，不累加成新的成功率。

## 实际走过的主要流程

使用真正的renderer、preload和main，点击正常入口；没有修改项目终态来制造交付成功。模型回复由版本化本机夹具提供，Pi、工具、C/V协议、验证、发布与数据路径执行真实代码。

1. 空渠道提示、渠道设置、1M窗口保存、进程重启后恢复设置。
2. 提问澄清、重启后恢复问题、继续回答、任务单暂停且未确认不制作。
3. 新建快速项目、需求确认、静态草图等待确认、持续Pi制作。
4. 实际C/V材料读取、PNG传输与协议提交，宿主真实GUI检查后交付。
5. 正常启动程序、保存记录、关闭和重开，真实用户数据保持。
6. 独立试用使用另一数据目录，修改试用数据不污染正常程序。
7. 真正点击产物控件、记录意见、提交到Pi修复、重新验证；显式切换试用后看到紫色按钮。
8. 启动上一可用版本，再启动当前版本；分别核对旧/新颜色及原有数据读回。
9. 附件选择与持久接收回执；停止制作确实取消本机HTTP请求，再从普通聊天续跑。
10. 长期项目完成本阶段后等待用户确认；确认发布不另发模型请求。补充检查覆盖待办采纳后仍需新范围确认。
11. 重命名、归档、恢复、导出、导入已有工程、删除工作副本而保留原目录。
12. 完整重启平台，历史项目和对话保留，没有自动恢复模型执行。

原生目录选择对话框返回值被固定为隔离目录，其后导入/导出流程是真实的；没有声称验证OS目录选择器的手工操作。已查看`clarification-restored.png`和`product-current.png`，并核对状态、数据、版本、回执与文件，而非只看截图。

## 发现并修复的问题

- **未交付项目可直接标记完成**：新增负例先复现。完成IPC现在拒绝未交付或归档的快速项目；项目仍有活动运行时也拒绝。返回明确的`PROJECT_NOT_DELIVERED`提示，不制造completed状态或满意度事件。
- **澄清问题只上屏、不落盘**：问题和暂停/失败说明重启后会丢。向导完整消息现只持久化一次，Pi流式消息仍走自己的审计路径；实际重启恢复与后续回答已验证。
- **工作区连接状态被隐藏**：恢复既有连接状态组件，空渠道、已配置与离线状态可见，设置入口保持直达。

修复提交`82eb679`；原生全流程工具、当前协议回归和活动运行完成守卫提交`995ee2e`。

## 初测与夹具修正

初次全量不是全绿：331文件中319通过、10失败、2跳过；2270项通过、20项失败、2项跳过，保留`full-initial.log/json`。

部分失败来自过时的验收协议：旧guide_decide/强制三轮澄清、历史项目直接升级、旧IPC枚举、旧等待文案，以及未提交C审阅材料的崩溃恢复/制作夹具。已迁移到当前短任务单、明确确认门和C/V协议，仍保留失败拒绝、取消、排队、实际持久化、坏产物失败与禁止重放副作用的断言。旧analytics事件不冒充现役写入覆盖，当前消息按会话历史和composer回执核对。

两个初测跳过项已补齐并在最终全量执行：使用现有Electron运行时制作真正可重定位的Calculator.exe夹具；PDF/DOCX测试使用已安装的现代解析库及其正确清理接口。真实Node/Python准备也显式启用，开发PATH移除后仍执行真实命令。

原生驱动开发期间曾错误阻止本机CDP健康检查、读取旧调试端口，以及把“切换当前代码试用”当成同版本重启。失败记录`ui-initial.log`至`ui-r4.log`保留；改为按真实进程就绪条件连接，并通过正常启动入口验证业务重开，不把新试用版本的数据隔离当成产品丢数据。

## 复现

```powershell
npm run build
npm run typecheck
npm run test:fixtures:offline
$env:SOFTWARE_RUNTIME_DOWNLOAD_TEST = '1'
$env:SOFTWARE_PACKAGED_FIXTURE = (Resolve-Path run-artifacts/offline-acceptance-fixtures/calculator).Path
$env:SOFTWARE_DOC_IMPORT_TEST_DEPS = (Resolve-Path node_modules).Path
npx vitest run tests/unit tests/integration tests/regression tests/acceptance --maxWorkers=2
npm run test:platform-flows
node --test scripts/dogfood-card-policy.test.mjs scripts/dispatch-experiment-supervisor.test.mjs scripts/prd-probe-inspection.test.mjs
```

真实供应商模型效果、模型自主选择质量和干净机器安装不在本轮结论中。原有`production-workflow-v2-20261020.md`修改保留且未提交，hash为`53c7abb3aef8497d8b0522b8aab806c82b2ec164`。用户随后明确授权推送，按当前`sprint2`分支执行普通SSH推送。
