"""Freeze current requirements, traces and isolated source copies. No model calls."""
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
from datetime import datetime, timezone
REPO = Path(__file__).resolve().parents[1]
OUT = REPO / 'run-artifacts/generation-quality-audit'
SKIP = {'.venv', '.git', 'node_modules', '__pycache__', 'data', 'selftest_data', 'data-backups'}
SUFFIXES = {'.py', '.js', '.html', '.css', '.json', '.md', '.txt'}


def source_files(root):
    for directory, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP and not d.startswith('.') and not (Path(directory) / d).is_symlink()]
        for name in files:
            p = Path(directory) / name
            if p.suffix in SUFFIXES and not p.is_symlink() and not name.startswith('.'):
                yield p


def hashes(root):
    return {str(p.relative_to(root)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files(root)}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    old = json.loads((REPO / 'run-artifacts/robustness-six-case-audit.json').read_text(encoding='utf-8'))
    cases = [(c['id'], Path(c['root']), Path(c['home']), c['project_id']) for c in old['cases'] if c['id'] in ('ledger-quick', 'files-quick')]
    home = Path(os.environ['USERPROFILE']) / '.proma'
    pid = 'c03882fe-995a-4df3-82a8-3490b8090641'
    cases.append(('process', home / 'agent-workspaces/default-software-builder/generated-projects' / pid, home, pid))
    report = {'source': 'current_documents_not_snapshot_copies', 'observed_at': datetime.now(timezone.utc).isoformat(), 'cases': []}
    for name, root, home, pid in cases:
        prd_path = home / 'agent-workspaces/default-software-builder/documents' / pid / 'prd.json'
        prd = json.loads(prd_path.read_text(encoding='utf-8'))
        clone = OUT / (name + '-source')
        if clone.exists(): raise RuntimeError('Refuse to overwrite earlier audit copy: ' + str(clone))
        before = hashes(root)
        clone.mkdir()
        for source in source_files(root):
            destination = clone / source.relative_to(root)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        current = {'id': name, 'root': str(root), 'home': str(home), 'project_id': pid, 'clone': str(clone),
            'python': str(root / '.venv/Scripts/python.exe'), 'source_before': before, 'prd_path': str(prd_path),
            'prd_sha256': hashlib.sha256(prd_path.read_bytes()).hexdigest(), 'confirmed_at': prd.get('user_confirmed_at'),
            'requirements': [], 'sessions': [], 'architecture': []}
        contract_path, core_path = root / '00_SCAFFOLD/contract.json', root / 'CORE_CHECK.json'
        contract = json.loads(contract_path.read_text(encoding='utf-8')) if contract_path.exists() else {}
        core = json.loads(core_path.read_text(encoding='utf-8')) if core_path.exists() else {}
        for r in prd['requirements']:
            fid = r['id']
            current['requirements'].append({**r, 'effective_priority': r.get('priority', 'P0' if fid == 'F-001' else 'P2'),
                'acceptance': prd.get('acceptance', {}).get(fid),
                'contract_scenarios': [s for s in contract.get('scenarios', []) if fid in s.get('covers', [])],
                'core_scenarios': [s for s in core.get('scenarios', []) if fid in s.get('covers', [])]})
        current['core_manifest'] = core
        index = json.loads((home / 'bloma-agent-sessions.json').read_text(encoding='utf-8'))
        for s in index.get('sessions', []):
            if s.get('project_id') != pid: continue
            path = home / 'agent-sessions' / (s['session_id'] + '.jsonl')
            if not path.exists(): current['sessions'].append({'id': s['session_id'], 'missing': True}); continue
            entry = {'id': s['session_id'], 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'path': str(path), 'tasks': [], 'outputs': [], 'reads': []}
            for lineno, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
                try: row = json.loads(line)
                except ValueError: continue
                content = row.get('content', [])
                text = content if isinstance(content, str) else '\n'.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text') if isinstance(content, list) else ''
                if row.get('role') == 'user' and text and len(entry['tasks']) < 2:
                    entry['tasks'].append({'line': lineno, 'text': text[:20000], 'truncated': len(text) > 20000})
                if row.get('role') == 'assistant' and any(word in text for word in ('mock', '模型增强', 'chain', 'F-004', '保存失败', '预览')) and len(entry['outputs']) < 3:
                    entry['outputs'].append({'line': lineno, 'text': text[:1800], 'truncated': len(text) > 1800})
                for block in content if isinstance(content, list) else []:
                    if block.get('type') == 'tool_use' and block.get('name') == 'read_file': entry['reads'].append({'line': lineno, 'path': block.get('input', {}).get('path')})
            current['sessions'].append(entry)
        for path in clone.glob('*.py'):
            source = path.read_text(encoding='utf-8-sig'); tree = ast.parse(source)
            current['architecture'].append({'file': path.name, 'lines': len(source.splitlines()), 'blocks': [{'name': n.name, 'line': n.lineno, 'lines': n.end_lineno - n.lineno + 1} for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef))]})
        current['capture_unchanged'] = hashes(root) == before
        report['cases'].append(current)
    (OUT / 'matrix.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'cases': [{'id': c['id'], 'requirements': len(c['requirements']), 'sessions': len(c['sessions']), 'implicit_p2': [r['id'] for r in c['requirements'] if 'priority' not in r and r['id'] != 'F-001'], 'unchanged': c['capture_unchanged']} for c in report['cases']]}, ensure_ascii=False))


if __name__ == '__main__': main()
