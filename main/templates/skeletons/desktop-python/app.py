"""{{project_name}} — 桌面程序骨架 v2（批8 HTML 渲染层，pywebview + WebView2）。

结构纪律（三层，实现阶段不得打破）：
1. 逻辑层（本文件 Logic 类，纯 Python）——业务/持久化全在这里，**不 import UI**；
   契约驱动（driver.py）与故障种子直接测这一层。
2. 桥（Api 类）——UI 的每个动作一个方法，转调 Logic，返回 JSON 字符串；
   耗时操作内部用线程，完成后 evaluate_js 推送（业务代码不得直接摸 UI）。
3. UI（ui/ 目录静态资产）——只渲染与收集输入，经 window.App.call 调桥；
   组件用法见 ui/PATTERNS.md（不写新 CSS 优先拼现成组件）。

运行：python app.py            正常启动（WebView2 窗口）
      python app.py --self-check          骨架自检（退出码 0=完整）
      python app.py --offscreen           离屏模式（窗口在屏幕外渲染照常——UI 截图场景用，
                                          零闪现零抢焦点，PrintWindow 截图不受影响）
      python app.py --drive-port N        探索驱动模式（屏幕外窗口 + 127.0.0.1 控制服务器，
                                          POST /eval {"js":...} → evaluate_js；平台探索桥用。2026-10-08 回归修复：
                                          原为隐藏窗口——WebView2 hidden 渲染循环暂停，click 后 js 回程挂起，
                                          改屏幕外坐标（渲染照常，回程可靠，零闪现零抢焦点不变））
      python app.py --correction-session <dir> --drive-port N   修改预览模式（平台点选纠错拉起：
                                          可见窗口 + 页内点选层，选区写入 <dir>/picks.jsonl；
                                          数据目录经 APP_DATA_DIR 环境变量指向只读快照）

数据目录约定（持久化一律遵守）：Path(os.environ.get("APP_DATA_DIR", Path(__file__).parent / "data"))
——正常启动缺省项目内 data/；修改预览模式下平台注入快照目录（原数据零接触）。

依赖：pywebview（pip）+ 系统 WebView2（Win10+ 自带）。禁 npm/CDN/外链字体——ui/ 全本地。
"""

from __future__ import annotations

import json
import os
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

APP_NAME = "{{project_name}}"
APP_VERSION = "0.1.0-skeleton"
UI_DIR = Path(__file__).parent / "ui"


# ══════════════════════════ 1. 逻辑层（driver.py 测这里） ══════════════════════════

class Logic:
    """业务逻辑与持久化。骨架期：条目增删查；实现阶段按 PRD 扩展（sqlite/json 自选）。"""

    def __init__(self) -> None:
        self.items: list[dict] = []  # 骨架占位；正式实现换真实持久化

    def list_items(self) -> list[dict]:
        return self.items

    def add_item(self, name: str, sub: str = "") -> dict:
        item = {"id": str(len(self.items) + 1), "name": name, "sub": sub}
        self.items.append(item)
        return item

    def handle_send(self, text: str) -> dict:
        """输入行主通道（骨架占位实现；按产品语义替换）。"""
        if not text.strip():
            raise ValueError("输入为空")
        return {"message": f"已处理：{text.strip()}"}


# ══════════════════════════ 2. 桥（UI ↔ Logic） ══════════════════════════

class Api:
    """js_api 桥：JS 侧 window.App.call("方法名", 参数...) 到达这里。
    返回值一律 JSON 字符串（bridge.js 会解析）。"""

    def __init__(self, logic: Logic, correction_dir: Path | None = None) -> None:
        self._logic = logic
        self._correction_dir = correction_dir

    # —— 点选纠错选区落盘（correction.js 专用；文件交接：平台轮询读 picks.jsonl）——
    def correction_pick(self, payload_json: str) -> str:
        """追加一行选区到 <correction_dir>/picks.jsonl（原子追加，业务无关）。"""
        if not self._correction_dir:
            return json.dumps({"ok": False, "error": "not-in-correction-mode"}, ensure_ascii=False)
        try:
            line = json.loads(payload_json)
            line["received_at"] = datetime.now().isoformat(timespec="seconds")
            self._correction_dir.mkdir(parents=True, exist_ok=True)
            with open(self._correction_dir / "picks.jsonl", "a", encoding="utf-8") as fh:
                fh.write(json.dumps(line, ensure_ascii=False) + "\n")
            return json.dumps({"ok": True, "seq": line.get("seq")}, ensure_ascii=False)
        except Exception as error:
            return json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False)

    # —— 列表/条目 ——
    def list_items(self) -> str:
        return json.dumps(self._logic.list_items(), ensure_ascii=False)

    def handle_send(self, text: str) -> str:
        try:
            return json.dumps(self._logic.handle_send(text), ensure_ascii=False)
        except Exception as error:  # 失败如实回 UI（失败态横幅呈现，不吞）
            return json.dumps({"error": str(error)}, ensure_ascii=False)

    # —— Python → UI 推送样例（业务扩展时照抄本模式）——
    # def push_update(self, payload: dict) -> None:
    #     import webview
    #     webview.windows[0].evaluate_js(f"window.on_update({json.dumps(payload, ensure_ascii=False)})")


# ══════════════════════════ 3. 启动 / 自检 / 驱动模式 ══════════════════════════

