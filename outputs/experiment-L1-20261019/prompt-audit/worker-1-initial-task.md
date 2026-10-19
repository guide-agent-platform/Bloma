协作子任务（role=implement）：
[t1_core_logic] 实现离线待办清单业务核心与 Api 桥（项目根，Windows）。先 read：app.py、record_store.py、00_ENV/common-environment.json。测试一律用 .venv\Scripts\python.exe 执行，绝不触碰项目根 data/（测试用临时目录）。

1) 新建 core/task_board.py（业务层，纯 Python，禁止 import UI、禁止任何网络相关 import）：class TaskBoard(data_dir: Path|None=None)；data_dir 缺省 = os.environ.get("APP_DATA_DIR", <项目根>/data)；持久化用 record_store.JsonRecordStore(directory/"records.json", required_keys=("id","title","done","seq"), validator=校验 title 为 str、done 为 bool、seq 为正 int、id 非空 str)。兼容迁移：若已存在旧骨架 schema（行含 "name" 无 "title"），初始化时一次性转换为 {id,title,done:False,seq:i+1} 并原子写回，不丢数据。数据模型：记录 {"id":uuid4hex,"title":str,"done":bool,"seq":int}；新增 seq=当前最大+1（空表为 1）；列表按 seq 升序；删除仅移除目标记录，其余 seq 不动（相对顺序保持）。
方法（异常用 ValueError/KeyError，消息中文）：
- list_tasks(view="all")，view∈{all,open,done}（非法值 ValueError）：返回 {"view":view,"tasks":[按序记录],"counts":{"all":n,"open":n,"done":n}}（open=done==False，done=done==True）。
- add_task(title)：title=str(title).strip()，空 → ValueError("标题不能为空")；否则追加并返回 {"task":记录,"counts":…}。同名任务允许重复（BR-004）。
- toggle_task(task_id)：存在则翻转 done 并返回 {"task":记录,"counts":…}；不存在 KeyError("任务不存在")。
- delete_task(task_id)：仅删该条，返回 {"removed_id":task_id,"counts":…}；不存在 KeyError("任务不存在")。
store 读损坏（DataIntegrityError）时如实向上抛，不得静默清空。

2) 修改 app.py：Logic 变为门面——from core.task_board import TaskBoard；class Logic 保留 __init__(self, data_dir: Path|None=None)（from app import Logic 与 Logic(Path(tempdir)) 必须可用），方法直接转调 TaskBoard。Api 桥方法（每个返回 json.dumps(envelope, ensure_ascii=False)，异常捕获后返回 {"ok":false,"error":str(error)}，不吞）：list_tasks(view="all")、add_task(title)、toggle_task(task_id)、delete_task(task_id)、handle_send(text)=add_task 兼容别名；保留 correction_pick 原样。所有操作均 <1s，无需线程。保留并保持可用：--self-check（探针改用 add_task/list_tasks，仍打印 SELF-CHECK OK）、--offscreen、--drive-port、--correction-session、drive /eval+/call 协议、APP_NAME="离线待办清单"（窗口标题第一参数不得改）、数据目录约定。APP_VERSION 升为 "1.0.0"。

