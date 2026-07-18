Feature: 点选纠错
  作为零基础用户
  我希望直接点击预览里不满意的位置
  以便系统知道我要改哪里

  Background:
    Given 预览区已经展示可交互草图
    And 项目已有可写入的会话 JSONL

  Scenario: 用户点击预览元素后打开纠错弹窗
    When 用户点击预览区中的金额显示区域
    Then 被点击区域高亮显示
    And 点选纠错弹窗打开
    And 弹窗询问“这里有什么问题？”

  Scenario: 用户输入说明后系统记录纠错上下文
    Given 点选纠错弹窗已经打开
    When 用户输入“金额前面要显示 ¥”
    And 用户提交
    Then 系统记录点击位置和用户说明
    And 系统记录元素文本和区域坐标
    And 纠错事件追加写入会话 JSONL
    And 向导 Agent 回复已收到修改意见

  Scenario: 用户点击“你猜”时系统保留点击上下文
    Given 点选纠错弹窗已经打开
    When 用户点击“你猜”
    Then 系统记录点击位置
    And 系统标记纠错模式为 "guess"
    And 向导 Agent 根据上下文推断修改意图

  Scenario: 重复纠错同一区域时主动追问
    Given 用户已经连续两次纠错同一区域
    When 用户第三次点击同一区域
    Then 向导 Agent 主动追问用户希望该区域如何呈现
    And 系统不继续盲目自动修改

  Scenario: Canvas 或跨域 iframe 无法识别元素时降级为区域纠错
    Given 预览内容无法返回 DOM selector
    When 用户点击预览区
    Then 系统记录点击坐标和截图区域
    And 纠错上下文标记 "fallback_mode" 为 true
    And 用户仍然可以提交修改说明

  Scenario: 纠错修改通过测试后刷新预览
    Given 用户已经提交点选纠错
    And 编程 Agent 已生成修改
    When 相关 GWT 场景通过
    Then 系统创建类型为 "iteration" 的快照
    And 预览区刷新为修改后的版本
    And 系统记录 "point_correction" 埋点事件
