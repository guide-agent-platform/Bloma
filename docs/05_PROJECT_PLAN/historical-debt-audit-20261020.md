# 历史债专项排查（2026-10-20）

> 状态更新：下文保留修复前的审查证据；用户随后授权的代码删除、修复及本机项目清理已实施，结果、保留边界和剩余治理项见[清理实施记录](hardcoding-cleanup-execution-20261020.md)。原文“未执行”只描述审查阶段。

基线：`ab08c3dddf488dd0b6b9d9d6ec77433a50ef60ef`；产品源码与上份硬编码审查基线 `800d4a6` 相同。本轮按用户“历史债也排查”的要求继续检查，没有把“历史遗留”当作豁免理由，也没有直接删除旧文件或复活退役功能。

**结论：历史债确实存在，部分仍影响当前生产路径。最需要先修的是启动恢复沿用 Web 产物判据，以及旧提 PR 工具的文件选择边界。** 本文登记14组：P1两组、P2十组、P3两组。优先级包含维护和能力治理事项，不表示14组都是已发生的线上故障，也不应与[硬编码审查](hardcoding-audit-20261020.md)的9组机械相加。

## 证据方法与覆盖

- 使用 esbuild 对四个生产入口执行内存构建，`write:false`，没有覆盖 dist/dist-main：`main/index.ts`、`preload/bridge.ts`、语音worker、`renderer/main.tsx`。
- 对355个应用JS/TS类文件（不含模板目录）检查模块依赖、类型依赖、打包输入及实际输出字节；另追踪脚本入口和字符串资产引用。主进程构建258个输入，preload 2个、worker 1个、renderer 2259个（后者包含依赖及资产，不是本项目源码文件数）。
- 22个文件未进入这四个入口的打包输入。经进一步核对，分为12个未接应用运行消费者的模块、4个正常的实验CLI模块、2个旧UI组件、3个类型/声明文件和1份旧Vite配置。**没有把这22个文件一律判为可删除。**
- 另外使用TypeScript语义诊断检查未使用声明，检查83个scripts/bench脚本的静态相对导入，阅读旧Web恢复、旧检索CLI、模板、开关、自动化脚本、测试和文档。
- 真实项目存储/快照/恢复反例只在新建临时PROMA_HOME运行。没有执行真实用户项目、读取真实凭据、发模型请求、push或建立PR。

## P1：仍有现实影响的遗留行为

### D01 · 当前桌面项目仍经过只认Web入口的启动恢复

接线：`main/index.ts:145`、`:203`实际调用 `reconcileInterruptedProjects()`；`main/project/recovery-service.ts:133`按current_stage选择中断项目，`:150`判断磁盘、`:154`恢复健康快照，`:166`收敛阶段。

产物判据在 `recovery-service.ts:65`，只检查根目录 `index.html` 和 `src/app.js`。当前Python/WebView2骨架使用 `app.py`、`ui/index.html`、LAUNCH及桌面业务证据；恢复逻辑既不按template_type/desktop_phase分流，也不识别这些桌面入口。

两个**真实本地文件与存储**反例已复现：

| 临时项目 | 实际结果 |
| --- | --- |
| desktop_tool，desktop_phase=desktop-implement，current_stage=generating_mvp；已有app.py、ui/index.html及LAUNCH | current_stage被改为clarifying，desktop_phase仍为desktop-implement，形成状态口径冲突 |
| 同类桌面项目有一个旧健康快照，当前app.py已有更新 | 启动恢复执行snapshot_restored，把更新实现替换为旧快照中的app.py，随后仍收敛到clarifying |

这里没有用真实Python进程证明样例业务完整，只证明**当前恢复机制因为不认识桌面入口而错误选择恢复/降级**。不是已经证实用户现有项目发生了代码丢失；全部反例目录均隔离并已清理。

建议：按产物类型拆分恢复适配器。桌面项目保留中断阶段和现有源码，依据桌面入口、声明与证据状态决定“待继续/待验证”，不能仅因没有旧HTML入口自动回滚。旧Web项目继续使用原有兼容判据。建立“桌面实现中断重启”“健康快照较旧但当前源码存在”的正式回归，覆盖状态、源码和数据保护。

### D02 · smart-pr的实际提交范围大于它宣称的范围

位置：`scripts/smart-pr.mjs:17`、`:49`、`:53`、`:72`、`:150`。

