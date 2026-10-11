"""Independent, bounded GUI replay; adapters select controls, expected business values stay fixed."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request


def digest(root):
    h = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root)
        if any(p.startswith('.') or p in ('00_VERIFY', '__pycache__', 'data') for p in rel.parts):
            continue
        if path.is_file() and path.suffix in ('.py', '.js', '.html', '.css', '.json', '.txt'):
            h.update(str(rel).encode()); h.update(path.read_bytes())
    return h.hexdigest()


class Replay:
    def __init__(self, root, data, log, adapter):
        self.root, self.data, self.log, self.adapter = root, data, log, adapter
        self.process = None
        self.locks = {}
        self.steps = []

    def js(self, expression):
        expression = expression.replace('{{DATA_DIR}}', json.dumps(str(self.data)))
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}/eval',
            data=json.dumps({'js': expression}).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=3) as res:
            value = json.loads(res.read())
        if not value.get('ok'):
            raise RuntimeError('GUI readback failed: ' + str(value.get('error'))[:300])
        return value.get('result')

    def start(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); self.port = sock.getsockname()[1]
        env = dict(os.environ, APP_DATA_DIR=str(self.data), PYTHONDONTWRITEBYTECODE='1')
        self.process = subprocess.Popen([str(self.root / '.venv/Scripts/python.exe'), '-X', 'utf8', '-B',
            'app.py', '--drive-port', str(self.port)], cwd=self.root, env=env,
            stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f'Product exited during startup: {self.process.returncode}')
            try:
                if self.js(self.adapter['ready']) is True:
                    return
            except (OSError, ValueError, RuntimeError):
                pass
            time.sleep(.3)
        raise TimeoutError('GUI startup did not become ready within 40 seconds')

    def stop(self):
        if self.process is None:
            return
        if self.process.poll() is None:
            # Only the child created by this replay, never an existing user process.
            subprocess.run(['taskkill', '/PID', str(self.process.pid), '/T', '/F'],
                capture_output=True, timeout=10, check=False)
        self.process.wait(timeout=10)
        self.process = None

    def file(self, relative):
        path = (self.data / relative).resolve()
        if not path.is_relative_to(self.data.resolve()):
            raise ValueError('Test data path escaped its isolated root')
        return path

    def lock(self, relative):
        path = self.file(relative)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
            ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        kernel.CreateFileW.restype = ctypes.c_void_p
        handle = kernel.CreateFileW(str(path), 0x80000000, 0, None, 3, 0x80, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        self.locks[relative] = (kernel, handle)

    def unlock(self, relative):
        kernel, handle = self.locks.pop(relative)
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        if not kernel.CloseHandle(handle):
            raise ctypes.WinError(ctypes.get_last_error())

    def execute(self, step):
        kind = step['kind']
        value = None
        if kind == 'js':
            value = self.js(step['expression'])
        elif kind == 'expect':
            deadline = time.monotonic() + step.get('timeout_seconds', 12)
            while time.monotonic() < deadline:
                value = self.js(step['expression'])
                if value is True:
                    break
                time.sleep(.25)
            if value is not True:
                raise AssertionError(step['name'] + ': GUI predicate was false')
        elif kind == 'disk_records':
            value = json.loads(self.file(step['file']).read_text(encoding='utf-8'))
            rows = value if isinstance(value, list) else value[step['key']]
            amounts = [float(row[step.get('amount_key', 'amount')]) for row in rows]
            if sorted(amounts) != sorted(step['amounts']):
                raise AssertionError(f"Disk amounts differ: {amounts}")
        elif kind == 'snapshot':
            self.snapshot = self.file(step['file']).read_bytes()
            value = hashlib.sha256(self.snapshot).hexdigest()
        elif kind == 'unchanged':
            actual = self.file(step['file']).read_bytes()
            if actual != self.snapshot:
                raise AssertionError('Failed operation changed the previously saved bytes')
            value = hashlib.sha256(actual).hexdigest()
        elif kind == 'write_file':
            path = self.file(step['file'])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(step['text'], encoding='utf-8')
        elif kind == 'remove_file':
            self.file(step['file']).unlink()
        elif kind == 'file_tree':
            directory = self.file(step['directory'])
            expected = {name: value.encode('utf-8') for name, value in step['files'].items()}
            deadline = time.monotonic() + 3
            while True:
                actual = {}
                try:
                    for path in directory.rglob('*'):
                        if not path.resolve().is_relative_to(self.data.resolve()):
                            raise AssertionError('Test file tree contains an escaped path')
                        if path.is_file():
                            actual[path.relative_to(directory).as_posix()] = path.read_bytes()
                except OSError:
                    if time.monotonic() >= deadline:
                        raise
                if actual == expected or time.monotonic() >= deadline:
                    break
                time.sleep(.1)
            if actual != expected:
                raise AssertionError('File names or contents differ from the fixed expectation: ' + repr(list(actual)))
            value = {name: hashlib.sha256(content).hexdigest() for name, content in actual.items()}
        elif kind == 'lock':
            self.lock(step['file'])
        elif kind == 'unlock':
            self.unlock(step['file'])
        elif kind == 'restart':
            self.stop(); self.start()
        else:
            raise ValueError('Unsupported independent replay step: ' + kind)
        self.steps.append({'name': step['name'], 'kind': kind, 'status': 'passed', 'readback': value})

    def close(self):
        for path in list(self.locks):
            self.unlock(path)
        self.stop()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path); parser.add_argument('adapter', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    adapter = json.loads(args.adapter.read_text(encoding='utf-8'))
    before = digest(root)
    report = {'case_id': adapter['case_id'], 'root': str(root), 'source_sha256_before': before,
        'scope': 'independent DOM actions, disk state and fresh-process restart', 'replays': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for index in range(3):
        data = Path(tempfile.mkdtemp(prefix='blr-ui-data-')).resolve()
        item = {'iteration': index + 1, 'data_dir': str(data), 'status': 'failed'}
        with args.output.with_suffix(f'.replay-{index + 1}.log').open('w', encoding='utf-8') as log:
            replay = Replay(root, data, log, adapter)
            try:
                replay.start()
                for step in adapter['steps']:
                    replay.execute(step)
                item['dom'] = replay.js('document.body.innerText')
                item['status'] = 'passed'
            except Exception as error:
                item['error'] = f'{type(error).__name__}: {error}'
                try:
                    item['dom'] = replay.js('document.body.innerText')
                except Exception:
                    pass
            finally:
                try:
                    replay.close()
                except Exception as error:
                    item['status'] = 'failed'
                    item['cleanup_error'] = f'{type(error).__name__}: {error}'
                item['steps'] = replay.steps
        report['replays'].append(item)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'iteration': index + 1, 'status': item['status'], 'error': item.get('error')}, ensure_ascii=False), flush=True)
    report['source_sha256_after'] = digest(root)
    report['status'] = 'passed' if all(r['status'] == 'passed' for r in report['replays']) and before == report['source_sha256_after'] else 'failed'
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
