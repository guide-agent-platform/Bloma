# {{project_name}}（桌面品类 P1·Python 骨架）

骨架三条入口（Windows 实测结论，禁用 python3——MS Store 空壳）：

```powershell
# 1. 环境装配（首次，~4s）
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2. 运行 / 自检
.venv\Scripts\python.exe app.py                 # 主程序
.venv\Scripts\python.exe app.py --self-check    # 自检（SELF-CHECK-OK + 退出码 0）

# 3. 驱动断言（退出码 0/1/2 = 通过/失败/阻塞）
.venv\Scripts\python.exe driver-skeleton.py

# 4. 打包（implement 完成后）
.venv\Scripts\python.exe -m PyInstaller --onefile --windowed --distpath dist --workpath build --specpath build app.py
dist\{{project_name}}.exe --self-check         # 打包冒烟
```

## 组件启用检查单（按 00_ARCH/env-checklist.json 结论）

| 组件 | pip 包 | 证据 | 启用动作 |
|---|---|---|---|
| 托盘 | pystray + Pillow | [实证] 2026-09-24 | app.py 取消 pystray 接入块注释 |
| 全局热键 | pynput | [实证] 2026-09-24 | 同上（只用 Listener 公共 API） |
| 录音 | sounddevice + numpy | [实证] 2026-09-24 | 同上（sd.rec + sd.wait） |
| 通知 | winotify | [实证] 2026-09-24 | 同上 |
| 剪贴板监听 | 待定 | 待Spike | 立项前必派 Spike（见坑库） |

## 线程模型范式（pystray 实测）

`icon.run()` 阻塞主线程（事件循环）→ 业务线程 daemon 化 → `icon.stop()` 从其他线程调。
驱动探活模式：启动 N 秒后 stop，断言退出码 0。
