# {{project_name}}（桌面品类 Python 骨架 v2 · HTML 渲染层）

三层结构：`app.py`（Logic 逻辑层 + Api 桥 + 启动）+ `ui/`（静态组件库）+ 本 README。

小工具可以直接扩展 Logic。多领域、多轮状态或知识引擎等复杂业务按职责拆到 `core/`、`storage/` 等模块；`app.py` 保留启动、桥和 Logic 导入/门面，兼容 `from app import Logic`、`--self-check`、`--drive-port`、`--correction-session`。业务模块不得启动窗口或导入 UI。架构文档列明模块职责与实际持久化方案，改变方案时同步文档，不为凑行数拆分。

`record_store.py` 提供事务式 JSON 记录存储：在副本上更新，磁盘原子替换成功后才提交内存；读取失败/损坏文件不会被静默覆盖。Logic 按 PRD 扩展字段和 validator，继续使用该存储边界。`--self-check` 在临时数据目录运行，不写用户数据。

```powershell
# 1. 环境装配（首次）
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2. 运行 / 自检 / 探索驱动模式
.venv\Scripts\python.exe app.py
.venv\Scripts\python.exe app.py --self-check        # 退出码 0 = 骨架完整
.venv\Scripts\python.exe app.py --drive-port 8800   # 平台探索桥用（隐藏窗口）
```

- UI 改动：只动 `ui/`（组件用法见 `ui/PATTERNS.md`；样式只改 `kit.css`）
- 业务改动：`Logic` 门面与其实际领域/存储模块；Api 只桥接（driver.py 测实际业务层）
- 禁 npm/CDN/外链字体——界面资产全在本地；PRD 要求的联网增强须可配置，离线时明确反馈

文件前缀改名复用 `file_transactions.py`：`build_prefix_plan(folder,prefix)` 生成带源文件快照的预览，`execute_prefix_plan(folder,prefix,plan)` 校验当前输入、源文件与目标冲突后执行；成功的 journal 交 `undo_prefix_rename(folder,journal)`。失败返回 rolled_back 和 recovery，回滚受阻必须展示恢复路径，不能宣称全部还原。进度回调只是通知，异常记 warnings，不把成功文件结果反转成失败。该组件不保证断电原子性或隔离外部进程。

界面在 `preview-state.js` 中复用 `createPreviewGuard([folderInput,prefixInput], executeButton)`：扫描前 begin()；响应到达 accept(ticket,plan)，旧响应会被拒绝；执行前 take() 消费一次。输入、目录或扫描变化立即失效旧预览；修改扫描结果时显式 invalidate()。Python 仍独立校验快照，不能只依赖按钮禁用。

模型功能复用 `llm_client.py` 的真实 HTTP 客户端；设置中提供服务地址、模型与 Key。mock 仅用于测试，不能交付为真实功能；CORE_CHECK 登记实际入口，由宿主本机 HTTP 探针验证请求链路，外部生成内容质量另列待验证。