头部承诺只提交main/renderer/shared已跟踪修改和新增测试，但 `classifyChanges()` 把除少数排除项及固定TOOLS_GLOBS外的所有git状态都归入codeChanges；`collectFiles()`原样选择，实际提交用 `git add -- ...files`。没有检查tracked/untracked、允许目录或测试扩展。`'*.log'`也只是字面字符串，没有glob语义。

用**原始筛选函数和合成git status**复现：`docs/private-notes.md`、`.env.local`、`outputs/user-data.json`和`new-script.mjs`全部进入默认提交集合。没有读取这些真实文件，没有调用git add/commit/push，也没有触碰GitHub凭据。

此外，`--dry-run`的PR路径仍先调用 `getGitHubCredential()`，之后才判断dryRun（`:90`附近）；即便不提交也要求读取凭据。脚本还把commit、push、建PR串成一个默认动作，不能等同于当前“commit与push分别授权”的工作约定。

建议：先形成明确文件清单，按目录、跟踪状态、文件类型和敏感文件规则准入；预演不读凭据；提交、推送、建PR分为显式动作。固定repo名不能替代对实际remote的核验。保留历史调用说明时注明其适用版本。

## P2/P3：失效工具、无效控制与迁移债

### D03 · 经验库脚本仍依赖已删除的运行模块

- `scripts/harvest-references.mjs:22`导入无后缀的 `./lib/experience-ledger`，实际文件是`.mjs`；按其文档中的直接Node入口执行，模块加载就报 `ERR_MODULE_NOT_FOUND`。已实测，失败发生在任何业务、检索或模型调用之前。
- `harvest-references.mjs:29`和`backfill-error-cards.mjs:41`仍把 `main/experience/types.ts`作为esbuild入口，该文件不存在。
- harvest的loadTypes返回`{mod, cleanup}`，main却解构`{T, cleanup}`；只补导入后缀和文件路径仍不能恢复完整链路。
- `gap-report`、迁移脚本及sidecar账本薄层还保留经验卡治理，但当前main中已没有对应经验库消费模块。工具能写账本不等于产品会使用它。

建议：先明确这些工具是冻结研究资产还是继续支持的功能。前者移入有版本说明的归档工具区，拒绝对当前home执行迁移；后者必须按现行领域模型重新接线，并做入口级测试。不能只补一个缺文件来制造“已恢复”结论。

### D04 · 旧检索原型与现行实现共用缓存，但schema和隔离能力不同

位置：`scripts/session-recall.mjs:47`、`:69`、`:113`；现行 `main/agent/loop/session-recall.ts:79`、`:122`、`:245`；新重建工具 `scripts/recall-rebuild.ts`。

原型只认Proma旧消息`{type,message.content}`，现行实现兼容Bloma的`{role,content}`，过滤宿主轮，记录schema_version=2和项目归属，并在消费时处理作用域与撤回。二者都写 `.session-recall-index.json`，旧脚本直接写旧格式，无原子替换和版本字段。

隔离实测：现行索引读到1条现代消息 → 运行旧CLI `--rebuild` → 同一缓存变为无版本、0条消息 → 现行构建器检测旧版本后重新得到1条。**新版有版本校验，未观察到旧缓存永久污染新版检索**；问题是旧工具的假空结果、共享缓存降级和重复重建，并且旧CLI本身不提供新版消费过滤。

建议：CLI复用现行索引/搜索接口，要求显式home和查询作用域；如必须保留原型，使用独立缓存名并标明历史schema，不再操作生产缓存。

### D05 · 开关状态能为真，但对应功能没有运行消费者

`main/platform/shell/experiment-switches.ts:19`仍把BLOMA_CONTEXT_PACK登记为“变更轮task头注入”。`readExperimentSwitches()`只读env，不检查功能是否挂载。已实测：设置为1后出口显示true，但context-pack模块不在任何应用入口构建中，源码也没有调用appendContextPack的生产消费者。

同类无运行读取路径的env包括：BLOMA_PLAN_LEG、BLOMA_MEMORY_DISTILL、BLOMA_EXPRESSION_LAYER、BLOMA_RULES_REGISTRY、BLOMA_DELIVERY_STATUS、BLOMA_REPAIR_SCOPE/BUDGET/TURNS。它们位于未接消费者的模块中。`p3-task-contract-switches.md`仍描述旧接线和setx后重启观察的方法。

