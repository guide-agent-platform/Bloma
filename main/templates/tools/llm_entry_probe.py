"""Exercise the registered product entry against an owned HTTP server, never a paid endpoint."""
import contextlib
import importlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def probe(root, spec):
    requests = []
    state = {'status': 200, 'malformed': False}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            requests.append({'path': self.path, 'auth': self.headers.get('Authorization'), 'body': data})
            self.send_response(state['status'])
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{}' if state['malformed'] else json.dumps({'choices': [{'message': {'content': 'host-stub-result'}}]}).encode())

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    allowed = server.server_address

    def guard(sock, address):
        if address != allowed:
            raise OSError('host probe forbids external connections')
        return original_connect(sock, address)

    socket.socket.connect = guard
    socket.socket.connect_ex = lambda sock, address: (guard(sock, address) or 0)
    tests = []
    try:
        sys.path.insert(0, str(Path(root).resolve()))
        os.environ['LLM_PROVIDER'] = 'real'
        module = importlib.import_module(spec['module'])
        if not Path(module.__file__).resolve().is_relative_to(Path(root).resolve()):
            raise ValueError('registered module is outside product')
        instance = getattr(module, spec['factory'])()
        method = getattr(instance, spec['method'])
        config = {'endpoint': f'http://127.0.0.1:{allowed[1]}/v1', 'model': 'host-test-model', 'api_key': 'host-test-key', 'provider': 'real', 'timeout': 2}
        for name, status, malformed, expected in [('real_request', 200, False, 'success'), ('auth_error', 401, False, 'auth_error'),
                ('model_error', 404, False, 'model_error'), ('rate_limited', 429, False, 'rate_limited'), ('invalid_response', 200, True, 'invalid_response')]:
            state.update(status=status, malformed=malformed)
            before = len(requests)
            response = method({'prompt': 'host-test-prompt', 'config': dict(config)})
            if isinstance(response, str):
                response = json.loads(response)
            sent = requests[-1] if len(requests) == before + 1 else {}
            correct = response.get('kind') == expected and response.get('ok') is (status == 200 and not malformed)
            correct = correct and sent.get('path') == '/v1/chat/completions' and sent.get('auth') == 'Bearer host-test-key'
            correct = correct and sent.get('body', {}).get('model') == 'host-test-model' and sent.get('body', {}).get('messages') == [{'role': 'user', 'content': 'host-test-prompt'}]
            if expected == 'success':
                correct = correct and response.get('text') == 'host-stub-result'
            tests.append({'name': name, 'passed': bool(correct)})
        before = len(requests)
        response = method({'prompt': 'host-test-prompt', 'config': {**config, 'api_key': ''}})
        if isinstance(response, str):
            response = json.loads(response)
        tests.append({'name': 'unconfigured', 'passed': response.get('ok') is False and response.get('kind') == 'unconfigured' and len(requests) == before})
        return {'probe_version': 1, 'status': 'passed' if all(test['passed'] for test in tests) else 'failed', 'tests': tests, 'request_count': len(requests)}
    finally:
        socket.socket.connect = original_connect
        socket.socket.connect_ex = original_connect_ex
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == '__main__':
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            result = probe(sys.argv[1], json.loads(sys.argv[2]))
    except Exception as error:
        result = {'probe_version': 1, 'status': 'environment_blocked', 'error': f'{type(error).__name__}: registered entry could not be exercised'}
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result['status'] == 'passed' else 1 if result['status'] == 'failed' else 2)
