"""Bounded product ASR worker. File input only; never opens a microphone."""
import json
import os
import sys
import wave
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent
    # Import real dependencies in isolated Python before loading product modules.
    import numpy as np
    import sherpa_onnx  # noqa: F401
    sys.path.insert(0, str(root))
    from speech_runtime import SpeechEngine
    if len(sys.argv) != 2 or not os.environ.get("APP_DATA_DIR"):
        raise ValueError("ASR_INPUT_REQUIRED")
    data = Path(os.environ["APP_DATA_DIR"]).resolve()
    audio = Path(sys.argv[1]).resolve(strict=True)
    if not audio.is_relative_to(data) or not audio.is_file() or audio.stat().st_size > 48 * 1024 * 1024:
        raise ValueError("ASR_INPUT_OUTSIDE_DATA_OR_TOO_LARGE")
    with wave.open(str(audio), "rb") as wav:
        rate, channels = wav.getframerate(), wav.getnchannels()
        if wav.getsampwidth() != 2 or not 8000 <= rate <= 192000 or not 1 <= channels <= 8 or wav.getnframes() > rate * 120:
            raise ValueError("ASR_PCM16_WAV_REQUIRED")
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
        if channels > 1:
            samples = samples.reshape(-1, channels)
    text = SpeechEngine().transcribe(samples, rate)
    print(json.dumps({"ok": True, "text": text}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"[:1600]}, ensure_ascii=False))
        sys.exit(1)
