import argparse
import json
import os
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit

from pricing import Catalog
from usage import PHASES, collect
from audit import Exchange, LocalAudit, add_findings

WEB = Path(__file__).with_name("web")
STATIC = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
          "/review.js": ("review.js", "text/javascript"),
          "/audit-config.json": ("../audit-config.json", "application/json"),
          "/standalone.js": ("standalone.js", "text/javascript"), "/styles.css": ("styles.css", "text/css")}


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, home, catalog, audit, exchange, **kwargs):
        self.home = home
        self.catalog = catalog
        self.audit = audit
        self.exchange = exchange
        super().__init__(*args, **kwargs)

    def valid_host(self):
        return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

    def respond(self, status, data, mime):
        self.send_response(status)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(data)

    def json_response(self, data, status=200):
        self.respond(status, json.dumps(data, ensure_ascii=False).encode(), "application/json")

    def do_GET(self):
        if not self.valid_host():
            return self.json_response({"error": "请使用服务显示的本机地址"}, 403)
        route = urlsplit(self.path).path
        if route == "/api/usage":
            data = collect(self.home)
            add_findings(self.home, data["rows"])
            return self.json_response(data | {"phases": PHASES, "pricing": self.catalog.snapshot(), "fx": self.exchange.current})
        if route == "/api/audit/models":
            try:
                return self.json_response(self.audit.models())
            except (OSError, ValueError) as error:
                return self.json_response({"error": str(error)}, 503)
        if route == "/api/audit/status":
            return self.json_response(self.audit.status())
        if route == "/api/pricing":
            return self.json_response(self.catalog.snapshot())
        if route in STATIC:
            file, mime = STATIC[route]
            if route == "/":
                page = (WEB / file).read_text(encoding="utf-8")
                panel = (WEB / "panel.html").read_text(encoding="utf-8")
                return self.respond(200, page.replace("<!-- token-monitor-panel -->", panel).encode(), mime)
            return self.respond(200, (WEB / file).read_bytes(), mime)
        self.json_response({"error": "页面不存在"}, 404)

    def do_POST(self):
        origin = f"http://127.0.0.1:{self.server.server_port}"
        if not self.valid_host() or self.headers.get("Origin") != origin:
            return self.json_response({"error": "仅接受本机页面请求"}, 403)
        if self.path == "/api/pricing/refresh":
            self.catalog.refresh()
            self.exchange.refresh()
            return self.json_response(self.catalog.snapshot())
        if self.path == "/api/audit/stop":
            return self.json_response(self.audit.stop())
        if self.path == "/api/audit/start":
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 4096:
                    raise ValueError("无效的审查参数")
                return self.json_response(self.audit.start(json.loads(self.rfile.read(size))), 202)
            except (OSError, ValueError, TypeError, AttributeError) as error:
                return self.json_response({"error": str(error)}, 400)
        return self.json_response({"error": "页面不存在"}, 404)


def main():
    home = os.getenv("PROMA_HOME", "").strip()
    default_home = Path(home) if home and home not in ("undefined", "null") else Path.home() / ".proma"
    parser = argparse.ArgumentParser(description="Bloma 本机 Token 用量监测")
    parser.add_argument("--home", type=Path, default=default_home)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--offline", action="store_true", help="启动时使用缓存价格")
    args = parser.parse_args()
    catalog = Catalog(args.home / "token-monitor" / "pricing-cache.json")
    exchange = Exchange(args.home)
    with ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, home=args.home, catalog=catalog,
                                                                audit=LocalAudit(args.home), exchange=exchange)) as server:
        print(f"Bloma Token Monitor  http://127.0.0.1:{server.server_port}/", flush=True)
        if not args.offline:
            Thread(target=catalog.refresh, daemon=True).start()
            Thread(target=exchange.refresh, daemon=True).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
