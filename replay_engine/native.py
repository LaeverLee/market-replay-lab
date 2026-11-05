"""Replay an approved versioned strategy through its own frozen adapter."""
import csv
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from .replay import FIELDS, validate_rows


# Only reviewed bundles can be executed by an HTTP request.
APPROVED = {"BTC-0183@1.0.0": ("BTC-0183", "v1.0.0", "1h")}


class NativeCatalog:
    def __init__(self, root):
        self.root = Path(root).resolve()

    def list(self):
        return [{"id": key, "name": key.replace("@", " · "), "interval": frame,
                 "market": "BTCUSDT USDⓈ-M 永續合約"}
                for key, (name, version, frame) in APPROVED.items()
                if (self.root / name / version / "adapter.py").is_file()]

    def replay(self, key, rows, frame):
        if not isinstance(key, str) or key not in APPROVED:
            raise ValueError("找不到已核准的 Python 策略版本。")
        name, version, expected_frame = APPROVED[key]
        if frame != expected_frame:
            raise ValueError("此 Python 策略需要 " + expected_frame + " K 線。")
        validate_rows(rows, frame)
        bundle = (self.root / name / version).resolve()
        if not bundle.is_relative_to(self.root) or not (bundle / "adapter.py").is_file():
            raise ValueError("此機器沒有該 Python 策略。")
        contract = json.loads((bundle / "execution_contract.json").read_text(encoding="utf-8-sig"))
        if (contract.get("status") != "EXECUTABLE" or contract.get("adapter") != "adapter.py:execute"
                or contract.get("timeframe") != frame
                or contract.get("market") != "BINANCE_BTCUSDT_USDT_PERPETUAL"):
            raise ValueError("策略執行契約與本機登錄不符。")
        with TemporaryDirectory(prefix="market-replay-native-") as temp:
            source, result = Path(temp) / "candles.csv", Path(temp) / "result.json"
            with source.open("w", newline="", encoding="utf-8") as stream:
                writer = csv.writer(stream)
                writer.writerow(("timestamp", *FIELDS))
                for row in rows:
                    timestamp = datetime.fromtimestamp(row["t"]/1000, timezone.utc).isoformat()
                    writer.writerow((timestamp, *(row[field] for field in FIELDS)))
            env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP", "PATH") if key in os.environ}
            try:
                process = subprocess.run(
                    [sys.executable, "-B", str(bundle / "adapter.py"), "--candles", str(source), "--output", str(result)],
                    cwd=temp, env=env, capture_output=True, timeout=60,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except subprocess.TimeoutExpired as error:
                raise ValueError("Python 策略超過 60 秒的執行上限。") from error
            if process.returncode or not result.is_file():
                raise ValueError("Python 策略執行失敗。請確認行情與策略相容，且已安裝 pandas / numpy。")
            return json.loads(result.read_text(encoding="utf-8"))
