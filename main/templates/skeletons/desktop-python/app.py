"""桌面程序主程序骨架（Bloma 桌面品类 P1·Python 快速验证）。

骨架纪律（desktop-scaffold 阶段任务书）：
- 只做结构不做业务：业务逻辑在 desktop-implement 阶段按 PRD 背板补齐；
- 组件按 00_ARCH/env-checklist.json 的结论接入——确认启用的组件取消对应注释块，
  未确认组件保持注释态（禁止提前引入）；
- 所有用户可见文案走 UTF-8（GBK 控制台乱码是显示噪音，不影响字节流）。

自检模式：python app.py --self-check
  打包冒烟与驱动探活共用（退出码 0=骨架完整；打印 ASCII 锚点 SELF-CHECK-OK）。
"""

from __future__ import annotations

import sys


def enable_hidpi() -> float:
    """声明 Windows DPI 感知（骨架纪律，2026-10-05 坑库 [实证]）。

    python.exe 不声明 DPI 感知：高分屏（如 150% 缩放）下系统对整个窗口做位图拉伸
    兼容，文字与控件发虚（「程序分辨率低」的根因，与 tkinter 无关）。在任何 Tk()
    创建之前调用本函数；返回缩放系数供 tk scaling 补偿（1.0=无缩放/非 Windows）。
    """
    try:
        from ctypes import windll

        windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_DPI_AWARE
        return float(windll.shcore.GetScaleFactorForDevice(0)) / 100.0
    except Exception:
        return 1.0


APP_NAME = "{{project_name}}"
APP_VERSION = "0.1.0-skeleton"


def self_check() -> int:
    """骨架自检：组件导入面按需扩展（启用一个组件加一条 import 探测）。"""
    checks: list[tuple[str, bool]] = []

    # ── 组件接入位（按 env-checklist 结论取消注释；探测失败属「阻塞」分类）──
    # try:
    #     import pystray  # noqa: F401
    #     checks.append(("pystray", True))
    # except ImportError:
    #     checks.append(("pystray", False))
    # try:
    #     import pynput  # noqa: F401
    #     checks.append(("pynput", True))
    # except ImportError:
    #     checks.append(("pynput", False))
    # try:
    #     import sounddevice  # noqa: F401
    #     checks.append(("sounddevice", True))
    # except ImportError:
    #     checks.append(("sounddevice", False))
    # try:
    #     import winotify  # noqa: F401
    #     checks.append(("winotify", True))
    # except ImportError:
    #     checks.append(("winotify", False))

    failed = [name for name, ok in checks if not ok]
    for name, ok in checks:
        print(f"component {name}: {'ok' if ok else 'MISSING'}")
    if failed:
        print(f"SELF-CHECK-FAIL missing={','.join(failed)}")
        return 2  # 阻塞分类（环境缺失）
    print("SELF-CHECK-OK")
    return 0


def main() -> int:
    if "--self-check" in sys.argv[1:]:
        return self_check()

    # ── 主程序结构（desktop-implement 阶段实现；以下为线程模型范式）──
    # 范式（pystray 实测结论）：icon.run() 阻塞主线程，业务线程 daemon 化，
    # stop() 从其他线程调用。托盘自停探活示例见 00_SPIKES 记录。
    #
    # GUI 入口纪律（坑库 [实证]）：任何窗口创建前先 enable_hidpi()，并据返回值
    # 补偿 tk scaling（并按需缩放自绘尺寸），否则高分屏发虚或控件偏小：
    #
    # import tkinter as tk
    # scale = enable_hidpi()
    # root = tk.Tk()
    # root.tk.call("tk", "scaling", scale * 96.0 / 72.0)
    #
    # import threading
    # import pystray
    # from PIL import Image
    #
    # def business_loop() -> None:
    #     ...  # 业务逻辑（implement 阶段填充）
    #
    # icon = pystray.Icon(
    #     APP_NAME,
    #     Image.new("RGB", (16, 16), color=(66, 133, 244)),
    #     title=APP_NAME,
    # )
    # threading.Thread(target=business_loop, daemon=True).start()
    # icon.run()  # 阻塞直至 icon.stop()
    print(f"{APP_NAME} v{APP_VERSION} skeleton — implement me (desktop-implement stage)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
