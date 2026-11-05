"""Local HTTP API and static frontend launcher."""
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
    def send_payload(self, status, payload, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_json(self, status, value):
        self.send_payload(status, json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"),
                          "application/json; charset=utf-8")

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

    def dispatch(self):
        service = self.server.service
        address = f"127.0.0.1:{self.server.server_port}"
        method = self.command
        if self.headers.get("Host") != address or (
                method in ("POST", "DELETE") and self.headers.get("Origin") not in (None, f"http://{address}")):
            self.send_json(403, {"error": "請透過本機網址操作。"})
            return
        try:
            path = urlsplit(self.path).path
            if method == "GET" and path == "/api/health":
                self.send_json(200, {"ok": True, "backend": "python"})
            elif path == "/api/strategies" and method == "GET":
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
    port = int(os.environ.get("MARKET_REPLAY_PORT", "8783"))
    data_dir = Path(os.environ.get("MARKET_REPLAY_DATA_DIR",
                                  Path(os.environ.get("LOCALAPPDATA", Path.home())) / "MarketReplayLab"))
    strategy_root = os.environ.get("MARKET_REPLAY_STRATEGY_ROOT", ROOT.parents[1] / "strategies")
    with ThreadingHTTPServer(("127.0.0.1", port), Handler) as server:
        history_root = os.environ.get("MARKET_REPLAY_HISTORY_ROOT", ROOT / "history_data")
        server.service = ReplayService(StrategyRepository(data_dir / "strategies.json"),
                                       NativeCatalog(strategy_root), HistoricalArchive(history_root))
        print(f"Market Replay Lab: http://127.0.0.1:{port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
