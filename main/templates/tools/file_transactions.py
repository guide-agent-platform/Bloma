"""Owned-folder prefix rename with snapshot checks, no overwrite, rollback and undo.

Not a crash-atomic transaction or isolation from other processes. Preserve recovery
paths when an external writer prevents rollback; never overwrite it to look green.
UI progress callbacks are notifications and cannot change the transaction outcome.
"""
import os
from pathlib import Path
import uuid
from file_plan_guard import validate_prefix_plan


def _snapshot(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('文件已变化或不是普通文件，请重新预览')
    stat = path.stat()
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns]


def build_prefix_plan(folder, prefix):
    root = Path(folder).resolve(strict=True)
    rows = [{'index': index, 'old': path.name, 'new': prefix + path.name, 'snapshot': _snapshot(path)}
            for index, path in enumerate(sorted(root.iterdir(), key=lambda p: p.name.casefold())) if path.is_file() or path.is_symlink()]
    return validate_prefix_plan(root, prefix, {'folder': str(root), 'prefix': prefix, 'rows': rows, 'empty': not rows})


def _exists(path):
    return path.exists() or path.is_symlink()


def _move_no_replace(source, target):
    # link creation refuses an existing destination at the filesystem boundary.
    # The pair is exception-safe where cleanup succeeds; it is not crash-atomic.
    os.link(source, target, follow_symlinks=False)
    try:
        source.unlink()
    except BaseException:
        target.unlink()
        raise


def _execute(root, rows, on_progress=None):
    records, warnings = [], []
    operation = uuid.uuid4().hex
    try:
        sources = {row['old'].casefold() for row in rows}
        if len(sources) != len(rows) or len({row['new'].casefold() for row in rows}) != len(rows):
            raise ValueError('文件名重复，不能执行')
        for row in rows:
            if _snapshot(root / row['old']) != row.get('snapshot'):
                raise ValueError('文件已变化，请重新预览')
            if _exists(root / row['new']) and row['new'].casefold() not in sources:
                raise ValueError('目标文件已存在，请重新预览')
        for index, row in enumerate(rows):
            source = root / row['old']
            if _snapshot(source) != row['snapshot']:
                raise ValueError('执行前文件已变化，请重新预览')
            temp = root / f'.bloma-rename-{operation}-{index}'
            _move_no_replace(source, temp)
            records.append({'old': row['old'], 'new': row['new'], 'current': temp, 'snapshot': row['snapshot']})
        for index, record in enumerate(records):
            if _snapshot(record['current']) != record['snapshot']:
                raise ValueError('处理期间文件已变化')
            target = root / record['new']
            _move_no_replace(record['current'], target)
            record['current'] = target
            if on_progress:
                try:
                    on_progress(index + 1, len(records))
                except Exception:
                    warnings.append('进度通知失败；文件处理结果以实际记录为准')
        return {'ok': True, 'kind': 'success', 'count': len(records), 'warnings': warnings,
                'journal': {'folder': str(root), 'items': [{key: record[key] for key in ('old', 'new', 'snapshot')} for record in records]}}
    except Exception as error:
        failures = []
        # Vacate every committed destination before restoring originals (overlapping names).
        for index, record in enumerate(records):
            recovery = root / f'.bloma-rename-{operation}-recovery-{index}'
            try:
                _move_no_replace(record['current'], recovery)
                record['current'] = recovery
            except Exception:
                failures.append(record['old'])
        for record in records:
            try:
                _move_no_replace(record['current'], root / record['old'])
                record['current'] = root / record['old']
            except Exception:
                failures.append(record['old'])
        recovery = [{'original': record['old'], 'current': str(record['current'])} for record in records if record['current'] != root / record['old']]
        return {'ok': False, 'kind': 'transaction_failed', 'message': str(error), 'rolled_back': not failures,
                'recovery': recovery, 'warnings': warnings}


def execute_prefix_plan(folder, prefix, plan, on_progress=None):
    try:
        validated = validate_prefix_plan(folder, prefix, plan)
        if not validated['rows']:
            return {'ok': False, 'kind': 'empty', 'message': '没有可处理的文件'}
        return _execute(Path(validated['folder']), validated['rows'], on_progress)
    except Exception as error:
        return {'ok': False, 'kind': 'invalid_plan', 'message': str(error), 'rolled_back': True, 'recovery': []}


def undo_prefix_rename(folder, journal, on_progress=None):
    try:
        root = Path(folder).resolve(strict=True)
        if not isinstance(journal, dict) or root != Path(journal.get('folder', '')).resolve(strict=True):
            raise ValueError('撤销记录与文件夹不一致')
        entries = journal.get('items')
        if not isinstance(entries, list) or not entries:
            raise ValueError('没有可撤销的记录')
        rows = []
        for entry in entries:
            for name in (entry['old'], entry['new']):
                if not isinstance(name, str) or name in ('', '.', '..') or any(c in name for c in '/\\:\x00') or Path(name).name != name:
                    raise ValueError('撤销文件名不能包含路径')
                if (root / name).resolve().parent != root:
                    raise ValueError('撤销路径超出文件夹')
            rows.append({'old': entry['new'], 'new': entry['old'], 'snapshot': entry['snapshot']})
        return _execute(root, rows, on_progress)
    except Exception as error:
        return {'ok': False, 'kind': 'invalid_journal', 'message': str(error), 'rolled_back': True, 'recovery': []}
