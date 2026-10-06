# {{project_name}}（桌面品类 Python 骨架 v2 · HTML 渲染层）

三层结构：`app.py`（Logic 逻辑层 + Api 桥 + 启动）+ `ui/`（静态组件库）+ 本 README。

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
- 业务改动：只动 `app.py` 的 `Logic`/`Api`（driver.py 测 Logic 层）
- 禁 npm/CDN/外链字体——产物必须完全离线可用
