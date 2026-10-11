# -*- coding: utf-8 -*-
"""语音识别模型定位器（Bloma 平台资产，2026-10-05 语音批 C 线）。

install_packages 安装 sherpa-onnx 时自动复制到项目根。产物程序 import 本模块，
即可零配置获得 SenseVoice 离线语音识别三件（模型/词表/VAD）：

    from speech_locator import ensure_models
    import sherpa_onnx

    paths = ensure_models()          # 首次调用：缓存缺失件自动下载（约 239MB，hf-mirror）
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=paths["model"], tokens=paths["tokens"], num_threads=2,
        use_itn=True, language="auto", debug=False,
    )
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)   # Float32 单声道 16kHz numpy 数组
    recognizer.decode_stream(stream)
    text = stream.result.text                # 逆文本正规化后的识别文本

设计要点：
- 模型缓存固定在 ~/.proma/speech-models/sensevoice-int8/——与 Bloma 平台语音输入
  共用同一份（平台已下载则产物零下载）；产物独立分发给别人时首次自动下载同款；
- 模型永不放项目目录（快照/交付清单/安全扫描零感知）；
- 下载走 hf-mirror.com（国内可达），SHA-256 + 字节数双重校验，.part 原子发布；
- 纯标准库实现（urllib/hashlib），不引入额外依赖；
- Python API 注意：用 from_sense_voice 工厂方法 + stream.result.text 取结果
  （不是 Node 侧的 config 对象形态；真机探针 2026-10-05 验证 sherpa-onnx
  1.13.8 + Windows x64 全链）。
"""

from __future__ import annotations

import hashlib
import os
import sys
import urllib.request
import tempfile
import time
from pathlib import Path

HF_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
HF_REV = "2365baeacb507f821a0c8120fcee3d484dba7a07"
VAD_REV = "fba88cd2e921609e7675c3aaf51e0b9b295da4bc"

# 固定修订资产清单：文件名 → (相对仓库, 修订, 字节数, sha256)
ASSETS = {
    "model": ("model.int8.onnx", HF_REPO, HF_REV, 239233841,
              "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"),
    "tokens": ("tokens.txt", HF_REPO, HF_REV, 315894,
               "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"),
    "vad": ("silero_vad.onnx", "csukuangfj/vad", VAD_REV, 1807522,
            "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28"),
}

MIRRORS = ["https://hf-mirror.com", "https://huggingface.co"]


def cache_dir() -> Path:
    """模型缓存目录（与 Bloma 平台语音输入共用）。"""
    explicit = os.environ.get("BLOMA_SPEECH_MODEL_DIR")
    if explicit:
        return Path(explicit).expanduser().resolve()
    home = Path(os.environ.get("PROMA_HOME") or Path.home() / ".proma")
    return home / "speech-models" / "sensevoice-int8"


def _matches(path: Path, expected_bytes: int, expected_sha256: str) -> bool:
    """已存在文件是否与锚定资产完全一致（字节 + SHA-256）。"""
    if not path.is_file() or path.stat().st_size != expected_bytes:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest() == expected_sha256


def _download(name: str, repo: str, rev: str, expected_bytes: int, sha256: str, root: Path,
              timeout: float = 15, deadline: float | None = None, cancelled=None) -> Path:
    """下载单件到缓存根（.part → 校验 → 原子发布）；逐源尝试。"""
    destination = root / name
    if _matches(destination, expected_bytes, sha256):
        return destination
    if os.environ.get("BLOMA_SPEECH_OFFLINE", "").lower() in ("1", "true", "on"):
        raise RuntimeError(f"离线模型未就绪：{name}，请先准备模型后重试")
    root.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None
    for mirror in MIRRORS:
        url = f"{mirror}/{repo}/resolve/{rev}/{name}"
        partial = None
        try:
            if cancelled and cancelled():
                raise InterruptedError("语音模型准备已取消")
            remaining = (deadline - time.monotonic()) if deadline is not None else timeout
            if remaining <= 0:
                raise TimeoutError("语音模型准备超过总时限")
            print(f"[speech_locator] 下载 {name}（{expected_bytes / 1048576:.1f} MB）← {mirror}", file=sys.stderr)
            with tempfile.NamedTemporaryFile(prefix=name + ".", suffix=".part", dir=root, delete=False) as output:
                partial = Path(output.name)
                with urllib.request.urlopen(url, timeout=min(timeout, remaining)) as response:
                    received = 0
                    while True:
                        if cancelled and cancelled():
                            raise InterruptedError("语音模型准备已取消")
                        if deadline is not None and time.monotonic() >= deadline:
                            raise TimeoutError("语音模型准备超过总时限")
                        chunk = response.read(1 << 20)
                        if not chunk:
                            break
                        received += len(chunk)
                        if received > expected_bytes:
                            raise IOError("download exceeds declared size")
                        output.write(chunk)
            if partial.stat().st_size != expected_bytes:
                raise IOError(f"size mismatch: {partial.stat().st_size} != {expected_bytes}")
            digest = hashlib.sha256()
            with partial.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
            if digest.hexdigest() != sha256:
                raise IOError("sha256 mismatch")
            os.replace(partial, destination)
            return destination
        except Exception as error:  # noqa: BLE001 —— 逐源重试，全部失败才抛
            last_error = error
            try:
                if partial is not None:
                    partial.unlink(missing_ok=True)
            except OSError:
                pass
            if isinstance(error, InterruptedError) or (deadline is not None and time.monotonic() >= deadline):
                raise
            continue
    raise RuntimeError(f"模型下载失败（{name}）：{last_error}")


def ensure_models(timeout: float = 15, total_timeout: float = 600, cancelled=None) -> dict[str, str]:
    """确保三件齐备并返回绝对路径 dict（model/tokens/vad）。

    首次调用会下载缺失件（约 239MB，进度打印到 stderr）；建议在程序启动
    或首次使用语音功能时调用，并在 UI 上提示「正在准备语音模型…」避免卡顿观感。
    """
    root = cache_dir()
    if not (0 < timeout <= 60 and 0 < total_timeout <= 1800):
        raise ValueError("模型准备时限不合法")
    deadline = time.monotonic() + total_timeout
    paths: dict[str, str] = {}
    for key, (name, repo, rev, expected_bytes, sha256) in ASSETS.items():
        if cancelled and cancelled():
            raise InterruptedError("语音模型准备已取消")
        paths[key] = str(_download(name, repo, rev, expected_bytes, sha256, root, timeout, deadline, cancelled))
    return paths


def model_status() -> dict[str, bool]:
    """三件就绪状态（不下载；UI 可先探测再决定何时 ensure_models）。"""
    root = cache_dir()
    status: dict[str, bool] = {}
    for key, (name, _repo, _rev, expected_bytes, sha256) in ASSETS.items():
        status[key] = _matches(root / name, expected_bytes, sha256)
    return status
