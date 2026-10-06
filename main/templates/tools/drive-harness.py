#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""drive-harness — 进程内驱动桥协议端（探索驱动测试 A 档 v2，2026-10-05）。

实施稿：BLOMA《Bloma-探索驱动测试实施稿-20261005》（§14 预审修订）+ 根因批
（同日晚，狗粮 5cb5e941 事故驱动）。被 drive_project_app 工具
（main/desktop/drive-app-tool.ts）spawn 在项目根上运行，stdin/stdout 走
JSON-lines 动词协议。本文件是平台打包资产（mainRootDir 解析，改后须 rebuild）。

v2（根因批）——两处升级：
1. **boot 模式（mainloop 接管）**：import 后无模块级 Tk 时，不再 no_root 拒绝，
   而是把 Tk.mainloop 替换为「协议泵循环」（drain stdin 动词 → root.update() →
   小睡）并调用模块真实入口（run()/main()/create_app()…）。效果：root 在哪创建
   都认、绑定与 after 主循环真实工作、退出走应用自身收尾路径——探索者驱动的
   就是用户双击运行的那个进程。（狗粮 5cb5e941：root 在 run() 内延迟创建，
   v1 五次 no_root 全败、冻结 bug 漏放。）
2. **module_state 可观测**：read 全量快照附带模块级状态树（含 app 对象 __dict__
   递归 dump，深度≤5、叶子≤250）——游戏类产物的分数/坐标等引擎状态第一次可读。

spike 实证（BLOMA/spike-drive-harness-20261005）：
- monkeypatch Tk.mainloop → 自由产物 import 后立即返回（v1 快照模式仍用）；
- withdrawn 窗口不投递 event_generate（deiconify 后投递）——bind-only/键盘操作须临时可见；
- invoke() 不抛回调异常（tkinter 吞进 report_callback_exception）——hook 后按响应增量上报。

协议约定：
- 请求：stdin 每行一个 JSON {"op": ..., ...}；响应：stdout 每行一个 JSON（fd 级写，
  ensure_ascii，被测程序 print 已重定向进内部缓冲）；
- 响应包络 {"ok": bool, "step": n, "op": ..., "data": ..., "err": {...},
  "app_exceptions": [...自上次响应以来的增量...]}；
