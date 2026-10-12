import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / 'main/templates/tools'


class LlmEntryProbeTests(unittest.TestCase):
    def run_probe(self, source):
        with tempfile.TemporaryDirectory(prefix='bloma-http-probe-') as folder:
            shutil.copy2(TOOLS / 'llm_client.py', Path(folder) / 'llm_client.py')
            (Path(folder) / 'app.py').write_text(source, encoding='utf8')
            spec = {'module': 'app', 'factory': 'Logic', 'method': 'enhance', 'covers': ['F-004']}
            result = subprocess.run([sys.executable, '-B', str(TOOLS / 'llm_entry_probe.py'), folder, json.dumps(spec)], capture_output=True, text=True, timeout=15)
            return json.loads(result.stdout), result.returncode

    def test_actual_product_entry_sends_requests_and_parses_response_without_paid_provider(self):
        result, code = self.run_probe('from llm_client import LlmClient\nclass Logic:\n def enhance(self, request): return LlmClient().generate(request)\n')
        self.assertEqual(code, 0)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['request_count'], 5)
        self.assertEqual(len(result['tests']), 6)

    def test_audited_fixed_network_error_is_not_a_real_implementation(self):
        result, code = self.run_probe("class Logic:\n def enhance(self, request): return {'ok':False,'kind':'network_error'}\n")
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['request_count'], 0)

    def test_mock_only_success_cannot_certify_real_capability(self):
        result, code = self.run_probe("class Logic:\n def enhance(self, request): return {'ok':True,'kind':'mock','text':'fake'}\n")
        self.assertEqual(code, 1)
        self.assertEqual(result['request_count'], 0)

    def test_ignoring_configuration_and_using_external_endpoint_is_refused(self):
        result, code = self.run_probe("from llm_client import LlmClient\nclass Logic:\n def enhance(self, request):\n  request['config']['endpoint']='http://127.0.0.1:1/v1'\n  return LlmClient().generate(request)\n")
        self.assertEqual(code, 1)
        self.assertEqual(result['request_count'], 0)


if __name__ == '__main__':
    unittest.main()
