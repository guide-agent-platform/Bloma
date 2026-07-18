Feature: 自动修复、熔断与裁判门禁
  作为零基础用户
  我希望系统能自动修好常见问题
  并在修不好时安全回退和让我决定下一步

  Background:
    Given 项目已经进入 MVP 或迭代阶段
    And 最近存在一个健康快照

  Scenario: 代码运行失败时自动修复
    Given 代码在沙箱中运行时报错
    When 错误被系统捕获
    Then 编程 Agent 自动分析错误原因
    And 系统不向用户展示堆栈详情
    And 自动修复最多尝试 3 次

  Scenario: 第 3 次修复仍失败时熔断回滚
    Given 编程 Agent 已经连续 3 次自动修复失败
    When 第 3 次修复结果仍为失败
    Then 系统停止继续自动修复
    And 系统自动回滚到最近一次健康快照
    And 向导 Agent 告知用户内容没有丢失
    And 用户可以选择继续尝试、接受当前或补充说明

  Scenario: 裁判硬约束失败时退回但不参与修复
    Given 项目进入裁判审查阶段
    And PRD 缺少核心功能描述
    When 裁判 Agent 执行硬约束检查
    Then 裁判 Agent 输出 "return" 判定
    And 报告列出不通过项
    And 裁判 Agent 不执行修复

  Scenario: 每个 PRD 功能项必须有 GWT 场景
    Given PRD 包含 3 个功能项
    And GWT 文件只覆盖其中 2 个功能项
    When 裁判 Agent 扫描 GWT 测试文件
    Then 裁判 Agent 标记缺失的功能项
    And 裁判 Agent 输出 "return" 判定

  Scenario: 快消型 2 次退回后让渡给用户
    Given 用户处于快消型工作区
    And 裁判已退回 2 次且修复均未通过
    When 第 2 次修复后仍不通过
    Then 裁判触发让渡
    And 向导 Agent 用生活化语言说明偏差
    And 用户可以选择继续修复、接受现状或补充说明

  Scenario: 长期迭代型 3 次退回后让渡给用户
    Given 用户处于长期迭代型工作区
    And 裁判已退回 3 次且修复均未通过
    When 第 3 次修复后仍不通过
    Then 裁判触发让渡
    And 用户可以选择继续修复、接受现状或补充说明

  Scenario: 安全问题不计入普通退回次数
    Given 项目已有 1 次普通问题退回
    And 裁判检测到新的安全风险
    When 安全问题触发强制修复
    Then 普通退回计数器保持为 1
    And 安全修复使用独立计数器

  Scenario: 安全修复失败时用户文案不包含技术术语
    Given 安全问题已尝试 3 次强制修复均失败
    When 向导 Agent 告知用户具体风险
    Then 文案不包含 "XSS"
    And 文案不包含 "SQL 注入"
    And 文案说明现实风险和可选下一步
