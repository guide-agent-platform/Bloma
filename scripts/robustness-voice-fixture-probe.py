"""Exercise real streaming ASR with the test-only input device before launching voice cases."""
import json
import os
from pathlib import Path
import runpy
import sys
import time

repo = Path(__file__).resolve().parents[1]
os.environ['BLR_FIXED_AUDIO_WAV'] = str(repo / 'tests/fixtures/robustness/voice-golden.wav')
os.environ['BLOMA_SPEECH_OFFLINE'] = '1'
runpy.run_path(str(repo / 'tests/fixtures/robustness/voice-sitecustomize.py'))
sys.path.insert(0, str(repo / 'main/templates/tools'))
from speech_runtime import SpeechEngine, StreamingRecorder

engine = SpeechEngine()
texts, errors = [], []
recorder = StreamingRecorder(engine)
recorder.start(texts.append, errors.append)
try:
    time.sleep(8)
finally:
    recorder.stop(timeout=10)
report = {'capture': 'fixed WAV callback, no physical microphone', 'state': recorder.state,
    'texts': texts, 'errors': errors, 'fixture_sha256': __import__('hashlib').sha256(Path(os.environ['BLR_FIXED_AUDIO_WAV']).read_bytes()).hexdigest()}
Path(sys.argv[1]).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
raise SystemExit(0 if texts and not errors else 1)
