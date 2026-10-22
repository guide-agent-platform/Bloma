"""Deliberately small real native UI fixture; not evidence of generated quality."""
import json
import os
from pathlib import Path
import webview

data = Path(os.environ['APP_DATA_DIR']) / 'records.json'


class Api:
    def list_items(self):
        try:
            if not data.exists() and data.with_suffix('.initialized').exists():
                return json.dumps({'error': 'Load failed: missing data'})
            return json.dumps(json.loads(data.read_text()) if data.exists() else [])
        except (OSError, ValueError):
            return json.dumps({'error': 'Load failed: corrupt data'})

    def add_item(self, value):
        if not value.strip():
            return json.dumps({'error': 'Name required'})
        rows = json.loads(self.list_items())
        if isinstance(rows, dict):
            return json.dumps(rows)
        items = rows + [value]
        data.parent.mkdir(parents=True, exist_ok=True)
        try:
            data.write_text(json.dumps(items))
            data.with_suffix('.initialized').write_text('1')
        except OSError:
            return json.dumps({'error': 'Save failed'})
        return json.dumps({'ok': True})


if __name__ == '__main__':
    webview.create_window('Bloma native GUI acceptance fixture', str(Path(__file__).parent / 'index.html'), js_api=Api())
    webview.start()
