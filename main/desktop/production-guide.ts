import { DEFAULT_DESKTOP_EXECUTION_LIMITS, type DesktopExecutionLimits } from './execution-limits'

export function productionGuide(role: 'dispatcher' | 'executor', limits: DesktopExecutionLimits = DEFAULT_DESKTOP_EXECUTION_LIMITS): string {
  return [
    '【制作工作指引 v2】',
    role === 'dispatcher'
      ? '你负责目标、接口、依赖、写入边界和验收引用。先确定最小可派任务，独立工作尽早派出；方法体、逐行算法与全部测试代码由执行者设计，不先代写详细实现再让执行者重复推导。每项任务写清目标、输入/输出接口、验收F/BR/AC编号和写入范围即可。'
      : '你负责本次任务的实现与真实验证。先使用平台已附的关联F规则与验收，保留共同约束；缺少规则、接口或版本事实时用read_production_context补读，不重复获取已附内容。信息不足或矛盾时读完整PRD。接口不清先核对生产者与消费者，不能用默认空值隐藏协议错误。',
    'read_production_context是权威需求只读入口：overview看范围，features按编号读完整规则/场景，prd读正文，verification读通用验证登记；模型/语音业务另查verification-llm/verification-speech。无需为派工提前通读所有源文件与组件手册，不改变已确认范围。',
    '界面实现者先读确认UX及相关组件；核心/存储职责先读业务规则、接口与记录存储，按需要查询界面交互，不强制通读视觉/CSS。现有环境先用inspect_project_resources核实，缺少实际依赖才安装。',
    '【现成平台入口】项目工作根使用相对路径。保留app.py正常启动、from app import Logic门面、--self-check、--drive-port及/eval、/call、纠错协议；修改相关接口前先读现有生产者与消费者。界面使用既有App.call桥和App.show状态反馈，不从草图示意数据生成业务结果。',
    '测试数据统一走独立APP_DATA_DIR，不读取或覆盖项目正常data。已有.venv与00_ENV资格事实优先复用，不因子任务接手重新安装或创建异名环境。只写本次授权范围；共用接口变化和未完成项必须交接给集成负责人。',
    `【真实执行资源】每名执行者脚本累计${limits.script_runs}次、安装累计${limits.install_calls}次，续接不清零；脚本缺省90秒、可显式设置至180秒。剩余额度和验证新鲜度以工具反馈为准，模型轮数由本次委派预算给出。`,
    '逻辑自测与真实GUI业务链分别记录；数据隔离，关闭自己启动的进程。只补失败、缺失或版本过期的证据，不因交接重复全量自测。完成摘要交接：改动文件、接口、真实命令与结果、未完成项/阻塞；自报完成和平台验收分开。',
  ].join('\n')
}

export const PRODUCTION_VERIFICATION_BRIEF = '【核心验证交接】全部已确认功能逐项登记实现状态与需求版本，CORE_CHECK.json统一scenarios并如实区分logic/gui及真实能力；每项有实际业务断言、至少一条真实GUI业务链。测试使用独立数据目录，PASS/FAIL/BLOCKED场景名与登记一致。完整schema用read_production_context(topic=verification)读取，模型/语音专项分别用verification-llm/verification-speech。'