3) 新建 core_check.py（项目根）：无头逻辑自测，用 tempfile 目录做 APP_DATA_DIR 级隔离，「重开程序」=用同一目录重新构造 TaskBoard。固定 21 个场景，stdout 每行恰为 "PASS <场景名>" 或 "FAIL <场景名>"，末行 "CORE-CHECK OK 21/21" 或 "CORE-CHECK FAIL k/21"，全过退出码 0 否则 1。场景名逐字如下（不得增删改字）：
1 trim spaces on add —— add_task("  买牛奶  ") 后 list_tasks("all") 恰一条 title=="买牛奶"，输入原串不落库（断言存储记录 title 无首尾空格）。
2 blank title rejected keeps list —— 先加一条，再依次 add_task("   ")、add_task("\t\n ") 均 ValueError，列表仍恰 1 条且内容不变。
3 same title saved as independent tasks —— 加两条 "买牛奶"，得 2 条不同 id 记录，各自 toggle 互不影响（断言一条 done=True 另一条 False）。
4 toggle marks done and undone —— 新任务 toggle 后 done=True 且出现在 list_tasks("done")；再 toggle 后 done=False 且出现在 list_tasks("open")。
5 toggle same-name only target changes —— 两条同名一完一未，toggle 未完成那条，仅它变化。
6 done state survives reopen —— toggle 成 done 后用同目录重建 TaskBoard，done 仍 True，seq/顺序不变。
7 open view filters open tasks in order —— 混合任务下 list_tasks("open") 只含未完成且 seq 升序。
8 done view empty shows nothing —— 只有未完成任务时 list_tasks("done").tasks==[] 且不含未完成。
9 completing removes from open view —— open 视图下把唯一未完成 toggle 成 done，list_tasks("open") 变空、done 视图出现。
10 view switch keeps view and recomputes —— 依次取 done、open、all 三视图结果互不串扰，all 含全部且顺序不变（对应 BR-009 本地重算语义）。
11 delete removes only target task —— 多条任务删指定一条，其余（含内容与 done）不变。
12 delete same-name keeps twin intact —— 两条同名一完一未，删未完成那条，另一条及其 done 保留。
13 delete last task leaves empty list —— 仅一条时删除后 list_tasks("all").tasks==[]，counts 全 0。
14 deleted task stays gone after reopen —— 删除后重建 TaskBoard，被删的不出现，其余内容与状态不变。
15 reopen keeps order titles and states —— A、B、C 顺序加入并勾选部分，重建后按 A、B、C 序展示相同 title/done。
16 fresh start stays empty after reopen —— 全新空目录重建后仍空。
17 reopen after delete keeps remaining tasks —— 删一条留两条，重建后恰两条且状态一致。
18 list shows A B C with states in order —— 全视图 tasks 的 title 序列==[A,B,C]，每条带 done 状态。
19 same-name rows separate with own state —— 两条同名 done 不同，all 视图两行各自 title/done 独立呈现（不合并）。
20 done view lists only done titles and states —— done 视图只含已完成记录的 title/done。
21 all operations run offline no account —— 测试期间把 socket.socket.connect 临时替换为抛 OSError（模拟完全断网），在断网下完成 add/toggle/delete/三视图读取/重建恢复全流程均成功；业务层无任何网络调用（可顺带断言 core/ 源码不 import socket/urllib/request）。结束恢复 patch。

4) 用 run_project_script 以 .venv\Scripts\python.exe 真实跑到全绿：先 `.venv\Scripts\python.exe app.py --self-check` 退出码 0，再 `.venv\Scripts\python.exe core_check.py` 全 PASS。失败就修代码复跑，禁止编造结果；最终结果里附真实命令与输出摘录、测试轮数。
依赖：
写入范围：core/,app.py,core_check.py
调度反馈（保持已确认需求）：实现离线待办清单业务核心与 Api 桥（Windows，项目根）。先 read：app.py、record_store.py、00_ENV/common-environment.json。测试一律用 .venv\Scripts\python.exe 执行，绝不触碰项目根 data/（测试用临时目录）。

1) 新建 core/task_board.py（业务层，纯 Python，禁止 import UI、禁止任何网络相关 import）：
class TaskBoard(data_dir: Path|None=None)；data_dir 缺省 = os.environ.get("APP_DATA_DIR", <项目根>/data)；持久化用 record_store.JsonRecordStore(directory/"records.json", required_keys=("id","title","done","seq"), validator=校验 title 为 str、done 为 bool、seq 为正 int、id 非空 str)。兼容迁移：若已存在旧骨架 schema（行含 "name" 无 "title"），初始化时一次性转换为 {id,title,done:False,seq:i+1} 并原子写回，不丢数据。
数据模型：记录 {"id":uuid4().hex,"title":str,"done":bool,"seq":int}；新增 seq=当前最大+1（空表为 1）；列表按 seq 升序；删除仅移除目标记录，其余 seq 不动（相对顺序保持）。
方法（异常用 ValueError/KeyError，消息中文）：
- list_tasks(view="all")，view∈{all,open,done}（非法值 ValueError）：返回 {"view":view,"tasks":[按序记录],"counts":{"all":n,"open":n,"done":n}}（open=done==False，done=done==True）。
- add_task(title)：title=str(title).strip()，空 → ValueError("标题不能为空")；否则追加并返回 {"task":记录,"counts":…}。同名任务允许重复（BR-004）。
- toggle_task(task_id)：存在则翻转 done 并返回 {"task":记录,"counts":…}；不存在 KeyError("任务不存在")。
- delete_task(task_id)：仅删该条，返回 {"removed_id":task_id,"counts":…}；不存在 KeyError("任务不存在")。
store 读损坏（DataIntegrityError）时如实向上抛，不得静默清空。

