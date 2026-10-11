"""Trusted counterexamples: current input and selected folder constrain a rename snapshot."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root))
from app import Logic


def state(base):
    return {str(p.relative_to(base)): hashlib.sha256(p.read_bytes()).hexdigest()
        for directory in ('input', 'outside') for p in (base / directory).rglob('*') if p.is_file()}


results = []
for name in ('changed_prefix', 'different_folder', 'escaped_source', 'escaped_target'):
    with tempfile.TemporaryDirectory(prefix='blr-plan-') as directory:
        base = Path(directory)
        folder, outside = base / 'input', base / 'outside'
        folder.mkdir(); outside.mkdir()
        (folder / 'a.txt').write_text('alpha', encoding='utf-8')
        (folder / 'b.txt').write_text('beta', encoding='utf-8')
        (outside / 'sentinel.txt').write_text('outside-original', encoding='utf-8')
        logic = Logic(base / 'data')
        plan = copy.deepcopy(logic.preview(str(folder), 'done-'))
        prefix = 'done-'
        if name == 'changed_prefix':
            prefix = 'other-'
        elif name == 'different_folder':
            plan['folder'] = str(outside)
            row = dict(plan['rows'][0], old='sentinel.txt', new='done-sentinel.txt', index=0)
            plan['rows'] = [row]
        elif name == 'escaped_source':
            plan['rows'] = [dict(plan['rows'][0], old='../outside/sentinel.txt', new='done-sentinel.txt')]
        elif name == 'escaped_target':
            plan['rows'] = [dict(plan['rows'][0], old='a.txt', new='../outside/stolen.txt')]
        before = state(base)
        rejected, reason = False, ''
        try:
            logic.execute_rename(str(folder), prefix, plan=plan)
        except Exception as error:
            rejected, reason = True, f'{type(error).__name__}: {error}'
        after = state(base)
        results.append({'name': name, 'rejected': rejected, 'files_unchanged': before == after,
            'before': before, 'after': after, 'reason': reason,
            'status': 'passed' if rejected and before == after else 'failed'})
report = {'root': str(root), 'source_sha256': hashlib.sha256((root / 'app.py').read_bytes()).hexdigest(),
    'scope': 'caller input, selected folder and basename binding; owned temporary files only', 'counterexamples': results}
report['status'] = 'passed' if all(r['status'] == 'passed' for r in results) else 'failed'
Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'status': report['status'], 'cases': [{ 'name': r['name'], 'status': r['status'] } for r in results]}, ensure_ascii=False))
raise SystemExit(0 if report['status'] == 'passed' else 1)
