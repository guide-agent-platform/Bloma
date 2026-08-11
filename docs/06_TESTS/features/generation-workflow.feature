Feature: 草图与 MVP 生成主链路
  作为零基础用户
  我希望只用自然语言描述想法
  以便系统先生成可看的草图，再生成可运行的 MVP

  Background:
    Given 用户已经进入软件生成工作区
    And Agent 全局监听器已经挂载

  @S1-SKETCH-004
  Scenario: 需求不明确时最多提出 3 个澄清问题
    Given 项目阶段为 "clarifying"
    When 用户输入“帮我做一个管理工具”
    Then 向导 Agent 返回澄清问题
    And 澄清选项数量为 2 到 3 个
    And 每个选项的灰色小字只用于解释选项
    And 选项包含“你帮我决定”
    And 问题文案不包含技术术语

  @S1-SKETCH-005
  Scenario: 长期模式缺少使用对象时继续澄清
    Given 项目模式为 "longterm"
    And 项目阶段为 "clarifying"
    When 用户描述功能但没有说明使用对象
    Then 向导 Agent 继续返回澄清选项
    And 系统不创建验证草图任务

  @S1-SKETCH-006
  Scenario: 需求明确时生成验证草图
    Given 项目阶段为 "clarifying"
    When 用户输入“做一个家庭记账页面，可以记录收入支出并看本月结余”
    Then 系统创建验证草图任务
    And 项目阶段变为 "generating_sketch"
    And 60 秒内产出可交互草图
    And 草图包含 1 到 3 个核心页面
    And 草图使用静态模拟数据
    And 草图在单文件中包含内联 CSS 与 JavaScript
    And 用户点击草图控件时页面产生可观察反馈
    And 预览区显示草图
    And 系统创建类型为 "sketch" 的快照

  @S1-AGENT-002
  Scenario: 草图生成事件按顺序到达 Renderer
    Given 用户提交了明确需求
    When 系统开始生成验证草图
    Then Renderer 依次收到 "generating_sketch"、"sketch_ready" 和 "completed"
    And 每个事件使用同一 session_id 和 project_id

  @S1-SNAPSHOT-001
  Scenario: 草图完成后保存可追踪快照
    Given 系统已经生成验证草图
    When 草图进入可预览状态
    Then 系统创建类型为 "sketch" 的快照
    And 快照包含截图、自然语言摘要和创建时间

  @S1-ANALYTICS-001
  Scenario: 草图闭环记录 Sprint 1 三类脱敏埋点
    Given 用户从空状态创建项目
    When 用户提交需求并生成验证草图
    Then analytics.jsonl 包含 "project_created"
    And analytics.jsonl 包含 "conversation_submitted"
    And analytics.jsonl 包含 "sketch_generated"
    And 埋点不包含用户原始需求或 API Key

  @S1-SANDBOX-001
  Scenario: 草图预览不能读取项目目录之外的文件
    Given 验证草图已写入项目沙箱目录
    When 预览请求访问项目根目录之外的路径
    Then 沙箱拒绝该请求
    And 响应不泄露本地文件内容

  @S2-PROJECT-001
  Scenario: 草图确认后生成 MVP
    Given 预览区已经展示验证草图
    When 用户确认“方向对了”
    Then 系统同步 PRD 初稿
    And 项目阶段变为 "generating_mvp"
    And 编程 Agent 生成正式项目目录结构
    And MVP 在沙箱中启动无错误
    And 预览区显示可运行 MVP
    And 系统创建类型为 "mvp" 的快照

  @S2-JUDGE-009
  Scenario: MVP 生成后自动生成并执行 GWT
    Given MVP 代码已经生成
    And PRD 包含 3 个 P0 功能项
    When 测试工程师生成验收测试
    Then 每个 P0 功能项至少对应 1 个 GWT 场景
    When 测试工程师执行全部 GWT 场景
    Then 系统记录测试总数、通过数和失败数
    And 测试结果写入文档目录

  @S1-UI-005
  Scenario: 生成等待超过 5 秒时给出等待反馈
    Given 系统正在生成 MVP
    When 生成耗时超过 5 秒
    Then 对话区显示等待反馈
    And 文案说明系统正在处理什么
    And 生成耗时尚未超过 10 秒时不显示安全感说明
    And 文案不显示日志或堆栈

  @S1-UI-010
  Scenario: 生成等待超过 10 秒时加入安全感说明
    Given 系统正在生成 MVP
    When 生成耗时超过 10 秒
    Then 对话区显示等待反馈
    And 文案说明系统正在处理什么
    And 文案加入安全感说明

  @S1-UI-006
  Scenario: 草图生成超过 120 秒时提示耗时过长
    Given 系统正在生成验证草图
    When 生成耗时超过 120 秒
    Then 系统提示这次花的时间比预期更长
    And 用户可以继续等待或查看已有部分

  @e2e @S1-SKETCH-007
  Scenario: Electron 中模糊需求显示生活化澄清选项
    Given 用户在 Electron 中进入 quick 工作区
    When 用户输入“帮我做个东西”
    Then 对话区显示 2 到 3 个生活化选项
    And 选项包含“你帮我决定”

  @e2e @S1-SKETCH-008
  Scenario: Electron 中明确需求生成可交互草图预览
    Given 用户在 Electron 中进入 quick 工作区
    When 用户输入明确的家庭记账页面需求
    Then 预览区加载草图页面
    And 草图包含 JavaScript 和可点击控件

  @e2e @S1-SKETCH-009
  Scenario: Electron 中选择澄清选项只提交选项名称
    Given 对话区正在显示带灰色说明的澄清选项
    When 用户点击任一澄清选项
    Then 用户回复只包含所选选项的名称
    And 灰色说明不被拼入用户回复

  @e2e @S1-UI-009
  Scenario: Electron 中等待反馈在超过 5 秒后出现
    Given 用户在 Electron 中提交需求
    And Agent 响应被测试环境延迟
    When 等待时间尚未超过 5 秒
    Then 对话区不显示等待反馈卡片
    When 等待时间超过 5 秒
    Then 对话区显示当前正在处理的内容

  @e2e @S1-ANALYTICS-002
  Scenario: Electron 草图闭环落盘三类脱敏埋点
    Given Electron 使用独立的临时 PROMA_HOME
    When 用户创建项目、提交需求并生成草图
    Then analytics.jsonl 写入三类 Sprint 1 埋点
    And analytics.jsonl 不包含用户原始需求
