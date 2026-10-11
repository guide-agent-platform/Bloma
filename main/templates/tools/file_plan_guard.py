"""Validate a preview for the append-prefix rename operation before any filesystem writes.

This is a local precondition check, not an atomic filesystem security boundary.
Call with the current folder/prefix and the actual preview snapshot used by the product.
"""
from pathlib import Path


def validate_prefix_plan(folder, prefix, plan):
    if not isinstance(prefix, str) or not prefix.strip() or any(c in prefix for c in '<>:"/\\|?*\x00'):
        raise ValueError('前缀不合法，请重新预览')
    root = Path(folder).resolve(strict=True)
    if not root.is_dir() or not isinstance(plan, dict):
        raise ValueError('文件夹或预览不合法')
    if Path(plan.get('folder', '')).resolve(strict=True) != root:
        raise ValueError('预览文件夹与当前选择不一致，请重新预览')
    if plan.get('prefix', prefix) != prefix:
        raise ValueError('预览前缀与当前输入不一致，请重新预览')
    rows = plan.get('rows')
    if not isinstance(rows, list) or (not rows and plan.get('empty') is not True):
        raise ValueError('预览没有可执行的文件')
    names, indexes, targets = set(), set(), set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('预览行不合法')
        old, new, index = row.get('old'), row.get('new'), row.get('index')
        for name in (old, new):
            if not isinstance(name, str) or name in ('', '.', '..') or any(c in name for c in '/\\:\x00') or Path(name).name != name:
                raise ValueError('预览文件名不能包含路径')
        if new != prefix + old:
            raise ValueError('预览目标与当前前缀不一致，请重新预览')
        if type(index) is not int or index < 0 or index in indexes or old.casefold() in names or new.casefold() in targets:
            raise ValueError('预览含重复或非法文件索引')
        if (root / old).resolve().parent != root or (root / new).resolve().parent != root:
            raise ValueError('预览文件不能指向所选文件夹之外')
        names.add(old.casefold()); targets.add(new.casefold()); indexes.add(index)
    return {**plan, 'folder': str(root), 'prefix': prefix, 'rows': [dict(row) for row in rows]}
