# Flash / Pro longterm 六组登记

接续 [主登记](dispatch-flash-pro-preregister-20261016.md) 和 [难度分层登记](dispatch-flash-pro-difficulty-20261016.md)，在 L2/L3/L1 quick 三层之后运行原设计的 longterm 六组各一轮。该批目前只有离线准备，没有新付费请求。

使用历史原生 longterm 准备目录 `bex-l-1014` 的同一待办清单、PRD、确认草图、真实 Arch/Scaffold 产物与已完成实现者交接，源目录只读。选择最后实际修正骨架的实现者 `fc4a44f7-98a3-4922-9791-16ef552fa596`，会话 `f2cf9cf9-2e4f-4448-b6df-fd7e80980754`；原始记录的 `delegation_settle` 与 `loop_status` 都为 completed。另有只读复核会话保留，但没有拿只读核验者替代实现者交接。实现前的业务场景仍为 SKIP，不能称初始产品已经通过验收。

项目 `9c55ae0e-052a-46e0-9476-a54f95c6e1c3`，共享 input_hash=`85f059882f3c7e0786f3a14a974b3a847f0f18eb5952da0cd8dfce9f3d812881`，运行包仍为 `853f767b42031b73f8d48964cb33b295e0735bf9b62c3eb230d697dc16203ec6`。G 组恢复该骨架实现者并绑定本组 E，S 组按平台机制在直接实现上下文重放交接；所有组使用相同准备输入。没有把 quick 的 mode 改为 longterm。

M1 Flash、M2 Pro、V Flash；共同 high、384000 请求输出、D60/E100、256 请求/60 分钟、驾驶 62 分钟、脚本 32 / 安装 8、单执行者；外层最多并行两个样本。顺序为 G11/G12、G21/G22、S1/S2，费用、失败封存及独立 GUI 验收规则沿用主登记。固定六项共同业务检查，验收含隔离数据和真实重启。

该历史 longterm PRD 接受 8 项功能，而 L1 quick 输入接受 7 项。只作 longterm 层内六组匹配，不用两层差值声称纯模式因果效果，也不把六项共同核心检查称为覆盖全部功能。历史准备阶段费用属于原账本，不重标为本轮生成消费；本轮新增原生 Verify 消费计入共同 V。

证据目录：`run-artifacts/flash-pro-l1-longterm-20261016/`，包括源文件哈希、骨架交接来源和独立快照。实际余额耗尽时保留未完成条件，不代充值或删除旧费用责任。
