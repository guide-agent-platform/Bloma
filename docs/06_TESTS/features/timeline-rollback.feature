Feature: 快照与线性回滚
  作为零基础用户
  我希望能回到之前看起来正常的版本
  以便修改失败时不会失去已有成果

  Background:
    Given 项目已经生成过验证草图和 MVP
    And 时间轴中存在多个快照

  Scenario: 草图和 MVP 生成后自动创建快照
    When 用户展开时间轴
    Then 时间轴显示“验证草图”和“MVP”快照
    And 每个快照包含预览截图、自然语言摘要和创建时间

  Scenario: 用户确认回滚到验证草图版本
    Given 时间轴中存在“验证草图 v1”和“MVP v1”两个快照
    When 用户点击“验证草图 v1”的“回到这里”
    Then 系统弹出回滚确认框
    And 确认框说明后续版本仍会保留
    When 用户点击“确认回到这里”
    Then 系统创建 "rollback_guard" 快照
    And 预览区恢复为“验证草图 v1”
    And 当前快照指针更新为“验证草图 v1”
    And 向导 Agent 告知用户已经回到之前版本

  Scenario: 用户取消回滚
    Given 回滚确认框已经显示
    When 用户点击“取消”
    Then 系统关闭确认框
    And 当前预览不变
    And 当前快照指针不变

  Scenario: 当前版本不能回滚到自身
    Given 时间轴展开
    When 用户查看当前版本快照卡片
    Then 卡片显示“当前版本”
    And 卡片不显示“回到这里”按钮

  Scenario: 回滚后继续修改不创建分支
    Given 用户已经回滚到较早快照
    When 用户继续提交新的修改
    Then 新快照沿当前时间线继续追加
    And 系统不展示分支概念

  Scenario: 回滚过程中应用关闭后恢复事务
    Given 回滚事务已经开始
    When 用户关闭应用
    And 用户重新打开应用
    Then 系统恢复到回滚前安全状态或完成回滚事务
    And 项目不会处于半回滚状态
