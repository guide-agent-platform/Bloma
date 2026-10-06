"""驱动断言骨架（Bloma 桌面品类）——GWT 场景的可执行断言，先写断言后写实现。

纪律（desktop-scaffold 阶段任务书）：
- 每个 GWT 场景一个 assert_* 函数；断言先于实现存在，实现阶段的目标就是让它变绿；
- 退出码契约（失败三分类路由的判定源）：
    0 = 全部通过（PASS）
    1 = 有断言失败（FAIL——路由进修复轮）
    2 = 环境阻塞（BLOCKED——组件缺失/解释器不可用等，不进修复轮）
- 输出锚点用 ASCII（GBK 控制台乱码是显示噪音；驱动读回比较不依赖中文显示）；
- 本骨架只做结构：断言体在 implement/verify 阶段填充，scaffold 阶段保留场景清单。
"""

from __future__ import annotations

import sys


# ── 窗口自截助手（平台内置，2026-10-05：driver 场景截图一律用它，不要自己写 ImageGrab）──
# 句柄级 PrintWindow 捕获：被遮挡也截得到自己（ImageGrab 抓屏幕区域，被覆盖就
# 截到覆盖物）；DPI 感知输出物理分辨率。失败链：PrintWindow → ImageGrab 兼底 → False
# （调用方按约定降级 SKIP，如实标注，不阻塞断言）。
def capture_window(window_title: str, out_path: str) -> bool:
    """按窗口标题句柄捕获（批8：webview 宿主窗口同样适用——FindWindowW 靠标题找顶层窗口）。"""
    try:
        import ctypes
        from ctypes import wintypes

        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass
        user32 = ctypes.windll.user32
        gdi32 = ctypes.windll.gdi32
        hwnd = user32.FindWindowW(None, window_title)  # 批8：标题找顶层窗口（tkinter/webview 通用）
        if not hwnd:
            return _capture_window_grab_fallback(window_title, out_path)
        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return _capture_window_grab_fallback(window_title, out_path)
        w, h = rect.right - rect.left, rect.bottom - rect.top
        if w <= 0 or h <= 0 or w > 8192 or h > 8192:
            return _capture_window_grab_fallback(window_title, out_path)
        hdc = user32.GetWindowDC(hwnd)
        memdc = gdi32.CreateCompatibleDC(hdc)
        bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
        gdi32.SelectObject(memdc, bmp)
        ok = user32.PrintWindow(hwnd, memdc, 2) or user32.PrintWindow(hwnd, memdc, 0)
        if not ok:
            gdi32.DeleteObject(bmp)
            gdi32.DeleteDC(memdc)
            user32.ReleaseDC(hwnd, hdc)
            return _capture_window_grab_fallback(window_title, out_path)

        class _BMIH(ctypes.Structure):
            _fields_ = [
                ("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG),
                ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD),
            ]

        bmi = _BMIH()
        bmi.biSize = ctypes.sizeof(_BMIH)
        bmi.biWidth, bmi.biHeight = w, -h  # top-down
        bmi.biPlanes, bmi.biBitCount, bmi.biCompression = 1, 32, 0
        buf = ctypes.create_string_buffer(w * h * 4)
        if not gdi32.GetDIBits(memdc, bmp, 0, h, buf, ctypes.byref(bmi), 0):
            gdi32.DeleteObject(bmp)
            gdi32.DeleteDC(memdc)
            user32.ReleaseDC(hwnd, hdc)
            return _capture_window_grab_fallback(window_title, out_path)
        from PIL import Image

        img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1)
        img.convert("RGB").save(out_path, "PNG")
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(memdc)
        user32.ReleaseDC(hwnd, hdc)
        return True
    except Exception:
        return _capture_window_grab_fallback(window_title, out_path)


def _capture_window_grab_fallback(window_title: str, out_path: str) -> bool:
    """兼容兜底（非 Windows / 句柄路径失败）：按标题定位窗口矩形后 ImageGrab 抓拍。"""
    try:
        import ctypes
        from ctypes import wintypes
        from PIL import ImageGrab

        user32 = ctypes.windll.user32
        hwnd = user32.FindWindowW(None, window_title)
        if not hwnd:
            return False
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        x, y, w, h = rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top
        ImageGrab.grab(bbox=(x, y, x + w, y + h)).save(out_path, "PNG")
        return True
    except Exception:
        return False


# ── 场景登记表（scaffold 阶段填场景名，implement 阶段接断言函数）──
# 形态：assert 函数注册进 SCENARIOS 后自动被 main 调度。
SCENARIOS: list[dict] = [
    {
        "name": "skeleton.self-check",  # 预置场景：骨架自检冒烟
        "given": "骨架已复制且依赖按 requirements.txt 装配",
        "when": "执行 python app.py --self-check",
        "then": "退出码 0 且输出含 SELF-CHECK-OK",
        "assert": "assert_self_check_smoke",
    },
    # implement 阶段在此追加 PRD 场景（示例形态）：
    # {
    #     "name": "tray.launch-visible",
    #     "given": "托盘组件已启用",
    #     "when": "启动主程序",
    #     "then": "N 秒内托盘进程存活且无崩溃退出",
    #     "assert": "assert_tray_launch_visible",
    # },
]


def assert_self_check_smoke() -> None:
    """预置场景：调用 app.self_check()，非 0 即失败（阻塞码原样上抛）。"""
    import app

    code = app.self_check()
    if code == 2:
        raise Blocked("self-check 报告组件缺失（环境阻塞）")
    assert code == 0, f"self-check 退出码 {code}（预期 0）"


class Blocked(Exception):
    """环境阻塞分类（退出码 2）——与断言失败（退出码 1）严格分流。"""


def main() -> int:
    failed: list[str] = []
    blocked: list[str] = []

    registry = {name: fn for name, fn in globals().items() if name.startswith("assert_")}
    for scenario in SCENARIOS:
        name = scenario["name"]
        fn = registry.get(scenario["assert"])
        if fn is None:
            # 场景已登记但断言未实现：属骨架未完成（scaffold 阶段可接受，
            # verify 阶段由工程契约门禁拦截——此处在输出里显影，不静默）
            print(f"SKIP {name} (assert not implemented: {scenario['assert']})")
            continue
        try:
            fn()
            print(f"PASS {name}")
        except Blocked as exc:
            blocked.append(name)
            print(f"BLOCKED {name}: {exc}")
        except AssertionError as exc:
            failed.append(name)
            print(f"FAIL {name}: {exc}")
        except Exception as exc:  # 非预期异常按 FAIL 分类（驱动自身缺陷也需修复）
            failed.append(name)
            print(f"FAIL {name}: unexpected {type(exc).__name__}: {exc}")

    print(f"SUMMARY pass={len(SCENARIOS) - len(failed) - len(blocked)} fail={len(failed)} blocked={len(blocked)}")
    if blocked:
        return 2
    if failed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