memory-distiller在源码中**已经明确冻结**，这个冻结应保留；问题在于外围的启用说明没有统一清理。registry开关表也遗漏当前桌面/实验的一些真实控制，不能被称为全量功能实况。

建议：诊断区分“环境请求值”“此版本是否支持”“消费者是否挂载”“本轮有效配置”。退役开关明确提示无效果，保留历史实验配置的解释但不冒充当前功能。

### D06 · 12个实现模块只剩库/测试资产，没有应用运行消费者

以下模块经四入口打包和全仓调用核对，均未进入应用运行链：

| 模块 | 当前用途及处置建议 |
| --- | --- |
| agent/loop/loop-planner | 旧计划腿，只有直接单测调用；不要把它的预算当作当前自主调度预算 |
| agent/loop/memory-distiller | 源码已声明冻结的实验库，明确归档，不擅自重新注入 |
| agent/prompting/prompt-expression、rules-registry | 有完整规则与开关，但没有实际渲染消费者；归档旧方案或移除失效说明 |
| coding/context-pack、delivery-status、repair-loop | Web生成链移除后留下的机制库；当前桌面分别有自己的职责上下文、核心交付与修复控制，不应同时宣传两套生效机制 |
| platform/mcp/mcp-manager、mcp-client | stdio客户端/生命周期库有单测，manager没有生产实例化和工具桥接；当前skill-loader活跃不等于MCP服务接线已完成 |
| platform/llm/channel-family | 无运行调用；注释还声称已删除的adversarial-review使用它。当前实验固定V的独立性不能用这个库作证明 |
| prompts/shared | 包含旧纯前端禁网规则，没有调用方；不能因文件名为shared就当全角色共同契约 |
| guide/web-reference-extractor | 六个guide拆分文件仍有未使用import，最终被编译器消除；没有函数调用消费者，不是当前视觉选型管线 |

这是**资产归属债与能力说明债**。默认建议把明确冻结的实验实现与对应测试成组迁往版本化实验区；删除之前检查CLI、迁移和历史报告需要。是否把某能力重新接入产品是单独设计决策，不能以“清历史债”为由自动启用。

### D07 · 模板注入仍计算并测试，但部分结果没有进入实际模型调用

`guide-pipeline.ts:740`构造templateSection、systemTurn和history，`:753`的history未使用；实际在`:759`调用runGuideLoopTurn时只传baseSystem。因此模板澄清切片的计算和构造不是生效接线。

`buildSketchInjection`、`buildLoopInjection`、`buildSkeletonMapInjection`只剩定义/测试，没有生产调用；`templateIfEnabled(point,...)`保留point参数但完全不读它，头注却仍承诺BLOMA_INJECT_*独立开关。`backplanePages`的quick三页限制只在旧草图切片链上。

仍活跃的部分是PRD few-shot和GWT文档类别生成，不能删除整个template-injection模块。建议拆开“当前消费者”和“历史方案”，删除无用构造/失效开关说明，测试对实际query的system内容和实际消费者作断言。恢复旧切片前必须核对它与当前桌面规则的冲突，而不是只把history变量接回去。

### D08 · 拆模块后复制了大量未使用导入，普通类型检查没有检查这项

在原tsconfig基础上**临时**启用noUnusedLocals/noUnusedParameters，按当前源码语义诊断得到 **1127条未使用声明诊断**。这是诊断条目数，不是1127个bug或1127个文件；部分诊断代表整条import。

集中区域：main/ipc 418、main/orchestration 285、main/guide 231。示例：prompts IPC文件保留了项目、会话、渠道、快照、恢复等完整import头，实际只处理4个prompt handler。最高的单文件为sandbox-snapshots 91条、agent-sessions 90条。

普通tsconfig未启用这两项，因此原typecheck通过与本次诊断不矛盾。esbuild会消除不少未使用导入，不应把全部都算作运行时加载成本；现实影响是维护噪音、错误依赖图和“看似已接线”的假象。

建议：按模块职责分批移除，先消除拆分文件复制头，再逐步启用未使用声明检查或增量约束。不能靠关闭更多检查或给每个参数加下划线处理真正未完成的接线。

### D09 · 旧转发层仍在，R9“零过渡桩”检查无法证明它的口号

`programming-orchestrator.ts`、`sketch-engine.ts`明确注明清桩挂账；仍有24和38条应用静态引用。document-engine和guide-agent-service也分别是38和14条引用的转发入口，但后两者可作为有意保留的公开模块门面，不能直接当垃圾。

