"""Journaled real GUI operations, including two owned processes sharing test data.

Send newline-delimited JSON on stdin. Product mutations use rendered controls;
the console does not implement or call business methods for the reviewer.
"""
import argparse
import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location('replay', Path(__file__).with_name('robustness-ui-replay.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--python', type=Path)
args = parser.parse_args()
root, out = args.root.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
windows, current = {}, 'main'
log = (out / 'product.log').open('a', encoding='utf-8')
journal = (out / 'actions.jsonl').open('a', encoding='utf-8')

def safe_name(value):
    if not isinstance(value, str) or not value.replace('-', '').replace('_', '').isalnum():
        raise ValueError('Invalid scenario/window name')
    return value

def snapshot(replay):
    return replay.js("({text:document.body.innerText,controls:[...document.querySelectorAll('input,select,textarea,button,[role=button]')].filter(e=>e.getClientRects().length).map(e=>({tag:e.tagName,id:e.id,type:e.type,text:e.textContent.trim().slice(0,100),value:e.value,checked:e.checked,placeholder:e.placeholder,options:e.tagName==='SELECT'?[...e.options].map(o=>({value:o.value,text:o.text})):undefined}))})")

print(json.dumps({'console': 'ready', 'root': str(root)}, ensure_ascii=False), flush=True)
try:
    for line in sys.stdin:
        command = None
        try:
            command = json.loads(line)
            if not isinstance(command, dict):
                raise ValueError('Command must be an object')
            op, value = command['op'], None
            name = safe_name(command.get('window', current))
            if op == 'start':
                if name in windows:
                    windows.pop(name).close()
                data = out / 'data' / safe_name(command['scenario'])
                if command.get('share'):
                    if not data.is_dir():
                        raise ValueError('Shared scenario must already exist')
                else:
                    data.mkdir(parents=True, exist_ok=False)
                replay = module.Replay(root, data, log, {'ready': "document.readyState==='complete' && document.body.innerText.length>0"}, python=args.python)
                windows[name] = replay
                current = name
                replay.start()
                time.sleep(.7)
                value = snapshot(replay)
            elif op == 'exit':
                break
            elif op == 'close':
                selected = list(windows) if command.get('all') else [name]
                for key in selected:
                    if key in windows:
                        windows.pop(key).close()
                value = {'closed': selected}
            else:
                replay = windows[name]
                current = name
                if op == 'select':
                    value = snapshot(replay)
                elif op == 'restart':
                    replay.stop()
                    replay.start()
                    time.sleep(.7)
                    value = snapshot(replay)
                elif op == 'js':
                    result = replay.js(command['expression'])
                    time.sleep(command.get('settle', .7))
                    value = {'result': result, 'state': snapshot(replay)}
                elif op == 'observe':
                    value = snapshot(replay)
                elif op == 'screenshot':
                    target = out / (safe_name(command['name']) + '.png')
                    value = json.loads(subprocess.check_output([str(args.python or root / '.venv/Scripts/python.exe'), str(Path(__file__).with_name('capture-owned-window.py')), str(replay.process.pid), str(target)], encoding='utf-8', timeout=30))
                else:
                    raise ValueError('Unsupported operation')
            owned = windows.get(name)
            record = {'at': time.time(), 'window': name, 'process_id': owned.process.pid if owned and owned.process else None,
                      'data': str(owned.data) if owned else None, 'command': command, 'result': value}
        except Exception as error:
            record = {'at': time.time(), 'command': command, 'error': f'{type(error).__name__}: {error}'}
        journal.write(json.dumps(record, ensure_ascii=False) + '\n')
        journal.flush()
        display = json.loads(json.dumps(record))
        if isinstance(command, dict) and command.get('compact') and isinstance(display.get('result'), dict):
            state = display['result'].get('state', display['result'])
            if 'controls' in state:
                state['control_count'] = len(state.pop('controls'))
            if 'text' in state:
                state['text'] = state['text'][:3500]
        print(json.dumps(display, ensure_ascii=False), flush=True)
finally:
    for replay in windows.values():
        replay.close()
    journal.close()
    log.close()
