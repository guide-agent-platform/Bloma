# 统一 640000 预算的难度与长期型扩展

沿用 [新六组登记](dispatch-flash-pro-uniform-preregister-20261016.md) 的全部模型、资源、余额与验收规则：主流程及所有辅助调用宿主 640000，DS 实际出口 393216，high，D60/E100、256 请求/60 分钟、驾驶 62 分钟、脚本 64 / 安装 8、单实现者，外层最多两个样本。每层 G11/G12、G21/G22、S1/S2 各一轮，分层分析，不拼接旧样本。

L2 quick 完成原生运行与独立评分、复查余额后，依次进行 L3 quick、L1 quick、L1 longterm。以下是离线准备结果，登记时各扩展层付费调用均为零。

| 层 | 共享 input_hash | 检查数 | 证据目录 |
| --- | --- | --- | --- |
| L3 quick | `f5d9dd00e91d4cb464ab3ab1bc44fdbe80be20cd4c8acce44baa1c4d33b1ac4f` | 22 | `run-artifacts/flash-pro-uniform-l3-20261016/` |
| L1 quick | `cfb7cc4e094e51bb39a12c3febb830c1ad2b9a3eb165e65ddc8161c5e3142cbc` | 6 | `run-artifacts/flash-pro-uniform-l1-20261016/` |
| L1 longterm | `25edb2ce7799d1b5c7b42d64f582baffcec6aa3f25a6a52013b678bc85e0a502` | 6 | `run-artifacts/flash-pro-uniform-longterm-20261016/` |

运行包均为 `4abd1dec93d701f9210f45e4eb3f772b7bd09f89883e11a315c51b2d52369a0c`。业务输入分别来自旧冻结确认输入，未继承模型业务实现或外部评分反馈；L3 22 项套件保持不变。L1 quick 接受 7 项功能，longterm 历史 PRD 接受 8 项，六项只覆盖共同业务核心，不能称所有可用性均已验收。longterm 保留真实 Arch/Scaffold 和已完成实现者 `fc4a44f7-98a3-4922-9791-16ef552fa596` 的交接；不通过改 quick.mode 伪造，不用两模式分数差声称纯模式因果效果。

全部沿用主批目录的活动 policy 与同一 DS 钱包，携带旧费用、核销证据和未知预留。开始每层前读取官方余额，并保存与该层对应的实际请求/传输/用量与错误；余额耗尽停止新增请求，不代充值。旧 384000 准备和已中断尝试均不参与本矩阵统计。每条件一次只能作探索性比较，原生失败也保留完整的独立质量结果。
