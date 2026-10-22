import errno
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('gui_faults', Path(__file__).resolve().parents[2] / 'main/templates/tools/gui_storage_faults.py')
faults = importlib.util.module_from_spec(spec)
spec.loader.exec_module(faults)


class StorageFaultTests(unittest.TestCase):
    def test_enospc_is_scoped_restorable_and_preserves_previous_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'owned'
            root.mkdir()
            data = root / 'records.json'
            data.write_text('[1]')
            try:
                faults.storage_full(root)
                for write in [lambda: data.write_text('[2]'), lambda: os.open(data, os.O_WRONLY), lambda: os.replace(data, root / 'moved.json')]:
                    with self.assertRaises(OSError) as raised:
                        write()
                    self.assertEqual(raised.exception.errno, errno.ENOSPC)
                outside = Path(directory) / 'outside.txt'
                outside.write_text('allowed')
                self.assertEqual(data.read_text(), '[1]')
                self.assertEqual(faults.restore_storage(check=True), {'unchanged': True})
                data.write_text('[3]')
            finally:
                faults.restore_storage()

    def test_corruption_and_removal_touch_only_owned_json_not_input_fixtures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'input').mkdir()
            sample = root / 'input/a.json'
            sample.write_text('["keep"]')
            data = root / 'records.json'
            data.write_text('[1]')
            faults.mutate_data(root)
            with self.assertRaises(ValueError):
                json.loads(data.read_text())
            faults.mutate_data(root, remove=True)
            self.assertFalse(data.exists())
            self.assertEqual(sample.read_text(), '["keep"]')


if __name__ == '__main__':
    unittest.main()
