"""Independent logic counterexamples against an isolated source copy only."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

parser = argparse.ArgumentParser()
parser.add_argument('case', choices=['process', 'files', 'ledger'])
parser.add_argument('root', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
root = args.root.resolve()
if 'generation-quality-audit' not in root.parts:
    raise RuntimeError('This probe only accepts the isolated audit copy')
sys.path.insert(0, str(root))
import app
results = []

with tempfile.TemporaryDirectory(prefix='bloma-quality-data-') as directory:
    data = Path(directory)
    logic = app.Logic(data / 'store')
    if args.case == 'process':
        calls = []
        def unexpected_network(*a, **kw):
            calls.append(True)
            raise AssertionError('External network is disabled in audit')
        logic.set_config({'model_key': 'audit-placeholder-not-a-real-key', 'endpoint': 'http://127.0.0.1:9', 'model': 'audit-model'})
        with patch('socket.create_connection', side_effect=unexpected_network), patch('urllib.request.urlopen', side_effect=unexpected_network):
            result = logic.enhance('审计新材料', '审计新用途', provider='real')
        results.append({'name': 'configured_real_provider_path', 'actual': result, 'network_calls': len(calls),
            'finding': 'real path returns network_error without attempting a request', 'scope': 'implementation path, not real credential validity'})
        mock = logic.enhance('审计新材料', '审计新用途', provider='mock')
        results.append({'name': 'mock_provider_path', 'mock_success': mock['ok'], 'scope': 'mock output does not prove real enhancement'})
    elif args.case == 'files':
        folder = data / 'input'; folder.mkdir()
        (folder / 'a.txt').write_text('alpha'); (folder / 'b.txt').write_text('beta')
        plan = logic.preview(str(folder), 'done-')
        def fail_progress(*a): raise RuntimeError('Audit injected callback failure')
        error = None
        try: logic.execute_rename(str(folder), 'done-', progress=fail_progress, plan=plan)
        except Exception as e: error = str(e)
        files = {p.name: p.read_text() for p in folder.iterdir() if p.is_file()}
        results.append({'name': 'staging_callback_failure_rollback', 'error': error, 'actual_files': files,
            'restored_original_names': files == {'a.txt': 'alpha', 'b.txt': 'beta'},
            'scope': 'backend callback exception; does not assert the current GUI triggers this exception'})
        normal = data / 'normal'; normal.mkdir()
        (normal / 'a.txt').write_text('alpha'); (normal / 'b.txt').write_text('beta')
        normal_plan = logic.preview(str(normal), 'done-')
        success = logic.execute_rename(str(normal), 'done-', plan=normal_plan)
        undo = logic.undo_last()
        restored = {p.name: p.read_text() for p in normal.iterdir() if p.is_file()}
        results.append({'name': 'normal_rename_undo', 'renamed': success['success'], 'undo': undo,
            'original_names_and_bytes_restored': restored == {'a.txt': 'alpha', 'b.txt': 'beta'}})
    else:
        first = logic.add_record('2026-10-02', '0.10', 'a')
        second = logic.add_record('2026-10-01', '0.20', 'b')
        actual = logic.list_records()
        reopened = app.Logic(data / 'store').list_records()
        refused = []
        for amount in ['NaN', 'Infinity', '-1', '0', 'abc']:
            try: logic.add_record('2026-10-03', amount, 'bad'); refused.append(False)
            except Exception: refused.append(True)
        results.append({'name': 'decimal_sort_restart_and_invalid_amounts', 'actual': actual, 'reopened': reopened,
            'invalid_refused': refused, 'scope': 'logic and fresh instance; GUI tested separately'})
report = {'case': args.case, 'root': str(root), 'source_sha256': hashlib.sha256((root / 'app.py').read_bytes()).hexdigest(), 'results': results}
args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
