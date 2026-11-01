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

点选纠错正在下一批处理：现有Electron宿主点选和持久提交箱继续复用，补齐浏览器产物及清晰入口，不恢复退役的旧生成流程。
