#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""drive-harness — 进程内驱动桥协议端（探索驱动测试 A 档，2026-10-05）。

实施稿：BLOMA《Bloma-探索驱动测试实施稿-20261005》。被 drive_project_app 工具
（main/desktop/drive-app-tool.ts）spawn 在项目根上运行：import 被测入口模块
（offline-mainloop 纪律），stdin/stdout 走 JSON-lines 动词协议，探索子会话
逐步操控控件并读取状态。本文件是平台打包资产（mainRootDir 解析，改后须 rebuild）。

spike 实证（BLOMA/spike-drive-harness-20261005，2026-10-05 十项全绿）：
- monkeypatch Tk.mainloop → 无 main guard 的自由产物 import 后立即返回；
- withdrawn 窗口不投递 event_generate（deiconify 后投递）——bind-only 控件兜底须临时可见；
- invoke() 不抛回调异常（tkinter 吞进 report_callback_exception）——hook 后按响应增量上报。

协议约定：
- 请求：stdin 每行一个 JSON {"op": ..., ...}；响应：stdout 每行一个 JSON（fd 级写，
  ensure_ascii，被测程序的 print 已被重定向进内部缓冲，不污染协议线）；
- 响应包络 {"ok": bool, "step": n, "op": ..., "data": ..., "err": {...},
  "app_exceptions": [...自上次响应以来的增量...]}；
- 机械动作成功（ok=true）与应用异常（app_exceptions 非空）并存，严重度由调用方判。
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import os
import sys
import traceback

MAX_READ_FILE_BYTES = 64_000
MAX_LIST_ENTRIES = 500
MAX_LIST_DEPTH = 3
OUTPUT_TAIL_CHARS = 2_000
SKIP_DIRS = {".venv", "__pycache__", ".git", "node_modules", "archive", "00_VERIFY"}

_buf_out = io.StringIO()
_buf_err = io.StringIO()
_pending_exceptions: list[dict] = []
_step = 0
_root = None  # 活动 tk.Tk
_module = None


def _write_line(payload: dict) -> None:
    data = (json.dumps(payload, ensure_ascii=True) + "\n").encode("ascii")
    while data:
        written = os.write(1, data)
        data = data[written:]


def _fail_open(error_class: str, message: str, tb: str | None = None) -> None:
    _write_line({"ready": False, "error": {"class": error_class, "message": message, **({"traceback": tb} if tb else {})}})


# ── 初始化：import 被测模块并发现 root ──────────────────────────────────────

def _initialize(entry: str) -> bool:
    global _root, _module
    root_dir = os.getcwd()

    candidate = os.path.realpath(os.path.join(root_dir, entry))
    if os.path.isabs(entry) or not entry.endswith(".py") or not candidate.startswith(os.path.realpath(root_dir) + os.sep) or not os.path.isfile(candidate):
        _fail_open("bad_entry", f"entry 必须是项目根内已存在的 .py 相对路径（收到 {entry}）")
        return False

    try:
        import tkinter as tk
    except Exception as error:  # 环境无 tk
        _fail_open("no_tkinter", f"主机 python 无 tkinter：{error}")
        return False

    # offline-mainloop（spike 实证）：无 main guard、模块级直接 root.mainloop() 的
    # 自由产物也能被 import——mainloop 立即返回，UI 已在模块级建成。
    tk.Tk.mainloop = lambda self, *args, **kwargs: None

    sys.path.insert(0, root_dir)
    sys.stdout = _buf_out
    sys.stderr = _buf_err
    spec = importlib.util.spec_from_file_location("__bloma_target__", candidate)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.stdout = sys.__stdout__
        _fail_open("import_failed", f"入口模块执行抛异常：{entry}", traceback.format_exc())
        return False
    sys.stdout = sys.__stdout__

    roots = [value for value in vars(module).values() if isinstance(value, tk.Tk)]
    if not roots:
        _fail_open(
            "no_root",
            "模块全局命名空间未发现 tk.Tk 实例——入口需模块级创建窗口（mainloop 放 "
            "if __name__ == '__main__': 守卫内或模块级直调均可，窗口对象须是模块级变量）",
        )
        return False

    _root = roots[0]
    _module = module

    # 应用异常捕获（spike A1）：invoke()/event_generate 触发的回调异常不外抛，
    # tkinter 吞进 report_callback_exception——hook 后按响应增量上报。
    def _record_exception(exc, value, tb) -> None:
        _pending_exceptions.append(
            {"type": exc.__name__ if exc else "Exception", "message": str(value), "traceback": "".join(traceback.format_exception(exc, value, tb))[:4000]}
        )

    _root.report_callback_exception = _record_exception

    _root.withdraw()  # 静默纪律：默认不可见
    _pump()
    widgets = _walk_widgets()
    _write_line(
        {
            "ready": True,
            "root_class": type(_root).__name__,
            "widgets_initial": len(widgets),
            "roots_all": len(roots),
            "app_prints": _tail(_buf_out.getvalue()),
        }
    )
    return True


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
            value = _root.getvar(var)  # type: ignore[union-attr]
            return value
    except Exception:
        pass
    return None


def _tail(text: str) -> str:
    return text[-OUTPUT_TAIL_CHARS:]


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


def _op_keys(target: str, sequence: str) -> dict:
    widget = _find_widget(target)
    if widget is None:
        raise _OpError("no_such_widget", f"控件不存在：{target}")
    _root.deiconify()
    _pump()
    try:
        widget.focus_set()
        for token in sequence.split():
            widget.event_generate(token if token.startswith("<") else f"<{token}>")
            _pump()
    finally:
        _root.withdraw()
    return {"target": target, "keys": sequence}


def _op_read(target: str | None) -> dict:
    if target:
        widget = _find_widget(target)
        if widget is None:
            raise _OpError("no_such_widget", f"控件不存在：{target}")
        return {"widget": _describe_widget(widget)}
    return {
        "widgets": [_describe_widget(w) for w in _walk_widgets()],
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


# ── 主循环 ──────────────────────────────────────────────────────────────────

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
        return _op_keys(str(request.get("target", "")), str(request.get("value", "")))
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
    }
    if error is not None:
        payload["err"] = error
    else:
        payload["data"] = data
    _write_line(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description="Bloma drive-harness（进程内驱动桥）")
    parser.add_argument("--entry", required=True, help="项目根内被测入口 .py 相对路径")
    args = parser.parse_args()

    if not _initialize(args.entry):
        return 1

    global _step
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        _step += 1
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("请求须为 JSON 对象")
        except ValueError as error:
            _respond("?", None, {"class": "bad_argument", "message": f"协议行不是合法 JSON 对象：{error}"})
            continue
        op = str(request.get("op", ""))
        if op == "close":
            _respond("close", {"closed": True})
            break
        try:
            data = _dispatch(request)
            _respond(op, data)
        except _OpError as op_error:
            _respond(op, None, {"class": op_error.error_class, "message": op_error.message})
        except Exception:
            _respond(op, None, {"class": "harness_panic", "message": "动词执行意外异常", "traceback": traceback.format_exc()[:4000]})

    try:
        _root.destroy()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
