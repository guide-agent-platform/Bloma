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
      python app.py --drive-port N        探索驱动模式（隐藏窗口 + 127.0.0.1 控制服务器，
                                          POST /eval {"js":...} → evaluate_js；平台探索桥用）

依赖：pywebview（pip）+ 系统 WebView2（Win10+ 自带）。禁 npm/CDN/外链字体——ui/ 全本地。
"""

from __future__ import annotations

import json
import sys
import threading
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

    def __init__(self, logic: Logic) -> None:
        self._logic = logic

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
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) or b"{}"
            try:
                payload = json.loads(raw.decode("utf-8"))
            except UnicodeDecodeError:
                # 客户端编码容错（GBK 控制台 curl 实测会踩）：utf-8 失败回退 gbk
                payload = json.loads(raw.decode("gbk", errors="replace"))
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
    # 用于 UI 截图场景：零闪现零抢焦点，自动验证不打扰用户。与 --drive-port 可叠加
    # （叠加时 hidden 优先——驱动/探索模式不需要可见渲染帧）。
    offscreen = "--offscreen" in sys.argv

    logic = Logic()
    api = Api(logic)
    window = webview.create_window(
        APP_NAME,
        url=str(UI_DIR / "index.html"),  # 文件加载：ui/ 相对资产（kit.css/bridge.js）可引用
        js_api=api,
        width=960,
        height=640,
        hidden=drive_port > 0,
        **({"x": -3000, "y": -3000} if offscreen and not drive_port else {}),
    )
    if drive_port:
        server = HTTPServer(("127.0.0.1", drive_port), make_drive_handler(window, api))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"DRIVE_SERVER 127.0.0.1:{drive_port}", flush=True)
    webview.start()
    return 0


if __name__ == "__main__":
    sys.exit(main())