`tests/unit/architecture/layer-rules.test.ts:140`的R9只匹配正文“过渡桩”，或不超过6行的export-star。当前上述文件分别34、16、7、12行，均不会被抓到。因此测试通过只能证明没有命中该文本启发式，不能证明迁移已完成。

建议：先明确哪些是稳定门面、哪些是待迁移路径；待迁移项通过真实路径/依赖登记治理，分批迁移消费者和vi.mock。不要通过换措辞、加注释行数来“满足架构”，也不要重建另一条机械行数门禁。

### D10 · 本地提示词覆盖长期优先，缺少覆盖版与内置版的迁移关系

`prompt-config.ts:28`～`:58`按文件存在即整段替换。临时反例确认：覆盖内容不变时，BUILTIN_V1换成BUILTIN_V2不会改变有效内容。这个优先级是明确设计，不是加载器故障；历史债是没有base版本、差异合并或“基底已更新”的状态表达。

只读核对默认 `C:\Users\17359\.proma\prompts` 仍有guide-system.md、prd-system.md，以及不被加载的sketch-system.md.retired-20261005备份。**没有据此判断当前运行实例必用这个home，也没有宣称两个覆盖文件内容错误。**

当前代码已经有loadPromptWithSource/describePromptSource和请求哈希，不应重复报为“完全没有来源追溯”。建议保留用户覆盖，增加基底版本与差异审查，先把已采纳规则归并到版本化默认，用户偏好作为明确增量。重置不能自动删除其他用户定制。

### D11 · 历史bench仍按Web和旧事件估算质量

`bench/harness/collector.mjs:17`固定workspace；`:146`读取test-report；`:241`源文件采样扩展名不含.py。metrics仍消费mvp_delivered/test_completed及关键词AI指标，未按当前CORE_CHECK、core-verification、桌面阶段和实际模型角色建立同版本映射。

这套bench有自己的历史样本和目的，并非本次六组实验报告的权威入口；不能直接改其口径后重算旧结论。建议标注legacy-web schema，为当前桌面实验另建版本化适配器，保存数据源和缺失字段；现行dispatch-experiment-report/aggregate继续保留。

### D12 · P3 · 旧Web生成资产与当前模板共装，退役边界不清

`project-templates.ts:296`的loadSkeletonTemplate和`:349`的loadRealScaffoldTemplate已无应用生产调用，real-static/real-fullstack/web-fullstack骨架及其说明仍在模板目录，build:main会整目录复制。

其中desktop-tool.md仍写index.html唯一入口、localStorage持久化；game.md仍称产物为Web全栈。这些完整旧规则**没有据此被认定都进入了当前桌面system**：PRD只取few-shot，旧实现切片没有消费者。风险在未来误复用、错误修改位置和安装包混装。

建议按“当前桌面资产”“旧项目查看/导出兼容资产”“冻结实验资产”区分打包清单和文档。旧Web项目预览服务器、导出脚本可能需要部分资产，先做读取/导出回归再裁剪；不能把整个HTML预览系统删掉。

### D13 · P3 · 旧UI组件、第二份Vite配置和字体引用未一起收口

- ModeCard、StageIndicator未进入renderer入口；ModeCard仍被旧验收用例直接测试，而当前模式页是ModeSelectionPage。旧组件测试不能作为当前页面行为的全部证据。当前页面已有其他测试，不能说整个模式页没测。
- renderer/vite.config.ts与根vite.config.ts并存：前者端口5174、open:true和React插件；npm命令使用根配置的5173。旧配置没有当前启动消费者，可归档，避免从不同cwd启动得到不同结果。
- renderer/index.html仍引用Google Fonts，tokens使用Inter/Playfair；主窗CSP的style/font及打包态出站白名单没有放行这些来源。策略存在冲突，字体实际视觉结果本轮未开GUI验证。建议内置许可明确的字体或明确使用本地回退，不能为旧字体链接放宽全局网络保护。

`ChatPanel-sprint2.tsx`和`atoms-sprint2.ts`虽然名字旧，**仍被App、聊天、权限、设置等实际调用**，不属于可直接删除的旧副本。可在单独迁移中按职责改名，不能只凭sprint后缀判断。

### D14 · 文档、注释和检查脚本没有统一表达“历史版本”

