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
    And 澄清问题数量不超过 3 个
    And 问题文案不包含技术术语

  @S1-SKETCH-006
  Scenario: 需求明确时生成验证草图
    Given 项目阶段为 "clarifying"
    When 用户输入“做一个家庭记账页面，可以记录收入支出并看本月结余”
    Then 系统创建验证草图任务
    And 项目阶段变为 "generating_sketch"
    And 60 秒内产出可交互草图
    And 草图包含 1 到 3 个核心页面
    And 草图使用静态模拟数据
    And 预览区显示草图
    And 系统创建类型为 "sketch" 的快照

  Scenario: 草图确认后生成 MVP
    Given 预览区已经展示验证草图
    When 用户确认“方向对了”
    Then 系统同步 PRD 初稿
    And 项目阶段变为 "generating_mvp"
    And 编程 Agent 生成正式项目目录结构
    And MVP 在沙箱中启动无错误
    And 预览区显示可运行 MVP
    And 系统创建类型为 "mvp" 的快照

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
    And 文案不显示日志或堆栈

  @S1-UI-006
  Scenario: 草图生成超过 120 秒时提示耗时过长
    Given 系统正在生成验证草图
    When 生成耗时超过 120 秒
    Then 系统提示这次花的时间比预期更长
    And 用户可以继续等待或查看已有部分
