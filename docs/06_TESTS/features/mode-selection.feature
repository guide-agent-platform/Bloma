Feature: 模式选择与升级
  作为零基础用户
  我希望先通过两道门选择项目方式
  以便系统用合适的深度帮我生成软件

  Background:
    Given 用户首次启动平台
    And 本地没有正在进行中的项目

  @S1-PROJECT-006
  Scenario: 用户选择快消型并进入工作区
    When 两道门选择页加载完成
    And 用户选择“快速尝鲜”
    Then 系统创建快消型项目
    And 项目阶段变为 "clarifying"
    And 页面进入快消型工作区
    And 工作区不显示技术栈选择

  @S1-PROJECT-007
  Scenario: 用户选择长期迭代型并进入工作区
    When 两道门选择页加载完成
    And 用户选择“精细打磨”
    Then 系统创建长期迭代型项目
    And 项目阶段变为 "clarifying"
    And 页面进入长期迭代型工作区
    And 文档面板入口可见

  @S1-PROJECT-008
  Scenario: 选择模式后不能返回两道门重新选择
    Given 用户已经选择“快速尝鲜”
    When 用户进入快消型工作区
    Then 页面不显示返回两道门的入口
    And 项目模式保持为 "quick"

  @S1-PROJECT-009
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

  @S1-PROJECT-010
  Scenario: 长期迭代型不能降级为快消型
    Given 用户处于长期迭代型工作区
    When 用户打开项目设置
    Then 页面不显示降级为快消型的入口
    And 项目模式保持为 "longterm"

  @S1-UI-007
  Scenario: 两道门只使用生活化文案
    When 两道门选择页加载完成
    Then 页面说明快速尝鲜和精细打磨的适用情况
    And 页面不要求用户选择技术栈
    And 页面不显示代码、框架或数据库术语

  @S1-UI-008
  Scenario: 项目创建失败时停留在两道门并显示可理解提示
    Given 项目存储暂时不可用
    When 用户选择任意开始方式
    Then 页面不进入工作区
    And 页面提示“项目创建失败，请重试”
    And 页面不显示堆栈、路径或状态码

  @S1-STORE-002
  Scenario: 启动时恢复已有活动项目和会话
    Given 本地存在一个活动项目和对应会话
    When 用户启动应用
    Then 页面直接进入该项目工作区
    And 项目模式和会话消息得到恢复
    And 页面不重新显示两道门

  @e2e @S1-PROJECT-011
  Scenario: Electron 中从空状态选择快速尝鲜进入工作区
    Given Electron 使用独立的临时 PROMA_HOME 启动
    When 用户在真实窗口选择“快速尝鲜”
    Then Electron 创建 quick 项目并显示统一工作区
    And 工作区不显示返回两道门或技术栈选择

  @e2e @S1-PROJECT-012
  Scenario: Electron 中从空状态选择精细打磨进入长期工作区
    Given Electron 使用独立的临时 PROMA_HOME 启动
    When 用户在真实窗口选择“精细打磨”
    Then Electron 创建 longterm 项目并显示统一工作区
    And 工作区显示文档入口

  @e2e @S1-STORE-003
  Scenario: Electron 关闭并重启后恢复活动项目
    Given 用户已经在 Electron 中创建 quick 项目
    When 用户关闭并使用同一 PROMA_HOME 重启应用
    Then 页面恢复原项目工作区
    And 页面不重新显示两道门
