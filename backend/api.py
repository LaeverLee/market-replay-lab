"""Local HTTP API and static frontend launcher."""
from base64 import b64decode
from binascii import Error as Base64Error
from hmac import compare_digest
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
if __package__ in ("", None):
    sys.path.insert(0, str(ROOT))

from backend.history import HistoricalArchive
from backend.repository import StrategyRepository
from backend.services import ReplayService, RULE_ID
from replay_engine.native import NativeCatalog

ASSETS = {"/": "index.html", **{"/" + file: file for file in (
    "index.html", "app.mjs", "api.mjs", "engine.mjs", "live-feed.mjs", "style.css", "icon.svg")}}
TYPES = {".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}


class Handler(BaseHTTPRequestHandler):
    def send_payload(self, status, payload, content_type, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_json(self, status, value, headers=None):
        self.send_payload(status, json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"),
                          "application/json; charset=utf-8", headers)

    def body(self, limit):
        if self.headers.get_content_type() != "application/json":
            raise ValueError("只接受 JSON。")
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= limit:
            raise ValueError("請求內容空白或超過資料上限。")
        value = self.rfile.read(length)
        return json.loads(value)

    def do_GET(self):
        self.dispatch()

    do_HEAD = do_POST = do_DELETE = do_GET

    def authenticated(self):
        token = self.headers.get("Authorization", "")
        scheme, _, encoded = token.partition(" ")
        if scheme.lower() != "basic":
            return False
        try:
            supplied = b64decode(encoded, validate=True)
        except (ValueError, Base64Error):
            return False
        return compare_digest(supplied, self.server.credentials)

    def dispatch(self):
        service = self.server.service
        method = self.command
        try:
            path = urlsplit(self.path).path
            if method == "GET" and path == "/api/health":
                self.send_json(200, {"ok": True, "backend": "python"})
                return
            if self.headers.get("Host") != self.server.public_host or (
                    method in ("POST", "DELETE") and self.headers.get("Origin") not in (None, self.server.origin)):
                self.send_json(403, {"error": "請透過網站的正式網址操作。"})
                return
            if self.server.credentials is not None and not self.authenticated():
                self.send_json(401, {"error": "請登入行情實驗室。"},
                               {"WWW-Authenticate": 'Basic realm="Market Replay Lab", charset="UTF-8"'})
                return
            if path == "/api/strategies" and method == "GET":
                self.send_json(200, service.repository.list())
            elif path == "/api/strategies" and method == "POST":
                self.send_json(200, service.save_rules(self.body(8 * 1024**2)))
            elif path.startswith("/api/strategies/") and method == "DELETE":
                rule_id = path.rsplit("/", 1)[-1]
                if not RULE_ID.fullmatch(rule_id):
                    raise ValueError("策略識別碼無效。")
                service.repository.remove(rule_id)
                self.send_json(200, {"ok": True})
            elif path == "/api/backtests" and method == "POST":
                self.send_json(200, {"accounts": service.backtest(self.body(96 * 1024**2))})
            elif path == "/api/history-coverage" and method == "GET":
                self.send_json(200, service.history.coverage())
            elif path == "/api/archive-batch" and method == "POST":
                self.send_json(200, service.archive_batch(self.body(1024**2)))
            elif path == "/api/archive-backtests" and method == "POST":
                self.send_json(200, service.archive_backtest(self.body(1024**2)))
            elif path == "/api/python-strategies" and method == "GET":
                self.send_json(200, service.native_catalog.list())
            elif path == "/api/python-backtests" and method == "POST":
                data = self.body(32 * 1024**2)
                self.send_json(200, service.native_catalog.replay(data["id"], data["rows"], data["frame"]))
            elif path in ASSETS and method in ("GET", "HEAD"):
                file = ROOT / "dist" / ASSETS[path]
                self.send_payload(200, file.read_bytes(), TYPES[file.suffix])
            else:
                self.send_json(404, {"error": "找不到資源。"})
        except (BrokenPipeError, ConnectionResetError):
            return
        except (ValueError, KeyError, TypeError, OverflowError) as error:
            self.send_json(400, {"error": str(error)})
        except OSError:
            self.send_json(500, {"error": "本機伺服器讀寫失敗。"})


def main():
    cloud = os.environ.get("MARKET_REPLAY_CLOUD") == "1"
    port = int(os.environ.get("PORT", "10000") if cloud else os.environ.get("MARKET_REPLAY_PORT", "8783"))
    public_host = os.environ.get("RENDER_EXTERNAL_HOSTNAME", "") if cloud else f"127.0.0.1:{port}"
    credentials = None
    if cloud:
        password = os.environ.get("MARKET_REPLAY_PASSWORD", "")
        if not public_host or len(password) < 16:
            raise SystemExit("Cloud mode requires RENDER_EXTERNAL_HOSTNAME and a strong MARKET_REPLAY_PASSWORD.")
        credentials = ("market-replay:" + password).encode("utf-8")
    scheme = "https" if cloud else "http"
    data_dir = Path(os.environ.get("MARKET_REPLAY_DATA_DIR",
                                  Path(os.environ.get("LOCALAPPDATA", Path.home())) / "MarketReplayLab"))
    strategy_root = os.environ.get("MARKET_REPLAY_STRATEGY_ROOT", ROOT.parents[1] / "strategies")
    bind = "0.0.0.0" if cloud else "127.0.0.1"
    with ThreadingHTTPServer((bind, port), Handler) as server:
        server.public_host = public_host
        server.origin = f"{scheme}://{public_host}"
        server.credentials = credentials
        history_root = os.environ.get("MARKET_REPLAY_HISTORY_ROOT", ROOT / "history_data")
        server.service = ReplayService(StrategyRepository(data_dir / "strategies.json"),
                                       NativeCatalog(strategy_root), HistoricalArchive(history_root))
        print(f"Market Replay Lab: {server.origin}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
