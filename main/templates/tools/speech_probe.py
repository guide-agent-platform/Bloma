"""Host-owned ASR counterexample runner. No microphone unless --microphone is explicit.

Runs the product's registered callable with a trusted WAV, recorder-shaped PCM,
and stereo PCM while observing real sherpa decoding. Labels/print statements
from the product do not count as real model execution.
"""
import argparse
import importlib
import json
import re
import sys
import wave
from pathlib import Path
import numpy as np


def normalized(text):
    return re.sub(r"[\s，。,.!?！？]", "", text).replace("三点", "3点")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--module", required=True)
    parser.add_argument("--factory", required=True)
    parser.add_argument("--method", default="transcribe")
    parser.add_argument("--rate-argument", action="store_true")
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--microphone", action="store_true")
    args = parser.parse_args()
    for symbol in [args.module, args.factory, args.method]:
        if not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", symbol):
            raise ValueError("invalid product symbol")
    # Platform locator validates pinned resources and enforces offline mode.
    import speech_locator
    speech_locator.ensure_models()
    import sherpa_onnx
    original = sherpa_onnx.OfflineRecognizer
    observed = {"accept_shapes": [], "real_decode_calls": 0}

    class Stream:
        def __init__(self, inner):
            self.inner = inner
        def accept_waveform(self, rate, samples):
            observed["accept_shapes"].append(list(np.asarray(samples).shape))
            return self.inner.accept_waveform(rate, samples)
        @property
        def result(self):
            return self.inner.result

    class Recognizer:
        def __init__(self, inner):
            self.inner = inner
        def create_stream(self):
            return Stream(self.inner.create_stream())
        def decode_stream(self, stream):
            self.inner.decode_stream(stream.inner)
            observed["real_decode_calls"] += 1

    class Factory:
        @staticmethod
        def from_sense_voice(**kwargs):
            return Recognizer(original.from_sense_voice(**kwargs))

    sherpa_onnx.OfflineRecognizer = Factory
    try:
        sys.path.insert(0, str(Path(args.root).resolve()))
        target = getattr(getattr(importlib.import_module(args.module), args.factory)(), args.method)
        with wave.open(args.fixture, "rb") as wav:
            if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
                raise ValueError("invalid trusted audio fixture")
            samples = np.frombuffer(wav.readframes(wav.getnframes()), np.int16).astype(np.float32) / 32768
        tests = []
        for name, pcm in [("flat", samples), ("recorder_column", samples[:, None]), ("stereo", np.column_stack([samples, samples]))]:
            try:
                before = observed["real_decode_calls"]
                text = target(pcm, 16000) if args.rate_argument else target(pcm)
                tests.append({"name": name, "passed": normalized(str(text)) == "我们下周四下午3点开会" and observed["real_decode_calls"] > before, "text": str(text)})
            except Exception as error:
                tests.append({"name": name, "passed": False, "error": f"{type(error).__name__}: {str(error)[:300]}"})
        mic = {"status": "not_run"}
        if args.microphone:
            import sounddevice
            print("MICROPHONE_READY: 请说：我们下周四下午三点开会。录音 8 秒。", flush=True)
            captured = sounddevice.rec(8 * 16000, samplerate=16000, channels=1, dtype="float32")
            sounddevice.wait()
            before = observed["real_decode_calls"]
            text = target(captured, 16000) if args.rate_argument else target(captured)
            rms = float(np.sqrt(np.mean(captured * captured)))
            mic = {"status": "passed" if rms >= .001 and normalized(str(text)) == "我们下周四下午3点开会" and observed["real_decode_calls"] > before else "failed", "rms": rms, "text": str(text), "seconds": 8}
        report = {"probe_version": 1, "status": "passed" if all(t["passed"] for t in tests) else "failed", "source": "host_audio_fixture", "tests": tests, "microphone": mic, **observed}
        print(json.dumps(report, ensure_ascii=False), flush=True)
        return 0 if report["status"] == "passed" and mic["status"] != "failed" else 1
    finally:
        sherpa_onnx.OfflineRecognizer = original


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"probe_version": 1, "status": "environment_blocked", "error": f"{type(error).__name__}: {str(error)[:500]}"}, ensure_ascii=False))
        sys.exit(2)
