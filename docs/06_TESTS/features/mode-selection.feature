Feature: 模式选择与升级
  作为零基础用户
  我希望先通过两道门选择项目方式
  以便系统用合适的深度帮我生成软件

  Background:
    Given 用户首次启动平台
    And 本地没有正在进行中的项目

  Scenario: 用户选择快消型并进入工作区
    When 两道门选择页加载完成
    And 用户选择“快速尝鲜”
    Then 系统创建快消型项目
    And 项目阶段变为 "clarifying"
    And 页面进入快消型工作区
    And 工作区不显示技术栈选择

  Scenario: 用户选择长期迭代型并进入工作区
    When 两道门选择页加载完成
    And 用户选择“精细打磨”
    Then 系统创建长期迭代型项目
    And 项目阶段变为 "clarifying"
    And 页面进入长期迭代型工作区
    And 文档面板入口可见

  Scenario: 选择模式后不能返回两道门重新选择
    Given 用户已经选择“快速尝鲜”
    When 用户进入快消型工作区
    Then 页面不显示返回两道门的入口
    And 项目模式保持为 "quick"

  Scenario: 快消型完成后可以升级为长期迭代型
    Given 用户处于快消型工作区
    And 项目已经完成 MVP
    When 用户点击升级入口
    Then 系统显示升级确认弹窗
    And 弹窗说明升级前会创建快照
    When 用户确认升级
    Then 系统创建升级前快照
    And 项目模式变为 "longterm"
    And 文档面板入口可见

  Scenario: 长期迭代型不能降级为快消型
    Given 用户处于长期迭代型工作区
    When 用户打开项目设置
    Then 页面不显示降级为快消型的入口
    And 项目模式保持为 "longterm"
