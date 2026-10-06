"""ui_kit — 设计 token 与通用体验组件（UX 契约线，2026-10-06）。

为什么有这个文件：LLM 自由发挥的 tkinter 配色/间距/反馈方式每单都不同，
且最容易出「正常流用 messagebox 弹窗」「错误没有可见反馈」「部分成功瞒报」
这类体验缺陷。平台把设计决策收进来：颜色角色/间距/字号是 token（改主题改这里），
状态条/空态/结果摘要/错误面板是组件（照用，不自造）。

用法（implement 阶段任务书纪律）：
- from ui_kit import Theme, StatusBanner, EmptyState, ResultSummary, ErrorPanel, disable_while_running
- root 建好后先 Theme.apply(root)（含 tk scaling 补偿，配合 app.py 的 enable_hidpi）；
- 反馈一律走窗口内组件（StatusBanner / ResultSummary / ErrorPanel），**禁用 messagebox
  当正常流反馈**（错误弹窗会卡死无头驱动，也会打断用户操作流——它是异常处理器不是通知器）；
- 长任务：threading + queue + root.after(100, poll) 轮询回传进度，禁止在回调里同步长计算
  （主线程阻塞 = 窗口「未响应」）；触发按钮执行中禁用防重复提交。
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk


class Theme:
    """设计 token（颜色角色/间距/字号）。业务代码只引用语义角色，不写裸色值。"""

    # 颜色角色（克制三色 + 中性面：主操作一个主色，状态用绿/红/黄，其余灰阶）
    window_bg = "#f5f6f8"
    surface = "#ffffff"
    primary = "#2563eb"        # 主操作（一个界面只有一个主按钮用它）
    primary_active = "#1d4ed8"
    text = "#1f2937"
    text_secondary = "#6b7280"
    success = "#16a34a"
    success_bg = "#ecfdf5"
    warning = "#d97706"
    warning_bg = "#fffbeb"
    error = "#dc2626"
    error_bg = "#fef2f2"
    disabled = "#9ca3af"

    # 间距（4 的倍数；页面边距 24，分组间 16，控件间 8）
    pad_page = 24
    pad_group = 16
    pad_item = 8

    # 字号（pt；标题 14 / 正文 10 / 辅助 9）——中文界面用雅黑族，缺字体系统自动回退
    font_title = ("Microsoft YaHei UI", 14, "bold")
    font_body = ("Microsoft YaHei UI", 10)
    font_help = ("Microsoft YaHei UI", 9)

    @staticmethod
    def apply(root: tk.Tk, scale: float = 1.0) -> None:
        """应用主题底色 + tk scaling 补偿（scale 来自 app.py enable_hidpi() 返回值）。"""
        root.configure(bg=Theme.window_bg)
        if scale and scale > 0:
            root.tk.call("tk", "scaling", scale * 96.0 / 72.0)
        style = ttk.Style(root)
        try:
            style.theme_use("clam")  # 跨机器观感稳定（默认主题随系统漂移）
        except tk.TclError:
            pass


class StatusBanner(tk.Frame):
    """窗口内状态条：进行中/成功/失败/警告的即时反馈位（替代弹窗的正常流反馈）。"""

    def __init__(self, parent: tk.Widget) -> None:
        super().__init__(parent, bg=Theme.surface)
        self._label = tk.Label(
            self, text="", font=Theme.font_body, bg=Theme.surface,
            fg=Theme.text_secondary, anchor="w", justify="left", padx=12, pady=8,
        )
        self._label.pack(fill="both", expand=True)
        self.hide()

    def _show(self, text: str, fg: str, bg: str) -> None:
        self._label.configure(text=text, fg=fg, bg=bg)
        self.configure(bg=bg)
        self.pack(fill="x", padx=Theme.pad_page, pady=(0, Theme.pad_item))

    def running(self, text: str) -> None:
        """进行中（耗时操作必给反馈；同时用 disable_while_running 禁触发按钮防重复提交）。"""
        self._show(text, Theme.primary, Theme.surface)

    def success(self, text: str) -> None:
        self._show(text, Theme.success, Theme.success_bg)

    def warning(self, text: str) -> None:
        self._show(text, Theme.warning, Theme.warning_bg)

    def error(self, text: str, next_step: str = "") -> None:
        """失败：给原因 + 下一步（「原始数据未修改」这类安心声明也写在这里）。"""
        self._show(text if not next_step else f"{text}\n下一步：{next_step}", Theme.error, Theme.error_bg)

    def hide(self) -> None:
        self.pack_forget()


class EmptyState(tk.Frame):
    """空态引导：无数据时告诉用户「这是什么、从哪开始」，而不是一片空白。"""

    def __init__(self, parent: tk.Widget, title: str, hint: str) -> None:
        super().__init__(parent, bg=Theme.window_bg)
        tk.Label(self, text=title, font=Theme.font_title, bg=Theme.window_bg, fg=Theme.text).pack()
        tk.Label(self, text=hint, font=Theme.font_help, bg=Theme.window_bg, fg=Theme.text_secondary).pack(pady=(4, 0))

    def show(self) -> None:
        self.pack(fill="both", expand=True)

    def hide(self) -> None:
        self.pack_forget()


class ResultSummary(tk.Frame):
    """结果摘要：成功/部分成功给数量与位置（「已处理 24 个，跳过 2 个，结果在 D:\\out」）。"""

    def __init__(self, parent: tk.Widget) -> None:
        super().__init__(parent, bg=Theme.window_bg)
        self._var = tk.StringVar(value="")
        tk.Label(
            self, textvariable=self._var, font=Theme.font_body, bg=Theme.window_bg,
            fg=Theme.text, anchor="w", justify="left",
        ).pack(fill="x")

    def show(self, lines: list[str]) -> None:
        self._var.set("\n".join(lines))
        self.pack(fill="x", padx=Theme.pad_page)

    def hide(self) -> None:
        self.pack_forget()


class ErrorPanel(tk.Frame):
    """错误详情面板：失败明细列表（哪些项失败、为什么、怎么重试）。"""

    def __init__(self, parent: tk.Widget) -> None:
        super().__init__(parent, bg=Theme.error_bg)
        self._text = tk.Text(
            self, height=5, font=Theme.font_help, bg=Theme.error_bg, fg=Theme.error,
            relief="flat", wrap="word", state="disabled", padx=8, pady=6,
        )
        self._text.pack(fill="both", expand=True)

    def show(self, lines: list[str]) -> None:
        self._text.configure(state="normal")
        self._text.delete("1.0", "end")
        for line in lines:
            self._text.insert("end", f"• {line}\n")
        self._text.configure(state="disabled")
        self.pack(fill="both", expand=True, padx=Theme.pad_page)

    def hide(self) -> None:
        self.pack_forget()


def disable_while_running(*widgets: tk.Widget) -> None:
    """执行中防重复提交：禁用触发控件（Entry/Text 也会被禁——通常正是想要的行为）。"""
    for widget in widgets:
        try:
            widget.configure(state="disabled")
        except tk.TclError:
            pass


def enable_after_running(*widgets: tk.Widget) -> None:
    for widget in widgets:
        try:
            widget.configure(state="normal")
        except tk.TclError:
            pass
