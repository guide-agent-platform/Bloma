Feature: Proma core 边界
  作为平台维护者
  我希望新增能力严格遵守 Proma core 架构
  以便避免 IPC、权限、存储和密钥管理漂移

  Background:
    Given 测试环境使用临时 PROMA_HOME
    And Renderer 只能访问 preload 暴露的 window.electronAPI

  Scenario: 新增 IPC 能力必须经过四层链路
    Given 开发者新增一个项目能力
    When 测试扫描 IPC 定义
    Then shared/types.ts 中存在 channel 常量和 payload 类型
    And main/ipc.ts 注册对应 handler
    And preload/bridge.ts 暴露白名单 API
    And renderer 通过 atoms 或 window.electronAPI 调用
    And main/preload/renderer 不各自硬编码 channel 字符串

  Scenario: Renderer 不能接触明文 API Key
    Given 用户已经配置模型渠道
    When Agent 请求开始
    Then main 进程通过 safeStorage 解密 API Key
    And Renderer 不接收明文 API Key
    And 会话 JSONL 不包含明文 API Key
    And 埋点 JSONL 不包含明文 API Key

  Scenario: Agent SDK env 必须合并 process.env
    Given main 进程准备调用 Agent SDK
    When AgentOrchestrator 构建 options.env
    Then options.env 包含 PATH
    And options.env 包含 HOME 或 USERPROFILE
    And options.env 包含模型供应商变量
    And 模型供应商变量覆盖同名默认值

  Scenario: 同一 sessionId 不能并发运行 Agent 请求
    Given session "s1" 正在流式生成
    When Renderer 再次提交 session "s1" 的 Agent 请求
    Then main 进程返回 "AGENT_SESSION_BUSY"
    And 不启动第二个 SDK query

  Scenario: 权限请求通过 pendingRequests Map resolve
    Given Agent SDK 请求危险工具权限
    When PermissionService 创建权限请求
    Then pendingRequests Map 保存 requestId 和 resolve
    And Renderer 收到权限请求事件
    When 用户点击允许
    Then Renderer 通过 permission:response 回传决策
    And PermissionService resolve 对应 Promise
    And pendingRequests Map 删除该 requestId

  Scenario: 全局监听器不会因页面切换丢失事件
    Given Agent 正在流式输出
    When 用户从工作区切换到设置页
    And main 进程继续推送 AgentEvent
    Then useGlobalAgentListeners 仍然接收事件
    And agentStreamStateFamily(sessionId) 继续追加事件
    And 用户回到工作区后能看到完整输出

  Scenario: SDK 失败前的部分消息必须写入 JSONL
    Given Agent SDK 已经输出 3 条 message_delta
    When SDK 随后抛出错误
    Then 已收到的 3 条事件追加写入 agent-sessions JSONL
    And 最终错误事件也追加写入 JSONL
    And UI 显示 P0 用户可读的错误文案

  Scenario: 运行时不创建 SQLite 或服务端数据库
    Given 用户完成一次草图和 MVP 生成
    When 测试扫描临时 PROMA_HOME
    Then 存储文件只包含 JSON、JSONL、项目文件、文档和快照
    And 不存在运行时 SQLite 文件
    And 不存在服务端数据库连接配置
