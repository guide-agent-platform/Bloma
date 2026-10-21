# 交接修复后实验准备：r5a（2026-10-21）

承接用户“可以继续实验吗”，按原范围继续单组 G11。修复后的运行时重新封存，不续写 r4，也不启动其他五组。本次业务输入与 r4 冻结输入逐文件一致（仅恢复目录索引元数据不同）；原 r4 超时和独立验收结论保留。

## 起跑条件

| 项目 | 本次核对 |
| --- | --- |
| 运行树 | `C:\Users\17359\.codex\worktrees\handoff-recovery-fix\guide-agent-platform-sprint0`，独立物理依赖目录 |
| 提交 | `8224ac088b9103cddeca231596ae9a99940290f9`，含交接修复及真实 loop 离线回归；main/tests 与主工作区修复版本相同 |
| 新 cohort | `C:\Users\17359\bex-pv220\pilot-r5a` |
| G11 run | `production-v2-L1-quick-20261021-r5a-G11` |
| input_hash | `4566f020f5d27f0cdac677a569b6518b15e64c757b5e0a9e54f70bfb19325489` |
| 模型 | 矩阵仍为 M1=GLM 5.3 Flash、M2=GLM 5.3、V=DeepSeek Flash；本次只运行 D/E 均 M1 的 G11 |
| 条件 | high、temperature 0.1、两名实现者、D/E 60/100 回合、256 逻辑请求、640000 宿主输出上限、1 小时共享期限；脚本64次、安装8次 |
| 金额规则 | 沿用此前明确取消金额上限的条件，使用 Coding Plan；历史费用及未知用量账本不清零 |

本地工程验证复用刚完成的同源码验证：270 文件2503项单测、额外真实 loop 回放、30 文件149项集成/回归/验收、类型检查、完整构建及原生 Electron 启动。额外回放与单测重叠范围详见 [修复报告](handoff-recovery-fix-20261021.md)，不相加夸大计数。本次另跑原生进程控制和监督器6项通过。

六组各自离线准备同一 Python、wheelhouse、锁定依赖和平台资产，真实 WebView2 启动及原生 Bloma 发送控件资格均通过；资格检查没有发送制作消息。空草稿 revision 变动已留档后恢复，父会话与非索引冻结文件逐字节匹配。只授予 G11 本次启动资格，其余五组未启动。

## 本次真实通道资格

17:49（北京时间）开始新的真实工具往返预检，不能复用上午已经过期的证书：DeepSeek Flash 与 GLM 5.3 各两路往返通过，共8次物理请求；GLM 5.3 Flash 三路往返通过，共6次物理请求，物理峰值3。合计14次预检请求，和正式实验实现阶段调用分开记录；精确剩余 Coding Plan 额度未知。这些检查只证明当时路由及工具往返可用，不证明完整任务可完成。

资格有效至 **2026-10-21 18:19:24（北京时间）**。`run-one-r5a.mjs G11 --check-only` 已返回 ready-not-started。控制器校验运行时文件、驱动、依赖锁、冻结输入、独立验收工具、继续指令和未启动状态；正式启动及结果另存 launch/result 记录，本文不是完成声明。

## 证据与观察点

- 封存证书：`outputs/experiment-r5a-20261021/readiness.json`；原件 `pilot-r5a/audit-ready.json` 及 `readiness-release.json`。
- 预检及环境证据根：`C:\Users\17359\AppData\Local\Bloma\production-v2-L1-20261020` 下 `availability-r5a-*`、`env-r5a/`、`platform-r5a-ready.json`、`qualification-r5a.log`。
- 独立六项业务检查和预期不变；适配器从保留的 r4 selector-v2 副本只更改 cohort、运行编号和工具树路径。新产物尚未评分，Q=null。若新 UI 控件结构变化，应保留首轮证据并单独审查适配器变化，不能修改业务期望或生成产物替它过关。
- 先观察调度是否实际使用两名实现者、物理 HTTP 是否重叠、历史失败交接是否能进入后续核验、正式门禁及 V 是否真实执行，再独立验收业务。离线回放通过不代表真实调度已收敛。
- 最初通用准备命令误用了不存在的 `pilot-r4/evaluator` 路径，在调用模型前中止；其部分目录 `pilot-r5` 保留。改用原权威 `bex-l1q19/evaluator`，另建 r5a，并对全部非索引冻结文件重新核对。未把中断目录或旧 r4 产物作为新实验起点。
- 主项目列表保持清空状态，旧实验 home、r4 运行树及原始结果不改写。主工作区原有制作流程文档修改不纳入本次提交。
