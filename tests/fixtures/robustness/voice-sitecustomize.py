"""BLR_FIXED_AUDIO_ONLY: isolated-test device adapter; real model decoding stays unchanged."""
import importlib.abc
import importlib.machinery
import os
from pathlib import Path
import sys
import threading
import time
import wave


def adapt(module):
    import numpy as np
    fixture = Path(os.environ['BLR_FIXED_AUDIO_WAV'])
    with wave.open(str(fixture), 'rb') as source:
        if source.getframerate() != 16000 or source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise RuntimeError('Trusted fixture format changed')
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype=np.int16).astype(np.float32) / 32768

    class FixtureStream:
        def __init__(self, *args, callback=None, samplerate=16000, channels=1, blocksize=0, dtype='float32', **kwargs):
            if callback is None or int(samplerate) != 16000 or int(channels) != 1:
                raise RuntimeError('Fixed-audio test supports the declared mono 16k callback path only')
            fault = Path(os.environ.get('APP_DATA_DIR', '.')) / 'init-failure.once'
            if fault.is_file():
                fault.unlink()
                raise OSError('固定测试：输入设备准备失败，请重试')
            self.callback, self.frames, self.dtype = callback, int(blocksize) or 512, dtype
            self.finished = threading.Event()
            self.active = False
            self.closed = False
            self.worker = None

        def start(self):
            self.active = True
            self.finished.clear()

            def feed():
                offset = 0
                while not self.finished.is_set():
                    chunk = np.zeros(self.frames, dtype=np.float32)
                    available = samples[offset:offset + self.frames]
                    chunk[:len(available)] = available
                    offset += self.frames
                    value = self.format(chunk)
                    self.callback(value, self.frames, {}, None)
                    self.finished.wait(self.frames / 16000)
                self.active = False

            self.worker = threading.Thread(target=feed, daemon=True)
            self.worker.start()
            return self

        def format(self, chunk):
            return chunk.reshape(-1, 1).copy()

        def stop(self):
            self.finished.set()
            if self.worker:
                self.worker.join(timeout=2)
            self.active = False

        def close(self):
            self.stop(); self.closed = True

        def __enter__(self):
            return self.start()

        def __exit__(self, *_args):
            self.close()

    class FixtureRawStream(FixtureStream):
        def format(self, chunk):
            if self.dtype == 'int16':
                return (chunk * 32767).astype(np.int16).tobytes()
            if self.dtype == 'float32':
                return chunk.tobytes()
            raise RuntimeError('Unsupported fixed-audio PCM dtype')

    def rec(frames, samplerate=16000, channels=1, dtype='float32', **kwargs):
        if int(samplerate) != 16000 or int(channels) != 1:
            raise RuntimeError('Fixed-audio test only supports mono 16k')
        result = np.zeros((frames, 1), dtype=np.float32)
        count = min(frames, len(samples)); result[:count, 0] = samples[:count]
        return (result * 32767).astype(np.int16) if dtype == 'int16' else result

    module.InputStream, module.RawInputStream, module.rec = FixtureStream, FixtureRawStream, rec
    module.wait = lambda *args, **kwargs: None
    module.bloma_fixture_input = True
    # A generated program cannot accidentally invoke another physical input API during this trial.
    deny_other_input = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError('Physical microphone disabled in fixed-audio trial'))
    module.playrec, module.Stream, module.RawStream = deny_other_input, deny_other_input, deny_other_input


class GuardLoader(importlib.abc.Loader):
    def __init__(self, wrapped): self.wrapped = wrapped
    def create_module(self, spec): return self.wrapped.create_module(spec)
    def exec_module(self, module):
        self.wrapped.exec_module(module)
        adapt(module)


class GuardFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname != 'sounddevice': return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec and spec.loader:
            spec.loader = GuardLoader(spec.loader)
        return spec


if os.environ.get('BLR_FIXED_AUDIO_WAV'):
    sys.meta_path.insert(0, GuardFinder())
