"""Bloma reusable offline speech boundary. Callback queues PCM; decoding runs on a worker.

Validated dependency baseline: numpy==2.5.4, sherpa-onnx==1.13.8,
sounddevice==0.5.6. UI must dispatch on_text/on_error onto its own thread.
"""
from __future__ import annotations
import queue
import threading
import numpy as np

SAMPLE_RATE = 16000


def normalize_audio(samples, sample_rate=16000):
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, (int, float)) or sample_rate != int(sample_rate) or not 8000 <= sample_rate <= 96000:
        raise ValueError("采样率须在 8000–96000 Hz 范围内")
    data = np.asarray(samples)
    if data.ndim not in (1, 2) or (data.ndim == 2 and not 1 <= data.shape[1] <= 8):
        raise ValueError("音频须为 frames 或 frames×channels 数组")
    if len(data) > int(sample_rate * 120):
        raise ValueError("单段音频超过 120 秒")
    if np.issubdtype(data.dtype, np.signedinteger):
        scale = float(max(abs(np.iinfo(data.dtype).min), np.iinfo(data.dtype).max))
        data = data.astype(np.float32) / scale
    elif np.issubdtype(data.dtype, np.floating):
        data = data.astype(np.float32)
    else:
        raise ValueError("音频须为有符号 PCM 整数或归一化浮点数组")
    if not np.isfinite(data).all() or (data.size and np.max(np.abs(data)) > 1.001):
        raise ValueError("音频含非法或未归一化样本")
    if data.ndim == 2:
        data = data.mean(axis=1)
    if len(data) and sample_rate != SAMPLE_RATE:
        count = max(1, round(len(data) * SAMPLE_RATE / sample_rate))
        data = np.interp(np.arange(count) * sample_rate / SAMPLE_RATE, np.arange(len(data)), data).astype(np.float32)
    return np.ascontiguousarray(data, dtype=np.float32)


class SpeechEngine:
    def __init__(self, loader=None):
        self._loader = loader or self._load
        self._recognizer = None
        self._lock = threading.RLock()
        self.error = None

    @staticmethod
    def _load():
        import sherpa_onnx
        from speech_locator import ensure_models
        paths = ensure_models()
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=paths["model"], tokens=paths["tokens"], num_threads=2,
            use_itn=True, language="auto", debug=False)

    def prepare(self):
        with self._lock:
            if self._recognizer is None:
                try:
                    self._recognizer = self._loader()
                    self.error = None
                except Exception as error:
                    self.error = str(error)
                    raise RuntimeError(f"语音模型准备失败，可重试：{error}") from error

    def transcribe(self, samples, sample_rate=16000):
        waveform = normalize_audio(samples, sample_rate)
        # A true silent input must not produce a model hallucination such as “嗯”.
        if not len(waveform) or float(np.sqrt(np.mean(waveform * waveform))) < 0.001:
            return ""
        with self._lock:
            self.prepare()
            stream = self._recognizer.create_stream()
            stream.accept_waveform(SAMPLE_RATE, waveform)
            self._recognizer.decode_stream(stream)
            return (stream.result.text or "").strip()


class StreamingRecorder:
    def __init__(self, engine, queue_size=16):
        if not 1 <= queue_size <= 64:
            raise ValueError("录音队列大小不合法")
        self.engine = engine
        self._queue_size = queue_size
        self._stream = None
        self._worker = None
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._fatal = None
        self.state = "idle"

    def start(self, on_text, on_error, sample_rate=16000, stream_factory=None):
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                raise RuntimeError("上一段录音仍在处理，请稍后重试")
            self.state = "preparing"
            try:
                self.engine.prepare()  # Never load/download inside the audio callback.
                normalize_audio(np.zeros(1, dtype=np.float32), sample_rate)
                if stream_factory is None:
                    import sounddevice
                    stream_factory = sounddevice.InputStream
                self._queue = queue.Queue(self._queue_size)
                self._stop = threading.Event()
                self._fatal = None
                self._sample_rate = sample_rate
                self._on_text, self._on_error = on_text, on_error
                self._stream = stream_factory(samplerate=sample_rate, channels=1, dtype="float32", blocksize=int(sample_rate * .2), callback=self._audio_callback)
                self.state = "recording"
                self._worker = threading.Thread(target=self._consume, daemon=True, name="bloma-asr")
                self._worker.start()
                self._stream.start()
            except Exception:
                self.state = "failed"
                self._stop.set()
                self._close_stream()
                raise

    def _audio_callback(self, data, frames, timing, status):
        if self._stop.is_set():
            return
        if status:
            self._fatal = RuntimeError(f"录音设备异常：{status}")
            self._stop.set()
            return
        try:
            self._queue.put_nowait(data.copy())
        except queue.Full:
            self._fatal = RuntimeError("识别处理跟不上录音，已停止；请重试")
            self._stop.set()

    def _close_stream(self):
        with self._lock:
            stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop()
            finally:
                stream.close()

    def _consume(self):
        chunks, count, last_text, committed = [], 0, "", []
        try:
            while not self._stop.is_set() or not self._queue.empty():
                if self._fatal:
                    raise self._fatal
                try:
                    chunk = self._queue.get(timeout=.1)
                except queue.Empty:
                    continue
                chunks.append(chunk)
                count += len(chunk)
                if count >= self._sample_rate:
                    text = self.engine.transcribe(np.concatenate(chunks), self._sample_rate)
                    if text and text != last_text:
                        self._on_text(" ".join(committed + [text]))
                        last_text = text
                    # Bounded segments; UI must treat each segment as an update/append.
                    if count >= self._sample_rate * 5:
                        if text:
                            committed.append(text)
                        chunks, count, last_text = [], 0, ""
            if self._fatal:
                raise self._fatal
            if chunks:
                text = self.engine.transcribe(np.concatenate(chunks), self._sample_rate)
                if text and text != last_text:
                    self._on_text(" ".join(committed + [text]))
            if self.state != "failed":
                self.state = "stopped"
        except Exception as error:
            self.state = "failed"
            self._stop.set()
            self._on_error(str(error))
        finally:
            self._close_stream()

    def stop(self, timeout=5):
        if not 0 < timeout <= 30:
            raise ValueError("停止时限不合法")
        self._stop.set()
        self._close_stream()
        worker = self._worker
        if worker and worker is not threading.current_thread():
            worker.join(timeout)
            if worker.is_alive():
                self.state = "stopping"
                raise TimeoutError("识别仍在结束，不能启动新的录音")


_engine = SpeechEngine()


def transcribe(samples, sample_rate=16000):
    return _engine.transcribe(samples, sample_rate)
