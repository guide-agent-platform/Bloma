"""Observe the registered Python entry through its native pywebview bridge.
No dport, HTTP business calls, UI mutations, or product-source edits.
"""
import json
import runpy
import sys
import threading
import time
from pathlib import Path

PREFIX = 'BLOMA_NORMAL_STARTUP:'
entry = Path(sys.argv[1]).resolve()
entry_args = json.loads(sys.argv[2])
result = None
lock = threading.Lock()


def emit(value):
    global result
    with lock:
        if result is None:
            result = value
            print(PREFIX + json.dumps(value, ensure_ascii=True), flush=True)


EXPRESSION = r'''(() => ({
  normal_mode: !/[?&]dport=/.test(location.search),
  document_ready: document.readyState === 'complete',
  bridge_ready: !!(window.pywebview && window.pywebview.api &&
    Object.keys(window.pywebview.api).some(k => typeof window.pywebview.api[k] === 'function')),
  app_present: !!window.App,
  startup_error: [...document.querySelectorAll('.w-banner[data-state="failed"]')].map(e => e.textContent).join('\n'),
  visible_text: document.body ? document.body.innerText.slice(0, 4000) : ''
}))()'''


def observe(window):
    samples = []
    consecutive = 0
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            snapshot = window.evaluate_js(EXPRESSION)
            if not isinstance(snapshot, dict):
                raise RuntimeError('Native window did not return a DOM observation')
            samples.append(snapshot)
            ready = (snapshot['normal_mode'] and snapshot['document_ready'] and
                     snapshot['bridge_ready'] and snapshot['app_present'] and not snapshot['startup_error'])
            consecutive = consecutive + 1 if ready else 0
            if consecutive >= 2:
                emit({'probe_version': 1, 'status': 'passed', 'samples': samples})
                return
            # A visible application failure after bridge injection is evidence,
            # rather than an inference from window/process survival.
            if len(samples) >= 2 and snapshot['bridge_ready'] and snapshot['startup_error']:
                emit({'probe_version': 1, 'status': 'failed', 'samples': samples})
                return
            time.sleep(1)
        emit({'probe_version': 1, 'status': 'unverified', 'samples': samples, 'error': 'NATIVE_BRIDGE_NOT_READY'})
    except Exception as error:
        emit({'probe_version': 1, 'status': 'unverified', 'samples': samples, 'error': str(error)[:500]})
    finally:
        window.destroy()


try:
    import webview
    create_window = webview.create_window

    def observed_window(*args, **kwargs):
        kwargs.setdefault('x', -3000)
        kwargs.setdefault('y', -3000)
        window = create_window(*args, **kwargs)
        window.events.loaded += lambda: threading.Thread(target=observe, args=(window,), daemon=True).start()
        return window

    webview.create_window = observed_window
    sys.path.insert(0, str(entry.parent))
    sys.argv = [str(entry), *entry_args]
    runpy.run_path(str(entry), run_name='__main__')
except SystemExit as error:
    if error.code not in (None, 0):
        emit({'probe_version': 1, 'status': 'failed', 'samples': [], 'error': 'ENTRY_EXIT_' + str(error.code)})
except Exception as error:
    emit({'probe_version': 1, 'status': 'unverified', 'samples': [], 'error': str(error)[:500]})
finally:
    if result is None:
        emit({'probe_version': 1, 'status': 'unverified', 'samples': [], 'error': 'NO_NATIVE_OBSERVATION'})
