"""Deliberately small real native UI fixture; not evidence of generated quality."""
import json
import os
from pathlib import Path
import webview

data = Path(os.environ['APP_DATA_DIR']) / 'records.json'


class Api:
    def list_items(self):
        return json.dumps(json.loads(data.read_text()) if data.exists() else [])

    def add_item(self, value):
        if not value.strip():
            return json.dumps({'error': 'Name required'})
        items = json.loads(self.list_items()) + [value]
        data.parent.mkdir(parents=True, exist_ok=True)
        data.write_text(json.dumps(items))
        return json.dumps({'ok': True})


if __name__ == '__main__':
    webview.create_window('Bloma native GUI acceptance fixture', str(Path(__file__).parent / 'index.html'), js_api=Api())
    webview.start()
