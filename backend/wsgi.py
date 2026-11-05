"""WSGI entry point for managed Python hosts."""
from email.message import Message
from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace

from backend.api import Handler, ROOT
from backend.history import HistoricalArchive
from backend.repository import StrategyRepository
from backend.services import ReplayService
from replay_engine.native import NativeCatalog


class WSGIRequest(Handler):
    def __init__(self, environ, start_response, server):
        self.command = environ["REQUEST_METHOD"]
        self.path = environ["PATH_INFO"] or "/"
        self.rfile = environ["wsgi.input"]
        self.headers = Message()
        for key in ("HOST", "ORIGIN", "AUTHORIZATION"):
            value = environ.get("HTTP_" + key)
            if value is not None:
                self.headers[key] = value
        for key in ("CONTENT_TYPE", "CONTENT_LENGTH"):
            value = environ.get(key)
            if value:
                self.headers[key.replace("_", "-")] = value
        self.server = server
        self.start_response = start_response
        self.output = []
        self.dispatch()

    def send_payload(self, status, payload, content_type, headers=None):
        response_headers = [
            ("Content-Type", content_type), ("Content-Length", str(len(payload))),
            ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
        ]
        response_headers.extend((headers or {}).items())
        self.start_response(f"{status} {HTTPStatus(status).phrase}", response_headers)
        if self.command != "HEAD":
            self.output.append(payload)


def create_application(host, password, data_dir):
    if not host or len(password) < 16:
        raise ValueError("WSGI deployment requires an HTTPS host and a strong password.")
    data_dir = Path(data_dir)
    service = ReplayService(
        StrategyRepository(data_dir / "strategies.json"),
        NativeCatalog(data_dir / "native-strategies"),
        HistoricalArchive(ROOT / "history_data"),
        parallel_batch=False,
    )
    server = SimpleNamespace(
        service=service, public_host=host, origin=f"https://{host}",
        credentials=("market-replay:" + password).encode("utf-8"),
    )

    def application(environ, start_response):
        return WSGIRequest(environ, start_response, server).output

    return application
