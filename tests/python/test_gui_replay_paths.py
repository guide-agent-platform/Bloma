"""Validate the independent test harness boundary; no applications are started."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('replay', Path(__file__).resolve().parents[2] / 'scripts/robustness-ui-replay.py')
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)


class ReplayPathTests(unittest.TestCase):
    def test_extended_drive_and_unc_are_representation_only(self):
        self.assertEqual(replay.strip_windows_namespace('\\\\?\\C:\\Temp\\owned\\a.txt'), 'C:\\Temp\\owned\\a.txt')
        self.assertEqual(replay.strip_windows_namespace('\\\\?\\UNC\\server\\share\\a.txt'), '\\\\server\\share\\a.txt')
        self.assertEqual(replay.strip_windows_namespace('C:\\Temp\\owned\\a.txt'), 'C:\\Temp\\owned\\a.txt')

    def test_owned_file_remains_readable_but_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            fixture = replay.Replay(root, root, None, {})
            self.assertEqual(fixture.file('input/a.txt'), root / 'input/a.txt')
            with self.assertRaises(ValueError): fixture.file('../outside/a.txt')


if __name__ == '__main__': unittest.main(verbosity=2)