def self_check() -> int:
    """骨架自检：逻辑层可导入可调用 + ui 资产齐备（打印 ASCII 锚点 SELF-CHECK-OK）。"""
    checks: list[tuple[str, bool]] = []
    logic = Logic()
    logic.add_item("探针", "self-check")
    checks.append(("logic", logic.list_items()[0]["name"] == "探针"))
    checks.append(("ui-html", (UI_DIR / "index.html").exists()))
    checks.append(("ui-css", (UI_DIR / "kit.css").exists()))
    checks.append(("ui-bridge", (UI_DIR / "bridge.js").exists()))
    try:
        import webview  # noqa: F401
        checks.append(("pywebview", True))
    except ImportError:
        checks.append(("pywebview", False))
    ok = all(done for _, done in checks)
    print("SELF-CHECK " + ("OK" if ok else "FAIL") + " " + " ".join(f"{n}={'ok' if d else 'FAIL'}" for n, d in checks))
    return 0 if ok else 1


def make_drive_handler(window, api: Api) -> type[BaseHTTPRequestHandler]:
    """探索驱动协议：POST /eval {"js": "<表达式>"} → {"ok":true,"result":...}。
    只绑 127.0.0.1；窗口隐藏不打扰用户（平台探索桥的 act/read 全走这里）。"""

    class Handler(BaseHTTPRequestHandler):
        def _respond(self, obj) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode("utf8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            # CORS：页面（file://源）在 drive/纠错模式下经 fetch 直调 /call（绕开
            # pywebview js_api 回推——与 evaluate_js 并发死锁根治，2026-10-08）
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) or b"{}"
            try:
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except UnicodeDecodeError:
                    # 客户端编码容错（GBK 控制台 curl 实测会踩）：utf-8 失败回退 gbk
                    payload = json.loads(raw.decode("gbk", errors="replace"))
            except json.JSONDecodeError:
                # 脏请求容错（2026-10-08 实证：非法 JSON 曾打崩 handler 断连，空回复
                # 被误读为挂死）：如实回包不断连——驱动面不被单条脏请求 DoS
                self._respond({"ok": False, "error": "bad-json: body 不是合法 JSON"})
                return
            try:
                if self.path == "/eval":
                    # 同步 DOM JS（evaluate_js 不 await Promise——异步桥调用走 /call）
                    result = window.evaluate_js(payload.get("js", "null"))
                    self._respond({"ok": True, "result": result})
                elif self.path == "/call":
                    # 直调 Python 桥方法：{"op": "list_items", "args": [...]} → 逻辑层
                    op = payload.get("op", "")
                    fn = getattr(api, op, None)
                    if not callable(fn):
                        self._respond({"ok": False, "error": f"no api: {op}"})
                        return
                    ret = fn(*payload.get("args", []))
                    parsed = json.loads(ret) if isinstance(ret, str) else ret
                    self._respond({"ok": True, "result": parsed})
                else:
                    self.send_response(404)
                    self.end_headers()
            except Exception as error:
                self._respond({"ok": False, "error": str(error)})

        def log_message(self, *_args: object) -> None:
            pass

    return Handler


def main() -> int:
    if "--self-check" in sys.argv:
        return self_check()

    import webview

    drive_port = 0
    if "--drive-port" in sys.argv:
        drive_port = int(sys.argv[sys.argv.index("--drive-port") + 1])

    # 离屏模式（批9.5 2026-10-07）：窗口初始就在屏幕外（x/y=-3000）——渲染照常
    # （系统认为可见），PrintWindow 句柄级截图不受坐标影响（64KB 完整帧实测）；
    # 用于 UI 截图场景：零闪现零抢焦点，自动验证不打扰用户。
    # 修改预览模式（点选纠错，平台拉起，2026-10-08 批11）：可见窗口 + 页内点选层 +
    # 选区落盘；数据目录经 APP_DATA_DIR 指向平台准备的快照（原数据零接触）。
    # 驱动/探索模式回归修复（2026-10-08）：--drive-port 曾配 hidden=True——WebView2
    # hidden 下渲染循环暂停，js_api 回程（经 evaluate_js）在 click 类操作后挂起：
    # Python 侧已执行落库但 JS 侧 await 永不 resolve、后续 /eval 空回复（真机实证：
    # total_ml 落库而 /eval 挂死）。改屏幕外坐标（同 offscreen 路：渲染循环持续、
    # 回程可靠；零闪现零抢焦点不变）。
    correction_dir: Path | None = None
    if "--correction-session" in sys.argv:
        correction_dir = Path(sys.argv[sys.argv.index("--correction-session") + 1])
        os.environ.setdefault("APP_DATA_DIR", str(correction_dir / "data"))

    offscreen = "--offscreen" in sys.argv and not correction_dir

    logic = Logic()
    api = Api(logic, correction_dir)
    launch_url = str(UI_DIR / "index.html")
    if correction_dir:
        # 页面点选层凭 ?correction=1 启用；dport 供窄实时预览候选注入（/eval）
        launch_url += f"?correction=1&dport={drive_port}"
    elif drive_port:
        # drive 模式注入 dport：页面 Api 调用走 HTTP /call（绕开 pywebview js_api 回推
        # ——其回推与平台 /eval 的 evaluate_js 并发死锁，2026-10-08 真机实证）
        launch_url += f"?dport={drive_port}"
    window = webview.create_window(
        (f"修改预览 · {APP_NAME}" if correction_dir else APP_NAME),
        url=launch_url,  # 文件加载：ui/ 相对资产（kit.css/bridge.js）可引用
        js_api=api,
        width=960,
        height=640,
        # drive-port（非 correction）与 --offscreen 统一屏幕外坐标（2026-10-08 回归修复，
        # 勿改回 hidden：WebView2 hidden 渲染循环暂停，js 回程挂起）
        **({"x": -3000, "y": -3000} if (drive_port > 0 or offscreen) and not correction_dir else {}),
    )
    if drive_port:
        server = HTTPServer(("127.0.0.1", drive_port), make_drive_handler(window, api))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"DRIVE_SERVER 127.0.0.1:{drive_port}", flush=True)
    webview.start()
    return 0


if __name__ == "__main__":
    sys.exit(main())