- 机械动作成功（ok=true）与应用异常（app_exceptions 非空）并存，严重度由调用方判。
"""
from __future__ import annotations

import argparse
import importlib.util
import inspect
import io
import json
import os
import queue
import sys
import threading
import time
import traceback
import types

MAX_READ_FILE_BYTES = 64_000
MAX_LIST_ENTRIES = 500
MAX_LIST_DEPTH = 3
MAX_HOLD_MS = 2_000
OUTPUT_TAIL_CHARS = 2_000
PUMP_IDLE_SLEEP_S = 0.004
SKIP_DIRS = {".venv", "__pycache__", ".git", "node_modules", "archive", "00_VERIFY"}

_buf_out = io.StringIO()
_buf_err = io.StringIO()
_pending_exceptions: list[dict] = []
_modal_suppressed: list[dict] = []  # 驱动态吞掉的 messagebox 弹窗（发现⑦；按响应增量上报）

# messagebox 家族默认返回值（探索视角＝「用户点了确定性选项推进流程」；
# retrycancel 默认不重试避免死循环）
_MESSAGEBOX_DEFAULTS: dict = {
    "showinfo": "ok",
    "showwarning": "ok",
    "showerror": "ok",
    "askyesno": True,
    "askokcancel": True,
    "askretrycancel": False,
    "askquestion": "yes",
}


def _install_messagebox_shield() -> None:
    """驱动态模态拦截（2026-10-06 发现⑦根治，狗粮 1c953320/07e20970 双实证）：
    messagebox 家族是模态（grab + wait_window）——root 被 withdraw 时弹框不可见
    不可交互，回调阻塞泵主线程 → click 响应不写、后续动词全无响应（会话死锁）。
    在产物 import **之前** patch 模块函数（from tkinter.messagebox import showinfo
    拿到的就是拦截版）；吞弹窗按默认值返回并记录，read 响应 modal_suppressions
    增量上报。自建 Toplevel 模态不在本护罩内（挂账 D2：grab_current 监护）。"""
    try:
        import tkinter.messagebox as mb
    except Exception:
        return
    for name, default in _MESSAGEBOX_DEFAULTS.items():
        if getattr(mb, name, None) is None:
            continue

        def make_shield(fn_name: str, dft):
            def shield(title=None, message=None, **kwargs):  # noqa: ARG001
                _modal_suppressed.append({
                    "fn": fn_name,
                    "title": str(title or "")[:80],
                    "message": str(message or "")[:200],
                })
                return dft
            return shield

        setattr(mb, name, make_shield(name, default))


def _drain_modal_suppressions() -> list[dict]:
    drained = _modal_suppressed[:]
    _modal_suppressed.clear()
    return drained
_step = 0
_root = None  # 活动 tk.Tk
_module = None
_stop_pump = False  # boot 模式协议泵停止位（close 置位）
_MAX_MODULE_LEAVES = 250
_MAX_DUMP_DEPTH = 5

_BOOT_ENTRY_CANDIDATES = ("run", "main", "app_main", "start", "launch", "create_app")


def _write_line(payload: dict) -> None:
    data = (json.dumps(payload, ensure_ascii=True) + "\n").encode("ascii")
    while data:
        written = os.write(1, data)
        data = data[written:]


def _fail_open(error_class: str, message: str, tb: str | None = None) -> None:
    _write_line({"ready": False, "error": {"class": error_class, "message": message, **({"traceback": tb} if tb else {})}})


# ── 阶段一：import 被测模块（v1 快照模式与 v2 boot 模式共用）───────────────

def _import_entry(entry: str):
    """校验并 import 入口模块（不建窗口、不发 ready）。失败返回 None 并已发 fail_open。"""
    root_dir = os.getcwd()
    candidate = os.path.realpath(os.path.join(root_dir, entry))
    if os.path.isabs(entry) or not entry.endswith(".py") or not candidate.startswith(os.path.realpath(root_dir) + os.sep) or not os.path.isfile(candidate):
        _fail_open("bad_entry", f"entry 必须是项目根内已存在的 .py 相对路径（收到 {entry}）")
        return None

    try:
        import tkinter as tk
    except Exception as error:  # 环境无 tk
        _fail_open("no_tkinter", f"主机 python 无 tkinter：{error}")
        return None

    # offline-mainloop（spike 实证）：无 main guard、模块级直接 root.mainloop() 的
    # 自由产物也能被 import——mainloop 立即返回，UI 已在模块级建成（v1 快照模式）。
    # boot 模式随后会把 mainloop 再替换为协议泵（真实入口调用时生效）。
    tk.Tk.mainloop = lambda self, *args, **kwargs: None

    sys.path.insert(0, root_dir)
    # stdout 竞态根治（2026-10-06 发现③，狗粮 07e20970 实锤）：import 完不再恢复
    # sys.stdout——boot 泵运行期产物 after 回调（tick 等）的 print+flush 会直写协议
    # fd 1 与 JSON 响应交错（「协议行损坏」）。驱动态全程保持缓冲：协议响应走
    # _write_line 的 os.write 直写不受影响，产物运行期 print 反而经 read 的
    # stdout_tail 可观测。
    sys.stdout = _buf_out
    sys.stderr = _buf_err
    _install_messagebox_shield()
    spec = importlib.util.spec_from_file_location("__bloma_target__", candidate)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception:
        _fail_open("import_failed", f"入口模块执行抛异常：{entry}", traceback.format_exc())
        return None
    return module


def _install_exception_hook(root) -> None:
    """应用异常捕获（spike A1）：回调异常不外抛，hook 后按响应增量上报。"""

    def _record_exception(exc, value, tb) -> None:
        _pending_exceptions.append(
            {"type": exc.__name__ if exc else "Exception", "message": str(value), "traceback": "".join(traceback.format_exception(exc, value, tb))[:4000]}
        )

    root.report_callback_exception = _record_exception


def _send_ready(root, roots_all: int) -> None:
    _write_line(
        {
            "ready": True,
            "root_class": type(root).__name__,
            "mode": getattr(_root_mode, "value", "import"),
            "widgets_initial": len(_walk_widgets()),
            "roots_all": roots_all,
            "app_prints": _tail(_buf_out.getvalue()),
        }
    )


class _RootMode:
    value = "import"


_root_mode = _RootMode()


def _find_boot_entry(module):
    """在模块里找无必填参数的可调用入口（run/main/create_app…）。"""
    for name in _BOOT_ENTRY_CANDIDATES:
        candidate = getattr(module, name, None)
        if not callable(candidate) or isinstance(candidate, type):
            continue
        try:
            signature = inspect.signature(candidate)
        except (TypeError, ValueError):
            continue
        required = [
            param
            for param in signature.parameters.values()
            if param.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
            and param.default is inspect.Parameter.empty
        ]
        if not required:
            return candidate
    return None


# ── 控件工具 ────────────────────────────────────────────────────────────────

_KIND_MAP = {
    "Button": "button", "TButton": "button",
    "Entry": "entry", "TEntry": "entry", "Spinbox": "entry", "TSpinbox": "entry",
    "Text": "text",
    "Label": "label", "TLabel": "label",
    "Listbox": "select", "Combobox": "select", "TCombobox": "select",
    "Checkbutton": "select", "TCheckbutton": "select",
    "Radiobutton": "select", "TRadiobutton": "select",
    "Scale": "select", "TScale": "select",
    "Canvas": "canvas",
}


def _pump() -> None:
    if _root is None:
        return
    _root.update_idletasks()
    _root.update()


def _walk_widgets() -> list:
    acc: list = []

    def walk(parent) -> None:
        for child in parent.winfo_children():
            acc.append(child)
            walk(child)

    walk(_root)
    return acc


def _find_widget(target: str):
    for widget in _walk_widgets():
        if str(widget) == target:
            return widget
    return None


def _describe_widget(widget) -> dict:
    info = {"id": str(widget), "cls": widget.winfo_class(), "kind": _KIND_MAP.get(widget.winfo_class(), "other")}
    try:
        text = widget.cget("text")
        if isinstance(text, str) and text:
            info["text"] = text
    except Exception:
        pass
    kind = info["kind"]
    try:
        if kind == "entry":
            info["value"] = widget.get()
        elif kind == "text":
            info["value"] = widget.get("1.0", "end-1c")
        elif kind == "select":
            info["value"] = _select_value(widget)
    except Exception:
        pass
    try:
        state = widget.cget("state")
        if isinstance(state, str):
            info["state"] = state
    except Exception:
        pass
    return info


def _select_value(widget) -> object:
    cls = widget.winfo_class()
    if cls in ("Combobox", "TCombobox", "Scale", "TScale", "Spinbox", "TSpinbox"):
        return widget.get()
    if cls == "Listbox":
        selection = list(widget.curselection())
        values = widget.get(0, "end")
        return [values[i] for i in selection if 0 <= i < len(values)]
    try:
        var = widget.cget("variable")
        if isinstance(var, str) and var:
            return _root.getvar(var)
    except Exception:
        pass
    return None


def _tail(text: str) -> str:
    return text[-OUTPUT_TAIL_CHARS:]


def _module_state_dump() -> dict:
    """模块级状态树：标量全局 + app 对象 __dict__ 递归（深度≤5、叶子≤250）。

    只走 __dict__（不调 property/方法，零副作用）；tk 控件、模块、类、函数跳过。
    游戏类产物的分数/坐标等引擎状态由此可读（5cb5e941 根因批）。
    """
    out: dict = {}

    def is_widget(value) -> bool:
        return hasattr(value, "winfo_id")

    def capture(name: str, value, depth: int) -> None:
        if len(out) >= _MAX_MODULE_LEAVES or depth > _MAX_DUMP_DEPTH:
            return
        if not name or name.startswith("_"):
            return
        if value is None or isinstance(value, (bool, int, float, str)):
            out[name] = "None" if value is None else repr(value)[:160]
            return
        if isinstance(value, (list, tuple)) and len(value) <= 32:
            try:
                if all(item is None or isinstance(item, (bool, int, float, str)) for item in value):
                    out[name] = repr(value)[:160]
                    return
            except Exception:
                pass
        if isinstance(value, dict) and len(value) <= 32:
            try:
                if all(item is None or isinstance(item, (bool, int, float, str)) for item in value.values()):
                    out[name] = repr(value)[:160]
                    return
            except Exception:
                pass
        if callable(value) or isinstance(value, (type, types.ModuleType)) or is_widget(value):
            return
        try:
            items = list(vars(value).items())
        except Exception:
            # __slots__ 实例（游戏实体常见：Player/Bullet 等）：无 __dict__，按槽名 getattr 展开
            items = []
            slots = getattr(value, "__slots__", None)
            if isinstance(slots, (list, tuple)):
                for slot in slots:
                    if isinstance(slot, str):
                        try:
                            items.append((slot, getattr(value, slot)))
                        except Exception:
                            continue
            if not items:
                out[name] = repr(value)[:160]
                return
        for key, sub in items[:24]:
            capture(f"{name}.{key}", sub, depth + 1)

    if _module is not None:
        for name, value in list(vars(_module).items()):
            capture(name, value, 1)
    return {"leaves": out, "truncated": len(out) >= _MAX_MODULE_LEAVES}


# ── capture_window：同源拷贝自 driver-skeleton.py（2026-10-05 根治批）───────

def capture_window(tk_root, out_path: str) -> bool:
    try:
        import ctypes
        from ctypes import wintypes

        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass
        user32 = ctypes.windll.user32
        gdi32 = ctypes.windll.gdi32
        hwnd = user32.GetAncestor(int(tk_root.winfo_id()), 3)  # GA_ROOT=3 顶层句柄
        if not hwnd:
            return _capture_window_grab_fallback(tk_root, out_path)
        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return _capture_window_grab_fallback(tk_root, out_path)
        w, h = rect.right - rect.left, rect.bottom - rect.top
        if w <= 0 or h <= 0 or w > 8192 or h > 8192:
            return _capture_window_grab_fallback(tk_root, out_path)
        hdc = user32.GetWindowDC(hwnd)
        memdc = gdi32.CreateCompatibleDC(hdc)
        bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
        gdi32.SelectObject(memdc, bmp)
        ok = user32.PrintWindow(hwnd, memdc, 2) or user32.PrintWindow(hwnd, memdc, 0)
        if not ok:
            gdi32.DeleteObject(bmp)
            gdi32.DeleteDC(memdc)
            user32.ReleaseDC(hwnd, hdc)
            return _capture_window_grab_fallback(tk_root, out_path)

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
            return _capture_window_grab_fallback(tk_root, out_path)
        from PIL import Image

        img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1)
        img.convert("RGB").save(out_path, "PNG")
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(memdc)
        user32.ReleaseDC(hwnd, hdc)
        return True
    except Exception:
        return _capture_window_grab_fallback(tk_root, out_path)


def _capture_window_grab_fallback(tk_root, out_path: str) -> bool:
    try:
        from PIL import ImageGrab

        x, y = tk_root.winfo_rootx(), tk_root.winfo_rooty()
        w, h = tk_root.winfo_width(), tk_root.winfo_height()
        ImageGrab.grab(bbox=(x, y, x + w, y + h)).save(out_path, "PNG")
        return True
    except Exception:
        return False


# ── 动词实现 ────────────────────────────────────────────────────────────────

def _op_describe() -> dict:
    return {"widgets": [_describe_widget(w) for w in _walk_widgets()]}


def _schedule_modal_guard(delay_ms: int = 2500) -> None:
    """D2 自建 Toplevel 模态守护（2026-10-06 发现⑦补齐）：invoke() 同步执行产物
    command，回调弹自建模态（Toplevel+grab+wait_window）时主线程卡在模态局部
    事件循环——但该局部循环仍会处理 after 定时器（Tk 语义），故提前排一个守护：
    触发时若 grab_current 非空 → destroy 模态窗（wait_window 返回、回调继续、
    泵复活）并记录 _modal_suppressed。messagebox 家族已由 D1 护罩拦截，本守护
    兕底自建模态。产物回调后续若访问已销毁控件抛 TclError，由异常 hook 如实上报。"""
    def _guard() -> None:
        try:
            grabbed = _root.grab_current() if _root is not None else None
            if grabbed is not None:
                title = ""
                try:
                    title = str(grabbed.title())[:80] if hasattr(grabbed, "title") else str(grabbed)[:80]
                except Exception:
                    pass
                _modal_suppressed.append({
                    "fn": "toplevel_grab_destroyed",
                    "title": title,
                    "message": "自建模态对话框在驱动态被守护销毁（D2）；若需交互清验证弹窗路径请在无弹窗流程内完成",
                })
                try:
                    grabbed.destroy()
                except Exception:
                    pass
        except Exception:
            pass
    try:
        _root.after(delay_ms, _guard)
    except Exception:
        pass


def _op_click(target: str) -> dict:
    widget = _find_widget(target)
    if widget is None:
        raise _OpError("no_such_widget", f"控件不存在：{target}（先 describe 拿有效 id）")
    has_command = False
    if widget.winfo_class() in ("Button", "TButton"):
        try:
            has_command = bool(str(widget.cget("command")))
        except Exception:
            has_command = False
    if has_command:
        _schedule_modal_guard()
        widget.invoke()
        _pump()
    else:
        # spike B1/B2：withdrawn 窗口不投递 event_generate——临时可见再收回
        _root.deiconify()
        _pump()
        try:
            widget.event_generate("<ButtonPress-1>")
            _pump()
            widget.event_generate("<ButtonRelease-1>")
            _pump()
        finally:
            _root.withdraw()
    return {"clicked": target}


def _op_set_text(target: str, value: str) -> dict:
    widget = _find_widget(target)
    if widget is None:
        raise _OpError("no_such_widget", f"控件不存在：{target}")
    cls = widget.winfo_class()
    if cls in ("Entry", "TEntry", "Spinbox", "TSpinbox"):
        widget.delete(0, "end")
        widget.insert(0, value)
    elif cls == "Text":
        widget.delete("1.0", "end")
        widget.insert("1.0", value)
    else:
        raise _OpError("bad_argument", f"控件 {cls} 不支持 set_text（只支持 Entry/Text 家族）")
    _pump()
    return {"target": target, "value": value}


def _op_select(target: str, value: str) -> dict:
    widget = _find_widget(target)
    if widget is None:
        raise _OpError("no_such_widget", f"控件不存在：{target}")
    cls = widget.winfo_class()
    if cls in ("Combobox", "TCombobox", "Spinbox", "TSpinbox"):
        widget.set(value)
    elif cls == "Listbox":
        values = list(widget.get(0, "end"))
        if value in values:
            index = values.index(value)
            widget.selection_clear(0, "end")
            widget.selection_set(index)
            widget.see(index)
        widget.event_generate("<<ListboxSelect>>")
    elif cls in ("Checkbutton", "TCheckbutton"):
        if str(value).strip().lower() in ("1", "true", "on", "yes"):
            widget.select()
        else:
            widget.deselect()
    elif cls in ("Radiobutton", "TRadiobutton"):
        widget.select()
    elif cls in ("Scale", "TScale"):
        widget.set(float(value))
    else:
        raise _OpError("bad_argument", f"控件 {cls} 不支持 select")
    _pump()
    return {"target": target, "value": value}


def _hold(ms: int) -> None:
    """按住等待：泵继续跑（after 回调/渲染继续），到点返回。"""
    deadline = time.time() + max(0, min(ms, MAX_HOLD_MS)) / 1000.0
    while time.time() < deadline:
        try:
            _root.update_idletasks()
            _root.update()
        except Exception:
            return
        time.sleep(0.008)


def _op_keys(target: str, sequence: str, hold_ms: int) -> dict:
    if not sequence:
        raise _OpError("bad_argument", "keys 需要键名（value，空格分隔，如 'Left a space'）")
    widget = _find_widget(target) if target else None
    tokens = sequence.split()
    # 键盘事件需窗口可见且有焦点（withdrawn 不投递，同 spike B1/B2）
    _root.deiconify()
    _pump()
    try:
        (widget if widget is not None else _root).focus_set()
        _pump()
        focus_target = _root.focus_get() or _root
        for token in tokens:
            extra = {"char": token} if len(token) == 1 else {}
            focus_target.event_generate("<KeyPress>", keysym=token, **extra)
            _pump()
        if hold_ms > 0:
            _hold(hold_ms)
        for token in tokens:
            extra = {"char": token} if len(token) == 1 else {}
            focus_target.event_generate("<KeyRelease>", keysym=token, **extra)
            _pump()
    finally:
        _root.withdraw()
    return {"keys": sequence, "hold_ms": hold_ms}


def _op_read(target: str | None) -> dict:
    if target:
        widget = _find_widget(target)
        if widget is None:
            raise _OpError("no_such_widget", f"控件不存在：{target}")
        return {"widget": _describe_widget(widget)}
    return {
        "widgets": [_describe_widget(w) for w in _walk_widgets()],
        "module_state": _module_state_dump(),
        "stdout_tail": _tail(_buf_out.getvalue()),
        "stderr_tail": _tail(_buf_err.getvalue()),
    }


def _op_list_files() -> dict:
    entries: list[dict] = []
    root_dir = os.path.realpath(os.getcwd())

    def visit(directory: str, depth: int) -> None:
        if depth > MAX_LIST_DEPTH or len(entries) >= MAX_LIST_ENTRIES:
            return
        try:
            names = sorted(os.listdir(directory))
        except Exception:
            return
        for name in names:
            if len(entries) >= MAX_LIST_ENTRIES:
                return
            full = os.path.join(directory, name)
            rel = os.path.relpath(full, root_dir).replace(os.sep, "/")
            try:
                stat = os.stat(full)
            except Exception:
                continue
            entries.append({"path": rel, "size": stat.st_size, "mtime": int(stat.st_mtime)})
            if os.path.isdir(full) and name not in SKIP_DIRS:
                visit(full, depth + 1)

    visit(root_dir, 0)
    return {"files": entries, "truncated": len(entries) >= MAX_LIST_ENTRIES}


def _op_read_file(path: str) -> dict:
    root_dir = os.path.realpath(os.getcwd())
    target = os.path.realpath(os.path.join(root_dir, path))
    if os.path.isabs(path) or not target.startswith(root_dir + os.sep):
        raise _OpError("bad_argument", f"read_file 只开放项目根内相对路径（收到 {path}）")
    try:
        with open(target, "r", encoding="utf-8", errors="replace") as handle:
            content = handle.read(MAX_READ_FILE_BYTES)
    except Exception as error:
        raise _OpError("io", f"读取失败 {path}：{error}")
    return {"path": path, "content": content, "truncated": len(content) >= MAX_READ_FILE_BYTES}


def _op_screenshot(rel_path: str) -> dict:
    root_dir = os.path.realpath(os.getcwd())
    target = os.path.realpath(os.path.join(root_dir, rel_path))
    if os.path.isabs(rel_path) or not target.startswith(root_dir + os.sep) or not target.lower().endswith(".png"):
        raise _OpError("bad_argument", f"screenshot 路径须为项目根内 .png 相对路径（收到 {rel_path}）")
    os.makedirs(os.path.dirname(target) or root_dir, exist_ok=True)
    _root.deiconify()
    _pump()
    try:
        ok = capture_window(_root, target)
    finally:
        _root.withdraw()
    if not ok:
        raise _OpError("io", f"截图失败（PrintWindow 与 ImageGrab 兜底均未产出）")
    size = os.path.getsize(target)
    return {"path": rel_path, "bytes": size}


class _OpError(Exception):
    def __init__(self, error_class: str, message: str) -> None:
        super().__init__(message)
        self.error_class = error_class
        self.message = message


# ── 协议调度（v1 同步循环与 v2 协议泵共用）─────────────────────────────────

def _dispatch(request: dict) -> dict:
    op = request.get("op")
    if op == "ping":
        return {"pong": True}
    if op == "describe":
        return _op_describe()
    if op == "click":
        return _op_click(str(request.get("target", "")))
    if op == "set_text":
        return _op_set_text(str(request.get("target", "")), str(request.get("value", "")))
    if op == "select":
        return _op_select(str(request.get("target", "")), str(request.get("value", "")))
    if op == "keys":
        target = request.get("target")
        try:
            hold_ms = int(request.get("hold_ms", 0) or 0)
        except (TypeError, ValueError):
            hold_ms = 0
        return _op_keys(str(target) if target else "", str(request.get("value", "")), hold_ms)
    if op == "read":
        target = request.get("target")
        return _op_read(str(target) if target else None)
    if op == "list_files":
        return _op_list_files()
    if op == "read_file":
        return _op_read_file(str(request.get("path", "")))
    if op == "screenshot":
        return _op_screenshot(str(request.get("path", "")))
    raise _OpError("bad_argument", f"未知 op：{op!r}")


def _drain_exceptions() -> list[dict]:
    drained = _pending_exceptions[:]
    _pending_exceptions.clear()
    return drained


def _respond(op: str, data: dict | None, error: dict | None = None) -> None:
    global _step
    payload = {
        "ok": error is None,
        "step": _step,
        "op": op,
        "app_exceptions": _drain_exceptions(),
        "modal_suppressions": _drain_modal_suppressions(),
    }
    if error is not None:
        payload["err"] = error
    else:
        payload["data"] = data
    _write_line(payload)


def _handle_line(line: str) -> str:
    """处理一行协议请求；返回 'continue' 或 'close'。"""
    global _step
    _step += 1
    try:
        request = json.loads(line)
        if not isinstance(request, dict):
            raise ValueError("请求须为 JSON 对象")
    except ValueError as error:
        _respond("?", None, {"class": "bad_argument", "message": f"协议行不是合法 JSON 对象：{error}"})
        return "continue"
    op = str(request.get("op", ""))
    if op == "close":
        _respond("close", {"closed": True})
        return "close"
    try:
        data = _dispatch(request)
        _respond(op, data)
    except _OpError as op_error:
        _respond(op, None, {"class": op_error.error_class, "message": op_error.message})
    except Exception:
        _respond(op, None, {"class": "harness_panic", "message": "动词执行意外异常", "traceback": traceback.format_exc()[:4000]})
    return "continue"


def _serve_stdin_sync() -> None:
    """v1 快照模式：阻塞读 stdin，逐行处理（每动词后由调用方泵）。"""
    global _stop_pump
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        if _handle_line(line) == "close":
            _stop_pump = True
            return


def _serve_pump() -> None:
    """v2 boot 模式协议泵：读者线程收行，主线程 drain+泵 root（after 循环真实运行）。"""
    global _stop_pump
    lines: "queue.Queue[str]" = queue.Queue()

    def reader() -> None:
        try:
            for raw_line in sys.stdin:
                lines.put(raw_line.strip())
        except Exception:
            pass

    threading.Thread(target=reader, daemon=True).start()
    while not _stop_pump:
        try:
            while True:
                line = lines.get_nowait()
                if not line:
                    continue
                if _handle_line(line) == "close":
                    _stop_pump = True
                    return
        except queue.Empty:
            pass
        try:
            _root.update_idletasks()
            _root.update()
        except Exception:
            # root 被应用自行销毁（如 after 回调内 destroy）：会话自然终结
            _stop_pump = True
            return
        time.sleep(PUMP_IDLE_SLEEP_S)


# ── 主流程：v1 快照模式 / v2 boot 模式（mainloop 接管）─────────────────────

def main() -> int:
    global _root, _module, _stop_pump, _root_mode
    parser = argparse.ArgumentParser(description="Bloma drive-harness（进程内驱动桥 v2）")
    parser.add_argument("--entry", required=True, help="项目根内被测入口 .py 相对路径")
    args = parser.parse_args()

    module = _import_entry(args.entry)
    if module is None:
        return 1
    _module = module
    import tkinter as tk

    roots = [value for value in vars(module).values() if isinstance(value, tk.Tk)]
    entry_fn = _find_boot_entry(module)

    # v2 根因批（5cb5e941 实证）：boot 优先——模块级窗口存在但主循环在 run() 里
    # 启动的产物（只建窗不进循环是常见纪律），快照模式下循环永远不跑、驱动的是一个
    # 「死窗口」。有入口就调真实路径（循环/绑定/收尾全真实）；入口不可用才回落快照。
    if entry_fn is None:
        if roots:
            _serve_import_snapshot(roots)
            return 0
        _fail_open(
            "no_root",
            "模块无窗口且未找到无参入口（run/main/app_main/start/launch/create_app）——"
            "入口需模块级创建窗口，或提供 run() 等入口供平台驱动接管",
        )
        return 1

    boot_state = {"started": False}

    def _boot_mainloop(self, *args, **kwargs):
        global _root, _root_mode
        _root = self
        _root_mode.value = "boot"
        _install_exception_hook(self)
        try:
            self.withdraw()  # 静默纪律
        except Exception:
            pass
        try:
            self.update_idletasks()
            self.update()
        except Exception:
            pass
        _send_ready(self, 1)
        boot_state["started"] = True
        _serve_pump()  # 阻塞至 close / root 销毁

    tk.Tk.mainloop = _boot_mainloop
    try:
        entry_fn()
    except SystemExit:
        pass
    except Exception:
        if not boot_state["started"] and not roots:
            _fail_open("boot_failed", "入口执行抛异常（未到达 mainloop）", traceback.format_exc())
            return 1
        # 入口失败但模块级窗口在（import 期已建）：回落快照模式而非直接判死
        if not boot_state["started"] and roots:
            _serve_import_snapshot(roots)
            return 0
        return 0  # 会话已服务过，如实退出

    if boot_state["started"]:
        return 0

    # 入口没调 mainloop（如 create_app 风格建完即返回）→ 快照模式服务现有窗口
    roots_after = [value for value in vars(module).values() if isinstance(value, tk.Tk)] or roots
    if roots_after:
        _serve_import_snapshot(roots_after)
        return 0

    _fail_open("no_root", "入口执行后仍未发现窗口（run/main 未创建 Tk 或窗口为局部变量未暴露）")
    return 1


def _serve_import_snapshot(roots: list) -> None:
    """v1 快照模式：接管 import 期已存在的模块级窗口（无入口或入口未达 mainloop 时）。"""
    global _root, _stop_pump
    _root = roots[0]
    _root_mode.value = "import"
    _install_exception_hook(_root)
    _root.withdraw()
    _pump()
    _send_ready(_root, len(roots))
    _serve_stdin_sync()
    try:
        _root.destroy()
    except Exception:
        pass


if __name__ == "__main__":
    sys.exit(main())
