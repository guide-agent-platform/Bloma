import json
from pathlib import Path
import sys
import tempfile
import shutil
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'main/templates/tools'))
import file_transactions as tx


class FileTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bloma-file-transaction-')
        self.root = Path(self.temp.name)
        (self.root / 'a.txt').write_bytes(b'alpha')
        (self.root / 'b.txt').write_bytes(b'beta')
        self.plan = tx.build_prefix_plan(self.root, 'done-')

    def tearDown(self):
        self.temp.cleanup()

    def tree(self):
        return {path.name: path.read_bytes() for path in self.root.iterdir() if path.is_file()}

    def test_rename_undo_keeps_exact_bytes(self):
        before = self.tree()
        result = tx.execute_prefix_plan(self.root, 'done-', self.plan)
        self.assertTrue(result['ok'], result)
        self.assertEqual(self.tree(), {'done-a.txt': b'alpha', 'done-b.txt': b'beta'})
        self.assertTrue(tx.undo_prefix_rename(self.root, result['journal'])['ok'])
        self.assertEqual(self.tree(), before)

    def test_prefix_folder_paths_source_changes_and_new_destinations_refused_before_writes(self):
        for change in ('prefix', 'folder', 'old_escape', 'new_escape', 'source', 'target'):
            with self.subTest(change=change):
                plan = tx.build_prefix_plan(self.root, 'done-')
                prefix = 'other-' if change == 'prefix' else 'done-'
                if change == 'folder': plan['folder'] = str(self.root.parent)
                if change == 'old_escape': plan['rows'][0]['old'] = '../outside.txt'
                if change == 'new_escape': plan['rows'][0]['new'] = '../outside.txt'
                if change == 'source': (self.root / 'a.txt').write_bytes(b'updated')
                if change == 'target': (self.root / 'done-a.txt').write_bytes(b'concurrent')
                before = self.tree()
                self.assertFalse(tx.execute_prefix_plan(self.root, prefix, plan)['ok'])
                self.assertEqual(self.tree(), before)
                if change == 'target': (self.root / 'done-a.txt').unlink()

    def test_exception_after_first_commit_rolls_back_to_original_names(self):
        before = self.tree()
        real = tx._move_no_replace
        calls = []
        def fail_fourth(source, target):
            calls.append((source, target))
            if len(calls) == 4: raise OSError('owned injected filesystem failure')
            real(source, target)
        with patch.object(tx, '_move_no_replace', side_effect=fail_fourth):
            result = tx.execute_prefix_plan(self.root, 'done-', self.plan)
        self.assertFalse(result['ok'])
        self.assertTrue(result['rolled_back'], result)
        self.assertEqual(self.tree(), before)

    def test_progress_exception_cannot_turn_success_into_broken_rollback(self):
        def bad_progress(*args): raise RuntimeError('notification failed')
        result = tx.execute_prefix_plan(self.root, 'done-', self.plan, bad_progress)
        self.assertTrue(result['ok'])
        self.assertTrue(result['warnings'])
        self.assertTrue(tx.undo_prefix_rename(self.root, result['journal'])['ok'])
        self.assertEqual(self.tree(), {'a.txt': b'alpha', 'b.txt': b'beta'})

    def test_blocked_rollback_preserves_concurrent_file_and_reports_recovery_location(self):
        real = tx._move_no_replace
        calls = [0]
        def conflict(source, target):
            calls[0] += 1
            if calls[0] == 4:
                (self.root / 'a.txt').write_bytes(b'concurrent writer')
                raise OSError('commit failed')
            real(source, target)
        with patch.object(tx, '_move_no_replace', side_effect=conflict):
            result = tx.execute_prefix_plan(self.root, 'done-', self.plan)
        self.assertFalse(result['ok'])
        self.assertFalse(result['rolled_back'])
        self.assertEqual((self.root / 'a.txt').read_bytes(), b'concurrent writer')
        self.assertEqual((self.root / 'b.txt').read_bytes(), b'beta')
        self.assertEqual(len(result['recovery']), 1)
        self.assertEqual(Path(result['recovery'][0]['current']).read_bytes(), b'alpha')

    def test_overlapping_names_restore_without_overwriting_and_preserve_unrelated_file(self):
        (self.root / 'done-a.txt').write_bytes(b'older')
        before = self.tree()
        plan = tx.build_prefix_plan(self.root, 'done-')
        real = tx._move_no_replace
        count = [0]
        def fail_last(source, target):
            count[0] += 1
            if count[0] == 6: raise OSError('last commit failed')
            real(source, target)
        with patch.object(tx, '_move_no_replace', side_effect=fail_last):
            result = tx.execute_prefix_plan(self.root, 'done-', plan)
        self.assertTrue(result['rolled_back'], result)
        self.assertEqual(self.tree(), before)

    def test_undo_refuses_modified_file_and_existing_original(self):
        result = tx.execute_prefix_plan(self.root, 'done-', self.plan)
        (self.root / 'a.txt').write_bytes(b'another writer')
        before = self.tree()
        self.assertFalse(tx.undo_prefix_rename(self.root, result['journal'])['ok'])
        self.assertEqual(self.tree(), before)
        (self.root / 'a.txt').unlink()
        (self.root / 'done-a.txt').write_bytes(b'changed')
        before = self.tree()
        self.assertFalse(tx.undo_prefix_rename(self.root, result['journal'])['ok'])
        self.assertEqual(self.tree(), before)

    def test_platform_probe_accepts_modular_actual_entry_and_all_seven_counterexamples(self):
        with tempfile.TemporaryDirectory(prefix='bloma-modular-product-') as directory:
            root = Path(directory)
            for name in ('file_transactions.py', 'file_plan_guard.py'):
                shutil.copy2(ROOT / 'main/templates/tools' / name, root / name)
            (root / 'core').mkdir()
            (root / 'core/__init__.py').write_text('', encoding='utf8')
            (root / 'core/logic.py').write_text('''from file_transactions import build_prefix_plan, execute_prefix_plan, undo_prefix_rename
class Logic:
 def __init__(self, data=None): self.journal = None
 def preview(self, folder, prefix): return build_prefix_plan(folder, prefix)
 def execute_rename(self, folder, prefix, plan=None):
  result = execute_prefix_plan(folder, prefix, plan)
  if result.get('ok'): self.journal = result['journal']
  return result
 def undo_last(self): return undo_prefix_rename(self.journal['folder'], self.journal)
''', encoding='utf8')
            (root / 'app.py').write_text('from core.logic import Logic\n', encoding='utf8')
            result = subprocess.run([sys.executable, '-B', str(ROOT / 'main/templates/tools/prefix_rename_probe.py'), str(root), '--require-undo'], capture_output=True, text=True, timeout=15)
            evidence = json.loads(result.stdout)
            self.assertEqual(evidence['status'], 'passed', evidence)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(len(evidence['tests']), 7)


if __name__ == '__main__':
    unittest.main()
