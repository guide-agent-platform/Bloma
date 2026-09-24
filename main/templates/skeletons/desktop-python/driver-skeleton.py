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
