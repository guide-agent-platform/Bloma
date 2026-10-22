"""Bounded storage faults inside the test's APP_DATA_DIR, never product source."""
import builtins
import errno
import hashlib
import io
import os
from pathlib import Path

originals = {}
snapshot = {}


def data_files(root):
    root = Path(root).resolve()
    files = []
    for path in root.rglob('*'):
        if not path.is_file() or 'input' in path.relative_to(root).parts:
            continue
        if not path.resolve().is_relative_to(root):
            raise RuntimeError('GUI_DATA_PATH_ESCAPE')
        if path.suffix.lower() == '.json':
            if path.stat().st_size > 1048576 or len(files) >= 64:
                raise RuntimeError('GUI_DATA_FIXTURE_LIMIT')
            files.append(path)
    return files


def storage_full(root):
    root = Path(root).resolve()
    if originals:
        raise RuntimeError('GUI_STORAGE_FAULT_ALREADY_ACTIVE')
    snapshot.update({path: hashlib.sha256(path.read_bytes()).hexdigest() for path in data_files(root)})

    def owned(path):
        return isinstance(path, (str, bytes, os.PathLike)) and Path(os.fsdecode(path)).resolve().is_relative_to(root)

    def denied(path):
        raise OSError(errno.ENOSPC, 'Host-injected storage full', str(path))

    for module, name in [(builtins, 'open'), (io, 'open'), (os, 'open'), (os, 'replace'), (os, 'rename')]:
        original = getattr(module, name)
        originals[(module, name)] = original

        def wrapped(path, *args, _original=original, _name=name, _module=module, **kwargs):
            if _name in ('replace', 'rename'):
                if owned(path) or args and owned(args[0]):
                    denied(path)
            elif _module is os:
                flags = args[0] if args else kwargs.get('flags', 0)
                if owned(path) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                    denied(path)
            else:
                mode = args[0] if args else kwargs.get('mode', 'r')
                if owned(path) and any(flag in mode for flag in 'wax+'):
                    denied(path)
            return _original(path, *args, **kwargs)
        setattr(module, name, wrapped)
    return {'fault': 'ENOSPC', 'scope': 'isolated_APP_DATA_DIR', 'files': len(snapshot)}


def restore_storage(check=False):
    for (module, name), original in list(originals.items()):
        setattr(module, name, original)
    originals.clear()
    unchanged = all(path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == before for path, before in snapshot.items())
    snapshot.clear()
    if check and not unchanged:
        raise AssertionError('GUI_FAILED_OPERATION_MUTATED_DATA')
    return {'unchanged': unchanged}


def mutate_data(root, remove=False):
    files = data_files(root)
    if not files:
        raise RuntimeError('GUI_JSON_DATA_UNAVAILABLE')
    for path in files:
        if remove:
            path.unlink()
        else:
            path.write_text('{host-injected-corrupt-json', encoding='utf-8')
    return {'fault': 'removed_json' if remove else 'corrupt_json', 'files': len(files)}