- architecture.md仍为2026-07-10确认版，描述旧Web生成/SDK重试；伪代码索引仍以afbfda79和0c3230b为锚，不能作为当前路径/接线事实。
- 自动化README仍称channel-key-reader.cjs“不进仓库”，但git ls-files确认它已跟踪；文档的权限/提交约定也不同于当前工作约定。
- test-legacy.ts头注称writeTestReport已退役，文件末尾却保留这个写函数；EntryFingerprint接口还重复声明。旧名称的模块应明确只读兼容边界，不能靠注释声称不存在写侧。
- `npm run docs:check`本轮通过，但该脚本只检查一组IPC名存在和IPC调用没有内联字符串，**不检查文档链接、源码路径或功能接线**。不能把通过结果说成架构文档已同步。

建议：指定当前架构/能力索引及verified_commit，旧文档加历史范围和替代入口；对引用的本地源码路径、CLI入口和运行消费者增加相应检查。原始实验报告保持其原时间/版本，不覆盖成今天的状态。

## 必须保留：不属于“发现旧文件就删除”

| 对象 | 保留理由与边界 |
| --- | --- |
| dispatch-experiment-snapshot/matrix/report/aggregate | 四个模块由scripts/dispatch-experiment-entry.ts实际调用，属于独立CLI，不在Electron主bundle是正常的 |
| 类型/声明文件及类型依赖 | upstream/providers/types、shared/delegation-run-context、renderer/assets.d.ts不产出JS是正常现象 |
| 旧项目只读报告、查看、导出、快照、回滚 | 有数据兼容价值；先分类型修恢复策略，不删除历史项目的数据入口 |
| HTML预览与旧Web服务器兼容 | HTML还服务当前UX草图；旧项目查看/导出与新Web生成是不同能力 |
| 旧渠道/会话索引的一次性迁移 | 共用Proma文件到Bloma独立文件的迁移保护真实数据；删除需证明迁移完成并保留回退策略 |
| 旧tkinter驱动支持 | 对已有产物仍可能需要，不能因新骨架是WebView2就删掉 |
| 已冻结样本、失败证据、验收脚本与哈希 | 是科研数据，不能为清债改变条件、删失败或重写历史解释 |

## 验证结果与处理顺序

本轮独立于上份审查：

- 生产四入口内存构建成功，未写构建产物。
- 相关现有测试15文件157例通过，退出码0。含启动恢复、架构、开关、模板、MCP、检索、记忆可达性、提示词、旧计划/修复/交付机制；**包含死模块的单测通过，不等于生产接线存在**。
- 临时反例1文件5例通过：桌面重启阶段误判、真实快照覆盖更新源码、旧CLI改写索引、空开关、覆盖基底升级不可见。通过表示成功观察到上述行为。
- smart-pr原始筛选函数在VM内用假git状态复现越界选择；harvest用真实Node模块加载复现ERR_MODULE_NOT_FOUND；没有执行smart-pr main、凭据读取或远端动作。
- 额外TypeScript检查得到1127条未使用声明诊断；这是临时诊断选项，未修改tsconfig，不能称为当前正式typecheck失败。
- docs:check通过，但范围仅为上述IPC检查。本轮未运行全量单测或Electron GUI，也没有新模型/耗时/费用结果。

临时审计脚本初次缺少WebP资产loader、路径归一化及VM的cwd替身，均属审计夹具修正，不作为项目缺陷；最终产物保存在 `run-artifacts/historical-debt-audit-20261020/`：reachability.json、unused.json、tool-imports.json、tool-counterexamples.json、reproductions.json及测试日志。没有读取真实缓存或迁移用户home。

处理顺序建议：

1. **立即修复D01/D02**，与上份H01/H03/H07一起处理实际恢复、控制权和凭据/发布边界。
2. 修复/归档D03/D04失效CLI；D05用功能挂载状态替代纯env“已开启”声明。
3. D06/D07明确哪些实验库归档、哪些能力需单独设计；不要为了消除无调用记录而把旧规则接入当前流程。
4. D08/D09按职责完成导入和转发迁移；D10建立覆盖基底关系；D11单独版本化桌面指标。
5. 最后清理D12/D13混装资产与旧UI配置，更新D14权威索引。每批做对应路径回归并独立提交，影响实验条件的源码另行封存运行副本。

本轮交付为审查与具体处置清单，**没有自动执行以上产品修复或删除**。
