"""Host-owned native GUI actions. No product-authored Python/JS assertions."""
import json
import hashlib
import os
import runpy
import sys
import threading
import time
from pathlib import Path
from gui_storage_faults import storage_full, restore_storage, mutate_data

entry = Path(sys.argv[1]).resolve()
steps = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
output = []
emitted = False
observer_lock = threading.Lock()
observer_started = False
locked_files = []


def unlock_data(check=False):
    unchanged = True
    count = len(locked_files)
    if locked_files:
        import ctypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        while locked_files:
            handle, path, before = locked_files.pop()
            kernel.CloseHandle(handle)
            if check:
                unchanged = unchanged and path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == before
    if check and not unchanged:
        raise AssertionError('GUI_FAILED_OPERATION_MUTATED_DATA')
    return {'unchanged': unchanged, 'files': count}


def lock_data():
    import ctypes
    root = Path(os.environ['APP_DATA_DIR']).resolve()
    files = [path for path in root.rglob('*') if path.is_file()]
    if not files or len(files) > 64 or any(not path.resolve().is_relative_to(root) for path in files):
        raise RuntimeError('GUI_DATA_FILES_UNAVAILABLE_OR_OUTSIDE_FIXTURE')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    kernel.CreateFileW.restype = ctypes.c_void_p
    for path in files:
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        handle = kernel.CreateFileW(str(path), 0x80000000, 1, None, 3, 0x80, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        locked_files.append((handle, path, before))
    return len(locked_files)


def emit(status, error=None):
    global emitted
    if emitted:
        return
    emitted = True
    print('BLOMA_GUI_ACCEPTANCE:' + json.dumps({'version': 1, 'status': status,
          'steps': output, 'error': error}, ensure_ascii=True), flush=True)


def observe(window):
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if window.evaluate_js('document.readyState === "complete" && !!(window.pywebview && window.pywebview.api)'):
                break
            time.sleep(.1)
        else:
            raise TimeoutError('NATIVE_BRIDGE_NOT_READY')
        for step in steps:
            if step['kind'] in ('storage_full', 'storage_restore', 'corrupt_data', 'remove_data'):
                root = os.environ['APP_DATA_DIR']
                actual = (storage_full(root) if step['kind'] == 'storage_full' else restore_storage(check=True) if step['kind'] == 'storage_restore'
                          else mutate_data(root, remove=step['kind'] == 'remove_data'))
                output.append({'id': step['id'], 'passed': True, 'actual': actual})
                continue
            if step['kind'] in ('lock_data', 'unlock_data'):
                actual = lock_data() if step['kind'] == 'lock_data' else unlock_data(check=True)
                output.append({'id': step['id'], 'passed': True, 'actual': actual})
                continue
            selector = json.dumps(step['selector'])
            get = 'document.querySelector(' + selector + ')'
            if step['kind'] == 'fill':
                value = step['value'].replace('{{DATA_DIR}}', os.environ['APP_DATA_DIR'])
                expression = '(()=>{const e=' + get + ';if(!e)return false;e.value=' + json.dumps(value) + ';e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return true})()'
            elif step['kind'] == 'click':
                expression = '(()=>{const e=' + get + ';if(!e||e.disabled)return false;e.click();return true})()'
            else:
                expression = ('String(document.querySelectorAll(' + selector + ').length)' if step.get('property') == 'count' else
                              '(()=>{const e=' + get + ';return e?' + ('e.value' if step.get('property') == 'value' else 'Array.from(document.querySelectorAll(' + selector + ')).map(x=>x.textContent).join("\\n")') + ':null})()')
            deadline = time.monotonic() + step.get('timeout_ms', 5000) / 1000
            while True:
                actual = window.evaluate_js(expression)
                if step['kind'] != 'expect':
                    passed = actual is True
                elif 'equals' in step:
                    passed = actual == step['equals'].replace('{{DATA_DIR}}', os.environ['APP_DATA_DIR'])
                elif 'contains' in step:
                    passed = isinstance(actual, str) and step['contains'].replace('{{DATA_DIR}}', os.environ['APP_DATA_DIR']) in actual
                else:
                    passed = isinstance(actual, str) and bool(actual.strip())
                if passed or step['kind'] != 'expect' or time.monotonic() >= deadline:
                    break
                time.sleep(.1)
            output.append({'id': step['id'], 'passed': passed, 'actual': actual})
            if not passed:
                emit('failed', 'GUI_ASSERTION_FAILED:' + step['id'])
                return
        emit('passed')
    except AssertionError as error:
        emit('failed', str(error)[:500])
    except Exception as error:
        emit('unverified', str(error)[:500])
    finally:
        restore_storage()
        unlock_data()
        window.destroy()


try:
    import webview
    create_window = webview.create_window

    def instrumented(*args, **kwargs):
        kwargs.setdefault('x', -3000)
        kwargs.setdefault('y', -3000)
        window = create_window(*args, **kwargs)
        def loaded():
            global observer_started
            with observer_lock:
                if observer_started:
                    return
                observer_started = True
            threading.Thread(target=observe, args=(window,), daemon=True).start()
        window.events.loaded += loaded
        return window

    webview.create_window = instrumented
    sys.path.insert(0, str(entry.parent))
    sys.argv = [str(entry)]
    runpy.run_path(str(entry), run_name='__main__')
except BaseException as error:
    emit('unverified', str(error)[:500])
finally:
    if not emitted:
        emit('unverified', 'NO_GUI_OBSERVATION')
