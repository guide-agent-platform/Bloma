"""Host-owned append-prefix oracle for the platform's two Logic interfaces; no native GUI."""
import contextlib
import copy
import hashlib
import importlib
import inspect
import io
import json
import os
from pathlib import Path
import sys
import tempfile


def tree(base):
    return {str(p.relative_to(base)): hashlib.sha256(p.read_bytes()).hexdigest()
        for name in ('input', 'outside') for p in (base / name).rglob('*') if p.is_file()}


def run(root):
    require_undo = '--require-undo' in sys.argv[2:]
    sys.path.insert(0, str(root))
    module = importlib.import_module('app')
    factory = getattr(module, 'Logic', None)
    if factory is None or not hasattr(factory, 'execute_rename'):
        return {'probe_version': 1, 'status': 'environment_blocked', 'error': '内置前缀改名探针未找到平台 Logic.execute_rename 接口，需独立适配验证'}
    argument = hasattr(factory, 'preview') and 'plan' in inspect.signature(factory.execute_rename).parameters
    stored = all(hasattr(factory, name) for name in ('select_folder', 'build_preview'))
    if not argument and not stored:
        return {'probe_version': 1, 'status': 'environment_blocked', 'error': '产物的文件接口不在本探针支持范围，不能推断通过'}
    mode = 'argument_plan' if argument else 'stored_plan'
    if require_undo and not hasattr(factory, 'undo_last' if argument else 'undo_rename'):
        return {'probe_version': 1, 'status': 'environment_blocked', 'error': '已要求撤销，但本探针未找到受支持的撤销入口'}
    names = ['rename_undo' if require_undo else 'rename'] + (['changed_prefix', 'different_folder', 'escaped_source', 'escaped_target', 'source_changed', 'new_destination'] if argument else
        ['invalid_prefix_after_valid', 'changed_folder', 'source_changed', 'new_destination'])
    results = []
    for name in names:
        with tempfile.TemporaryDirectory(prefix='blr-prefix-probe-') as directory:
            base = Path(directory); folder = base / 'input'; outside = base / 'outside'
            folder.mkdir(); outside.mkdir()
            (folder / 'a.txt').write_text('alpha', encoding='utf-8')
            (folder / 'b.txt').write_text('beta', encoding='utf-8')
            (outside / 'sentinel.txt').write_text('outside-original', encoding='utf-8')
            try:
                logic = factory(base / 'data')
                if argument:
                    plan = copy.deepcopy(logic.preview(str(folder), 'done-'))
                else:
                    logic.select_folder(str(folder)); logic.build_preview('done-')
                if name in ('rename', 'rename_undo'):
                    if argument:
                        logic.execute_rename(str(folder), 'done-', plan=plan)
                    else:
                        logic.execute_rename()
                    valid = sorted(p.name for p in folder.iterdir()) == ['done-a.txt', 'done-b.txt'] and \
                        (folder / 'done-a.txt').read_text(encoding='utf-8') == 'alpha' and (folder / 'done-b.txt').read_text(encoding='utf-8') == 'beta'
                    if require_undo:
                        if argument: logic.undo_last()
                        else: logic.undo_rename()
                        valid = valid and sorted(p.name for p in folder.iterdir()) == ['a.txt', 'b.txt'] and \
                            (folder / 'a.txt').read_text(encoding='utf-8') == 'alpha' and (folder / 'b.txt').read_text(encoding='utf-8') == 'beta'
                    valid = valid and (outside / 'sentinel.txt').read_text(encoding='utf-8') == 'outside-original'
                    results.append({'name': name, 'passed': valid})
                    continue
                prefix = 'done-'
                if name == 'changed_prefix': prefix = 'other-'
                elif name == 'different_folder':
                    plan['folder'] = str(outside)
                    plan['rows'] = [dict(plan['rows'][0], old='sentinel.txt', new='done-sentinel.txt', index=0)]
                elif name == 'escaped_source': plan['rows'] = [dict(plan['rows'][0], old='../outside/sentinel.txt', new='done-sentinel.txt')]
                elif name == 'escaped_target': plan['rows'] = [dict(plan['rows'][0], old='a.txt', new='../outside/stolen.txt')]
                elif name == 'invalid_prefix_after_valid':
                    try: logic.build_preview('../')
                    except Exception: pass
                elif name == 'changed_folder': logic.select_folder(str(outside))
                elif name == 'source_changed': (folder / 'a.txt').write_text('changed-after-preview', encoding='utf-8')
                elif name == 'new_destination': (folder / 'done-a.txt').write_text('existing', encoding='utf-8')
                before = tree(base)
                rejected = False
                try:
                    if argument: response = logic.execute_rename(str(folder), prefix, plan=plan)
                    else: response = logic.execute_rename()
                    if isinstance(response, str):
                        try: response = json.loads(response)
                        except (ValueError, TypeError): pass
                    rejected = isinstance(response, dict) and response.get('ok') is False
                except Exception: rejected = True
                files_unchanged = before == tree(base)
                unchanged = files_unchanged
                if not argument and name in ('source_changed', 'new_destination'):
                    # A safe partial batch may rename unaffected b; the affected entry must stay put.
                    expected_a = 'changed-after-preview' if name == 'source_changed' else 'alpha'
                    safe_a = (folder / 'a.txt').is_file() and (folder / 'a.txt').read_text(encoding='utf-8') == expected_a
                    b_paths = [p for p in (folder / 'b.txt', folder / 'done-b.txt') if p.is_file()]
                    safe_b = len(b_paths) == 1 and b_paths[0].read_text(encoding='utf-8') == 'beta'
                    safe_target = name != 'new_destination' or ((folder / 'done-a.txt').is_file() and
                        (folder / 'done-a.txt').read_text(encoding='utf-8') == 'existing')
                    allowed = {'a.txt', b_paths[0].name if b_paths else ''} | ({'done-a.txt'} if name == 'new_destination' else set())
                    unchanged = safe_a and safe_b and safe_target and {p.name for p in folder.iterdir()} == allowed and \
                        (outside / 'sentinel.txt').read_text(encoding='utf-8') == 'outside-original'
                # Stored-plan APIs may safely return a structured no-op instead of raising.
                results.append({'name': name, 'passed': unchanged and (rejected or not argument),
                    'rejected': rejected, 'files_unchanged': files_unchanged, 'protected_entries_preserved': unchanged})
            except Exception as error:
                results.append({'name': name, 'passed': False, 'error': f'{type(error).__name__}: {error}'[:300]})
    return {'probe_version': 1, 'mode': mode, 'status': 'passed' if all(r['passed'] for r in results) else 'failed', 'tests': results}


with tempfile.TemporaryDirectory(prefix='blr-prefix-import-') as data:
    os.environ['APP_DATA_DIR'] = data
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            result = run(Path(sys.argv[1]).resolve())
    except Exception as error:
        result = {'probe_version': 1, 'status': 'environment_blocked', 'error': f'{type(error).__name__}: {error}'[:300]}
print(json.dumps(result, ensure_ascii=False))
raise SystemExit(0 if result['status'] == 'passed' else 1)
