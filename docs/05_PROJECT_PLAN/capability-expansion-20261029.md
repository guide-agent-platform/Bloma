# 第一轮能力扩展

起点 `c99e7ed`。用户同意优先推进文档／检索组件、独立业务反例和已有工程修改。复用现有 Pi、能力工具、上下文目录、项目导入与宿主验收，不增加强制模型阶段，不修改真实用户产物或账本，不 push。

## 实施与验收计划

1. 文档：提供可物化到产品的 Node CommonJS 组件，使用 PDF.js 与 Mammoth 实际解析 PDF／DOCX，支持 UTF-8 TXT／Markdown。按内容摘要和位置生成来源身份，提供有界字面检索、精确引用核对与明确空文本／损坏输入错误。产品使用自己的依赖；准备成功不签发业务 PASS。首期不含 OCR、向量检索、复杂版式还原或真实 AI 效果。
2. 反例：提供按需读取的业务关系案例目录，覆盖历史题追问、跨资料笔记、伪造引用、搜索状态失效、库存与恢复原子性；每例包含适用条件、操作及可区分正确／错误实现的预期。接入独立设计输入，但不自动增加需求、不把目录读取算覆盖、不发额外模型请求。
3. 已有工程：利用已有导入清单提供当前副本与导入基线的逐文件差异，区别原用户脏状态和本轮副本增量；显示入口、脚本和测试定位，命令按原项目执行。差异不代表行为通过，不写回原目录。

验证使用隔离目录、实际解析库、固定输入、真实本机命令及必要的真实界面。记录测试范围、失败与修复，不把工程样例当成新付费生成成功率。三个代表任务的真实模型对照仍需独立预算授权；本批先完成可重复的工程验证。

## 来源

核对本地 Proma 上游 `bf3e98c` 的 `document-parser.ts`，沿用其 PDF.js `getTextContent` 和 Mammoth `extractRawText` 方式，适配为产品自有依赖与可校验来源块。
参考 [PDF.js](https://github.com/mozilla/pdf.js)、[Mammoth](https://github.com/mwilliamson/mammoth.js)。

## 实现结果

- `prepare_software_capability({capability:"documents"})` 物化 `document_runtime.cjs`，默认不联网安装；显式 `install_dependencies:true` 使用 npm 准备缺少的固定依赖 PDF.js 6.4.299 / Mammoth 1.13.0。保留已有声明版本；非 npm 锁文件交给原包管理器处理。实际 Node 版本须满足解析库要求，当前 PDF.js 基线要求 Node >=22.13.0 或 >=24。测试库作为平台 devDependencies 固定，产品不借用平台解析依赖。
- `inspect_software_capabilities({capability:"documents"})` 返回实际组件/依赖状态；旧无参数检查仍走 speech。准备仅表示依赖与API可用，产品业务仍 unverified。未知参数、已有冲突文件、非父负责人准备继续拒绝。
- 产品后端 `extractDocument(file,{dataDir:APP_DATA_DIR})` 返回原文件内容摘要、PDF物理页码／文本偏移和来源块。`searchDocuments` 是区分大小写的块内字面检索；`verifyCitation` 核对来源、位置与逐字摘录，不以合法ID替代原文验证。不提供OCR、向量检索、跨块短语保证、数学质量或恶意文档安全认证；解析需运行在有超时/取消监管的工作进程中。
- `read_production_context(documents / acceptance-counterexamples / existing-project)` 和能力目录已接入实际执行工具。六类反例也进入新B设计输入；B默认关闭，读取目录不执行案例、不自动加功能、不构成覆盖证据。旧冻结设计不追溯重做，不增加任何模型请求。
- `inspect_repository({mode:"changes"})` 对比不可变导入基线与当前副本，最多内联80项，保留总数和省略数。校验项目身份与基线摘要，支持原目录已离线的情况；原用户脏字节属于基线，损坏元数据不降级为空差异。

## 发布依赖修复

真实库在开发目录通过，但第一次候选浏览器检查无法导入Word。补充同候选的CLI检查复现 `Cannot find module 'underscore'`：依赖快照原先把整份 node_modules 放在裸哈希目录，Node对链接取realpath后缺少名字为 node_modules 的上级查找层。

新Node缓存采用独立布局键与 `HASH/node_modules`，保留完整依赖树及哈希检查；旧裸哈希候选仍可读取，不迁移旧记录或修改旧缓存。新增真实CJS／ESM间接依赖运行检查、开发依赖变化隔离检查、旧布局兼容检查和非法缓存路径拒绝。没有重写Mammoth或把原解析失败改成成功。

## 本次验证与失败记录

全部在隔离home／项目执行，模型响应如涉及B则为受控替身。付费模型请求为0，未修改真实用户产物／渠道／账本，未重启用户Bloma。

- 最初两文件8项中7通过、1个新增测试因临时home漏写host子目录失败；修正测试路径，不改变行为断言。
- `capability-expansion-20261029-tests.log`：5文件40项中39通过、候选Word GUI导入失败。后续 `native-recheck.log` 的补充CLI检查复现上述依赖根因；`native-layout.log` 在修复后定向通过。这些失败与复跑保留，不与最终数量相加。
- 最终 `run-artifacts/capability-expansion-20261029-regression.log`：**9文件55项一次全部通过**。包括真实PDF/中文DOCX/TXT、错误/跨资料/过期引用、输入边界、能力工具权限与包管理器分支、真实候选CLI及浏览器上传/搜索状态/坏文件保留/进程重开、CJS/ESM发布依赖、100条SQLite迁移/恢复回归、真实Electron ASAR物理字节、导入工程修改及原用户Git状态保留、独立B设计及错误预期拒绝。
- 浏览器固定工程共16步，截图已实际查看；`run-artifacts/capability-expansion-20261029-ui/report.json` 和 `gui-0.png` / `gui-1.png`。这是平台组件的工程验证，不是用户学习助手已修复、模型从零生成或干净机器交付。首轮失败报告被后续同名工程报告覆盖，失败回执保留在上述独立日志。
- `capability-expansion-20261029-types-final.log` 和 `capability-expansion-20261029-build.log`：类型检查与完整构建通过。PDF基线夹具产生标准字体路径提示，损坏PDF产生索引修复警告；未将这些提示当作无文本文件成功，也未抑制实际解析错误。
- 文档检查通过。源码清单已更新为scope v10，835个源文件、86个重点模块，重新生成及 `--verify` 通过，未解析相对引用为0。扫描首次把需要搬到产品目录的测试源文件当成仓库内可直接执行模块，报其相对组件不存在；将该夹具明确存为 `.cjs.txt` 原始源资产后重新扫描，并定向复验唯一受路径变化影响的真实产品/浏览器用例通过（`capability-expansion-20261029-fixture-final.log`）。不修改扫描器规则或放宽业务预期；复验与前述55项重叠。

本地日志和截图位于被Git忽略的run-artifacts，不随普通提交分发。新功能在主进程正常重启后加载。用户原有 `production-workflow-v2-20261020.md` 两行改动保留，不纳入提交。真实三任务生成对照、语义检索/OCR和独立机器交付仍待后续批次及相应预算，不从本批工程通过推导收益或成功率。
