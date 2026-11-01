# 模型窗口、主动技能与点选纠错

日期：2026-11-01（Asia/Shanghai），起点 `91f20be`。用户要求1M级上下文、Agent主动触发技能，并恢复点选纠错；沿用不调用付费模型、不push的边界。

## 第一批：模型窗口与主动技能

- 用Pi 1.4自带的本地模型目录，按**真实端点origin和精确模型ID**识别容量。DeepSeek官方`deepseek-flash`及智谱官方`glm-5.3`自动采用1,000,000 tokens；未知代理不凭模型名猜测，仍保守回退。渠道设置的模型行新增可留空的窗口覆盖，代理可明确填1000000；存储/主路/回退/委派均传递绑定到对应模型与origin的声明。
- 压缩预留按实际输出需求计算，正常16k输出时1M模型保留25600 tokens，避免仍在约100k处提前压缩。输出仍服从模型上限和原请求/费用守卫。
- 能力容量和金额预留是两回事：已有金额策略的输入预留较小时，仅限制本次有效窗口，记录capacityWindow和reservationLimit，不自动扩大预算、重写策略或新增费用责任。
- 官方查证：[DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/)、[GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)。目录来源属于发布能力信息，不是本轮实发1M输入验收。
- 复用Pi的`loadSkillsFromDir`与`formatSkillsForPrompt`，向Agent展示已安装技能的名称/描述，Agent自行使用`list_skills`和`read_skill`按需读取正文及相对参考资料。用户无需写`/skill:`；手动指定仍可用。默认不把所有技能正文塞入提示。
- 主动读取限于项目`.bloma/skills`及宿主skills目录内的已发现技能；不加载任意扩展/MCP、不授予额外执行/写入权限，尊重`disable-model-invocation`，拒绝跨目录与运行中变更的技能。C/V专用审阅会话不自动继承制作方技能。评测身份记录技能目录摘要，具体读取留在工具轨迹。

验证：13文件130项通过（`run-artifacts/context-skills-regression.log`），涵盖模型目录、代理覆盖、原金额预留、实际Pi在300k usage下不提前压缩、无slash命令的主动技能选择/读取、角色隔离、参考资料边界、渠道保存、回退、预算停止、Pi/图片及架构。类型、构建、隔离Electron启动通过，日志前缀`context-skills-`。均为本机受控测试，不声称真实1M调用或模型选技能质量已验证。

第一批提交：`9b7594a`。

## 第二批：恢复当前流程的点选修改

- 交付面板顶部提供明确的“点选修改”，覆盖Electron和浏览器产物；展开后定位到点选面板，切换项目重置展开状态。草图按钮也统一为“点选修改”。命令行等无界面程序仍不宣称支持点选。
- 浏览器修改预览复用既有受管进程、Playwright与独立试用的端口分配逻辑，使用独立端口、profile和数据副本；不接管或停止用户已经运行的程序，不为硬编码端口改写业务源码。原生Electron路径继续复用。
- 数据复制复用已有一致性检查，拒绝保留指向原数据的链接。真实测试证明预览副本内写入不影响原数据，原程序仍运行，源文件指纹不变。
- 制作中已有固定试用版本也可点选：使用现有候选读取/完整性校验，而非将其当作“已验收发布”。只能选择当前用户试用记录绑定的版本；工作区继续编辑甚至启动声明暂时损坏，不会让点选落到另一版本。
- 试用版本随持久纠错提交箱、失败恢复和composer提交metadata传递，后续制作沿现有试用反馈路径解释。没有放宽最终交付检查。
- 草图反馈改走现有composer持久接收通道，检查消息来自当前iframe；未接收/中断时保留选区，同一提交重试复用id和原内容，后来新增选区不会被旧提交清空。没有新增“自动确认”模型调用。

验证：初轮发现试用候选误用已验收发布读取器（`RELEASE_NOT_VERIFIED`），已改用现成的候选接口，失败记录保留。随后13文件58项通过（`point-correction-final-tests.log`），覆盖真实浏览器/Electron点选、独立试用、源码/数据保留、提交恢复、草图来源/重试与架构。再补真实交付IPC验证：工作区声明损坏时仍正确暴露用户所见候选的点选版本；相关4文件21项通过（`point-correction-ipc-final.log`）。这些轮次重叠，不累加成全仓总数。

已查看 `run-artifacts/correction-browser-20261101.png` 的实际选区和操作条。类型、构建与隔离Electron启动通过（`point-correction-types-final.log`、`point-correction-build.log`、`point-correction-electron.log`）。UI发送使用受控接收器；未进行真实付费模型的“意见→代码修复”质量验收，不把机制测试说成模型成功率。

两批均未push、未修改真实用户渠道/项目数据/金额策略，也未重启用户当前Bloma实例。用户原有 `production-workflow-v2-20261020.md` 两行修改保持未暂存，hash为 `53c7abb3aef8497d8b0522b8aab806c82b2ec164`。新构建需正常重启应用后加载。
