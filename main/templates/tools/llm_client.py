"""Small OpenAI-compatible HTTP client. No bundled credentials or silent mock fallback.

Products can expose Logic.enhance(request) delegating to LlmClient.generate(request).
The same entry is exercised with a loopback provider by the host's offline probe.
"""
import json
import os
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler


class LlmClient:
    def generate(self, request):
        if not isinstance(request, dict) or not isinstance(request.get('config', {}), dict):
            return {'ok': False, 'kind': 'invalid_input', 'message': '请求参数不合法'}
        config = request.get('config', {})
        if config.get('provider', os.environ.get('LLM_PROVIDER', 'real')) == 'mock':
            return {'ok': True, 'kind': 'mock', 'text': '本地模拟响应，仅用于测试'}
        key = config.get('api_key', '')
        if not isinstance(key, str) or not key.strip():
            return {'ok': False, 'kind': 'unconfigured', 'message': '请配置服务地址、模型和 Key'}
        endpoint = config.get('endpoint', '')
        model = config.get('model', '')
        if not isinstance(endpoint, str) or not isinstance(model, str):
            return {'ok': False, 'kind': 'invalid_config', 'message': '服务地址或模型不合法'}
        parts = urlsplit(endpoint)
        if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or not model:
            return {'ok': False, 'kind': 'invalid_config', 'message': '服务地址或模型不合法'}
        prompt = request.get('prompt')
        if not isinstance(prompt, str) or not prompt.strip():
            return {'ok': False, 'kind': 'invalid_input', 'message': '请输入内容'}
        url = endpoint.rstrip('/')
        if not url.endswith('/chat/completions'):
            url += '/chat/completions'
        payload = json.dumps({'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'stream': False}, ensure_ascii=False).encode('utf8')
        try:
            timeout = min(60, max(.1, float(config.get('timeout', 20))))
            req = Request(url, data=payload, headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key}, method='POST')
            # Explicit endpoint; environment proxy credentials are not inherited.
            with build_opener(ProxyHandler({})).open(req, timeout=timeout) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    return {'ok': False, 'kind': 'invalid_response', 'message': '模型响应过大'}
                text = json.loads(raw)['choices'][0]['message']['content']
                if not isinstance(text, str) or not text.strip():
                    raise ValueError('empty response')
                return {'ok': True, 'kind': 'success', 'text': text}
        except HTTPError as error:
            kinds = {401: 'auth_error', 403: 'auth_error', 404: 'model_error', 429: 'rate_limited'}
            return {'ok': False, 'kind': kinds.get(error.code, 'service_error'), 'message': f'模型服务返回 {error.code}，请检查配置或稍后重试'}
        except (socket.timeout, TimeoutError):
            return {'ok': False, 'kind': 'timeout', 'message': '模型请求超时，请重试'}
        except URLError as error:
            kind = 'timeout' if isinstance(error.reason, (socket.timeout, TimeoutError)) else 'network_error'
            return {'ok': False, 'kind': kind, 'message': '无法连接模型服务，请检查地址或网络'}
        except (ValueError, KeyError, IndexError, TypeError):
            return {'ok': False, 'kind': 'invalid_response', 'message': '模型服务响应不合法'}
