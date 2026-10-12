"""Offline boundaries and recorder lifecycle; no hardware or network."""
import hashlib
import json
import io
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "main/templates/tools"))
from speech_runtime import normalize_audio, SpeechEngine, StreamingRecorder
import speech_locator


class FakeStream:
    def __init__(self, **kwargs):
        self.callback = kwargs["callback"]
        self.closed = False
    def start(self):
        pass
    def stop(self):
        pass
    def close(self):
        self.closed = True


class RuntimeTests(unittest.TestCase):
    def test_column_and_stereo_preserve_frames(self):
        values = np.full((16000, 1), .1, dtype=np.float32)
        mono = normalize_audio(values)
        self.assertEqual(mono.shape, (16000,))
        self.assertTrue(mono.flags.c_contiguous)
        stereo = np.column_stack([mono, mono * 3])
        np.testing.assert_allclose(normalize_audio(stereo), .2, atol=1e-7)

    def test_resample_and_signed_pcm(self):
        self.assertEqual(normalize_audio(np.zeros((48000, 2), np.int16), 48000).shape, (16000,))
        np.testing.assert_allclose(normalize_audio(np.array([-32768, 16384], np.int16)), [-1, .5])

    def test_invalid_inputs(self):
        for value in [np.zeros((1, 1, 1)), np.zeros((2, 0)), np.array([np.nan]), np.array([np.inf]), np.array([2.0]), np.zeros(1, np.uint8)]:
            with self.subTest(shape=value.shape):
                with self.assertRaises(ValueError):
                    normalize_audio(value)
        for rate in [0, True, 15999.5, 192000]:
            with self.assertRaises(ValueError):
                normalize_audio(np.zeros(10, np.float32), rate)

    def test_silence_does_not_load_or_decode(self):
        engine = SpeechEngine(loader=lambda: self.fail("silent input must not decode"))
        self.assertEqual(engine.transcribe(np.zeros((6400, 1), np.float32)), "")
        self.assertEqual(engine.transcribe(np.zeros(0, np.float32)), "")

    def test_preparation_can_retry(self):
        calls = []
        def loader():
            calls.append(1)
            if len(calls) == 1:
                raise OSError("temporary")
            return object()
        engine = SpeechEngine(loader)
        with self.assertRaises(RuntimeError):
            engine.prepare()
        engine.prepare()
        self.assertIsNone(engine.error)
        self.assertEqual(len(calls), 2)

    def test_worker_and_repeated_start_stop(self):
        callback_thread = threading.get_ident()
        thread_ids, text = [], []
        class Engine:
            def prepare(self):
                pass
            def transcribe(self, data, rate):
                thread_ids.append(threading.get_ident())
                return "中文"
        recorder = StreamingRecorder(Engine())
        for _ in range(3):
            recorder.start(text.append, lambda error: self.fail(error), stream_factory=FakeStream)
            stream = recorder._stream
            stream.callback(np.full((16000, 1), .1, np.float32), 16000, None, None)
            recorder.stop()
            self.assertTrue(stream.closed)
            self.assertEqual(recorder.state, "stopped")
        self.assertEqual(len(text), 3)
        self.assertTrue(all(ident != callback_thread for ident in thread_ids))

    def test_overflow_reports_and_stops(self):
        class Engine:
            def prepare(self):
                pass
        errors = []
        recorder = StreamingRecorder(Engine())
        recorder.start(lambda _: None, errors.append, stream_factory=FakeStream)
        recorder._audio_callback(np.zeros((100, 1)), 100, None, "input overflow")
        recorder.stop()
        self.assertEqual(recorder.state, "failed")
        self.assertEqual(len(errors), 1)


class LocatorTests(unittest.TestCase):
    def test_download_attempt_history_survives_retry_without_new_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            speech_locator._record_download_attempt(root, "model", "rev")
            speech_locator._record_download_attempt(root, "model", "rev")
            history = root / ".download-attempts.json"
            self.assertEqual(json.loads(history.read_text())["attempts"]["model@rev"], 2)
            history.write_text("{broken")
            with self.assertRaises(Exception):
                speech_locator._record_download_attempt(root, "model", "rev")
    def test_isolation_and_offline_cold_cache(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"PROMA_HOME": root, "BLOMA_SPEECH_MODEL_DIR": "", "BLOMA_SPEECH_OFFLINE": "1"}):
            self.assertEqual(speech_locator.cache_dir(), Path(root) / "speech-models/sensevoice-int8")
            with patch.object(speech_locator.urllib.request, "urlopen", side_effect=AssertionError("offline network")):
                with self.assertRaises(RuntimeError):
                    speech_locator.ensure_models()

    def test_integrity_cleanup_retry_and_cancellation(self):
        payload = b"trusted-model"
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"BLOMA_SPEECH_OFFLINE": "0"}):
            root = Path(directory)
            with patch.object(speech_locator.urllib.request, "urlopen", side_effect=[io.BytesIO(b"bad"), io.BytesIO(payload)]) as request:
                path = speech_locator._download("model", "repo", "rev", len(payload), digest, root, timeout=1)
                self.assertEqual(path.read_bytes(), payload)
                self.assertEqual(request.call_count, 2)
                self.assertFalse(list(root.glob("*.part")))
            with self.assertRaises(InterruptedError):
                speech_locator._download("other", "repo", "rev", 10, digest, root, cancelled=lambda: True)
            self.assertFalse(list(root.glob("*.part")))

    def test_deadline_and_socket_timeout(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"BLOMA_SPEECH_OFFLINE": "0"}):
            with patch.object(speech_locator.urllib.request, "urlopen", side_effect=TimeoutError("socket timeout")) as request:
                with self.assertRaises(RuntimeError):
                    speech_locator._download("model", "repo", "rev", 10, "bad", Path(directory), timeout=.1)
                self.assertEqual(request.call_count, len(speech_locator.MIRRORS))
                self.assertFalse(list(Path(directory).glob("*.part")))
            with self.assertRaises(TimeoutError):
                speech_locator._download("model", "repo", "rev", 10, "bad", Path(directory), deadline=time.monotonic() - 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
