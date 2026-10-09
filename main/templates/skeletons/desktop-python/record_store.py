"""Transactional local JSON records; UI-independent and safe on failed writes."""
from __future__ import annotations

import copy
import json
import os
import tempfile
import threading
from pathlib import Path


class DataIntegrityError(ValueError):
    pass


class JsonRecordStore:
    def __init__(self, path: Path, required_keys=(), validator=None):
        self.path = Path(path)
        self.required_keys = tuple(required_keys)
        self.validator = validator
        self._lock = threading.RLock()
        self._records = []
        self._load_error = None
        try:
            if self.path.exists():
                records = json.loads(self.path.read_text(encoding="utf-8"))
                self._validate(records)
                self._records = records
        except (OSError, ValueError, TypeError) as error:
            self._load_error = DataIntegrityError(
                f"无法读取数据文件 {self.path}，请检查文件或从备份恢复；原文件未被修改：{error}"
            )

    def _validate(self, records):
        if not isinstance(records, list) or any(not isinstance(row, dict) for row in records):
            raise DataIntegrityError("数据必须是记录列表")
        if any(any(key not in row for key in self.required_keys) for row in records):
            raise DataIntegrityError("记录缺少必要字段")
        if self.validator is not None:
            self.validator(records)

    def _ensure_readable(self):
        if self._load_error is not None:
            raise self._load_error

    def read(self):
        with self._lock:
            self._ensure_readable()
            return copy.deepcopy(self._records)

    def update(self, transform):
        """Apply to a copy, persist atomically, then commit memory; content duplicates are allowed."""
        with self._lock:
            self._ensure_readable()
            candidate = copy.deepcopy(self._records)
            result = transform(candidate)
            self._validate(candidate)
            payload = json.dumps(candidate, ensure_ascii=False, indent=2)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                                 prefix=self.path.name + ".", suffix=".tmp", delete=False) as file:
                    temporary = Path(file.name)
                    file.write(payload)
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(temporary, self.path)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            self._records = copy.deepcopy(candidate)
            return copy.deepcopy(result)
