"""User-started component GUI test. No recording before a deliberate button click."""
import hashlib
import json
import os
import queue
import sys
import threading
from pathlib import Path
import tkinter as tk
import numpy as np

BASE = Path(__file__).resolve().parents[1]
TOOLS = BASE / "main/templates/tools"
sys.path.insert(0, str(TOOLS))
from speech_runtime import SpeechEngine, StreamingRecorder
from speech_probe import normalized

os.environ["BLOMA_SPEECH_OFFLINE"] = "1"
window = tk.Tk()
window.title("Bloma · 语音测试")
window.geometry("560x380")
window.configure(bg="#f5f7fa")
events = queue.Queue()
engine = SpeechEngine()
recorder = StreamingRecorder(engine)
state = {"status": "preparing", "text": "", "samples": 0, "energy": 0.0, "errors": []}
status = tk.StringVar(value="正在准备语音模型…")
recognized = tk.StringVar(value="识别出的文字会显示在这里")
tk.Label(window, text="语音测试", font=("Microsoft YaHei UI", 22), bg="#f5f7fa", fg="#17222f").pack(pady=(24, 8))
tk.Label(window, text="请说：我们下周四下午三点开会。", font=("Microsoft YaHei UI", 13), bg="#f5f7fa").pack()
tk.Label(window, textvariable=status, font=("Microsoft YaHei UI", 12), bg="#f5f7fa", fg="#3579bc").pack(pady=12)
tk.Label(window, textvariable=recognized, wraplength=510, font=("Microsoft YaHei UI", 15), bg="white", fg="#17222f", height=3).pack(fill="x", padx=24)


def save():
    rms = (state["energy"] / max(1, state["samples"])) ** .5
    report = {"source": "user_started_component_gui", "status": state["status"], "text": state["text"], "rms": rms,
              "samples": state["samples"], "audio_seconds": state["samples"] / 16000, "errors": state["errors"], "raw_audio_saved": False,
              "component_sha256": {name: hashlib.sha256((TOOLS / name).read_bytes()).hexdigest() for name in ["speech_runtime.py", "speech_locator.py"]}}
    (BASE / "run-artifacts/robustness-microphone-gui.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False), flush=True)


def stream_factory(**kwargs):
    import sounddevice
    callback = kwargs["callback"]
    def observed(data, frames, timing, signal_status):
        state["samples"] += data.size
        state["energy"] += float(np.sum(data.astype(np.float64) ** 2))
        callback(data, frames, timing, signal_status)
    kwargs["callback"] = observed
    return sounddevice.InputStream(**kwargs)


def finish():
    try:
        recorder.stop()
        events.put(("finished", None))
    except Exception as error:
        events.put(("error", str(error)))


def begin():
    try:
        recorder.start(lambda text: events.put(("text", text)), lambda error: events.put(("error", error)), stream_factory=stream_factory)
        state["status"] = "recording"
        status.set("正在录音，现在请说这句话（8 秒）")
        window.after(8000, lambda: threading.Thread(target=finish, daemon=True).start())
    except Exception as error:
        events.put(("error", str(error)))


def countdown(seconds=3):
    button.configure(state="disabled")
    if seconds:
        status.set(f"{seconds} 秒后开始录音…")
        window.after(1000, lambda: countdown(seconds - 1))
    else:
        begin()


button = tk.Button(window, text="开始录音", font=("Microsoft YaHei UI", 13), command=countdown, state="disabled", bg="#dfebfa", relief="flat", padx=20, pady=8)
button.pack(pady=16)


def prepare():
    try:
        engine.prepare()
        events.put(("ready", None))
    except Exception as error:
        events.put(("error", str(error)))


def poll():
    while not events.empty():
        kind, value = events.get_nowait()
        if kind == "ready":
            state["status"] = "ready"
            status.set("准备好了，点击按钮后才会开始")
            button.configure(state="normal")
        elif kind == "text":
            state["text"] = value
            recognized.set(value)
        elif kind == "error":
            state["errors"].append(value)
            state["status"] = "failed"
            status.set("测试遇到问题：" + value[:100])
            threading.Thread(target=finish, daemon=True).start() if recorder.state == "recording" else None
            save()
        elif kind == "finished":
            passed = "我们下周四下午3点开会" in normalized(state["text"]) and state["samples"] > 0 and not state["errors"]
            state["status"] = "passed" if passed else "failed"
            status.set("测试通过，可以关闭窗口" if passed else "未识别到完整参考句，结果已记录")
            button.configure(text="测试已结束", state="disabled")
            save()
    window.after(100, poll)


def close():
    if state["status"] in ("ready", "preparing"):
        state["status"] = "cancelled"
        save()
    if recorder.state == "recording":
        threading.Thread(target=finish, daemon=True).start()
        status.set("正在结束录音…")
        window.after(500, close)
        return
    window.destroy()


window.protocol("WM_DELETE_WINDOW", close)
window.after(180000, close)
threading.Thread(target=prepare, daemon=True).start()
window.after(100, poll)
window.mainloop()