2) 修改 app.py：Logic 变为门面——from core.task_board import TaskBoard；class Logic 保留 __init__(self, data_dir: Path|None=None)（from app import Logic 与 Logic(Path(tempdir)) 必须可用），方法直接转调 TaskBoard。Api 桥方法（每个返回 json.dumps(envelope, ensure_ascii=False)，异常捕获后返回 {"ok":false,"error":str(error)}，不吞）：list_tasks(view="all")、add_task(title)、toggle_task(task_id)、delete_task(task_id)、handle_send(text)=add_task 兼容别名；保留 correction_pick 原样。所有操作均 <1s，无需线程。保留并保持可用：--self-check（探针改用 add_task/list_tasks，仍打印 SELF-CHECK OK）、--offscreen、--drive-port、--correction-session、drive /eval+/call 协议、APP_NAME="离线待办清单"（窗口标题第一参数不得改）、数据目录约定（APP_DATA_DIR 优先）。APP_VERSION 升为 "1.0.0"。

3) 新建 core_check.py（项目根）：无头逻辑自测，用 tempfile 目录做 APP_DATA_DIR 级隔离，「重开程序」=用同一目录重新构造 TaskBoard。固定 21 个场景，stdout 每行恰为 "PASS <场景名>" 或 "FAIL <场景名>"，末行 "CORE-CHECK OK 21/21" 或 "CORE-CHECK FAIL k/21"，全过退出码 0 否则 1。场景名逐字如下（不得增删改字）：
1 trim spaces on add —— add_task("  买牛奶  ") 后 list_tasks("all") 恰一条 title=="买牛奶"，断言存储记录 title 无首尾空格。
2 blank title rejected keeps list —— 先加一条，再依次 add_task("   ")、add_task("\t\n ") 均 ValueError，列表仍恰 1 条且内容不变。
3 same title saved as independent tasks —— 加两条 "买牛奶"，得 2 条不同 id 记录，各自 toggle 互不影响（断言一条 done=True 另一条 False）。
4 toggle marks done and undone —— 新任务 toggle 后 done=True 且出现在 list_tasks("done")；再 toggle 后 done=False 且出现在 list_tasks("open")。
5 toggle same-name only target changes —— 两条同名一完一未，toggle 未完成那条，仅它变化。
6 done state survives reopen —— toggle 成 done 后用同目录重建 TaskBoard，done 仍 True，seq/顺序不变。
7 open view filters open tasks in order —— 混合任务下 list_tasks("open") 只含未完成且 seq 升序。
8 done view empty shows nothing —— 只有未完成任务时 list_tasks("done").tasks==[] 且不含未完成。
9 completing removes from open view —— open 视图下把唯一未完成 toggle 成 done，list_tasks("open") 变空、done 视图出现。
10 view switch keeps view and recomputes —— 依次取 done、open、all 三视图结果互不串扰，all 含全部且顺序不变（对应 BR-009 本地重算语义）。
11 delete removes only target task —— 多条任务删指定一条，其余（含内容与 done）不变。
12 delete same-name keeps twin intact —— 两条同名一完一未，删未完成那条，另一条及其 done 保留。
13 delete last task leaves empty list —— 仅一条时删除后 list_tasks("all").tasks==[]，counts 全 0。
14 deleted task stays gone after reopen —— 删除后重建 TaskBoard，被删的不出现，其余内容与状态不变。
15 reopen keeps order titles and states —— A、B、C 顺序加入并勾选部分，重建后按 A、B、C 序展示相同 title/done。
16 fresh start stays empty after reopen —— 全新空目录重建后仍空。
17 reopen after delete keeps remaining tasks —— 删一条留两条，重建后恰两条且状态一致。
18 list shows A B C with states in order —— 全视图 tasks 的 title 序列==[A,B,C]，每条带 done 状态。
19 same-name rows separate with own state —— 两条同名 done 不同，all 视图两行各自 title/done 独立呈现（不合并）。
20 done view lists only done titles and states —— done 视图只含已完成记录的 title/done。
21 all operations run offline no account —— 测试期间把 socket.socket.connect 临时替换为抛 OSError（模拟完全断网），在断网下完成 add/toggle/delete/三视图读取/重建恢复全流程均成功；并断言 core/ 源码不 import socket/urllib/request。结束恢复 patch。

4) 用 run_project_script 以 .venv\Scripts\python.exe 真实跑到全绿：先 `.venv\Scripts\python.exe app.py --self-check` 退出码 0，再 `.venv\Scripts\python.exe core_check.py` 全 PASS。失败就修代码复跑，禁止编造结果；最终结果里附真实命令与输出摘录、测试轮数。

完成后用简洁文本输出结果摘要（关键发现/完成清单/未完成项与原因）。最终回复以一行「结论:」开头的标记句总结（会被上下文压缩保留）。

【执行预算】本轮上限 100 轮，每轮为一次模型请求。沿用历史中的已读事实，避免重复通读；保留最后约 1/4 轮数用于真实验证与交付收口。未完成时明确列出未落盘/未验证项，不得声称工作已完成。
