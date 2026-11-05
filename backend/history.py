"""Read verified Binance archive shards and construct UTC-aligned candles."""
from calendar import monthrange
import csv
from datetime import date, datetime, timedelta, timezone
import io
from heapq import merge
from itertools import groupby
import json
from pathlib import Path
from zipfile import ZipFile

from replay_engine import FRAMES, validate_rows

MINUTE = 60_000


def millis(day):
    return int(datetime.combine(day, datetime.min.time(), timezone.utc).timestamp()) * 1000


def utc_day(timestamp):
    return datetime.fromtimestamp(timestamp / 1000, timezone.utc).date()


class HistoricalArchive:
    def __init__(self, root):
        self.root = Path(root)

    def shards(self, series="klines"):
        try:
            manifest = json.loads((self.root / "manifest.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        result = []
        for shard in manifest["shards"]:
            if shard["status"] != "verified" or shard["series"] != series:
                continue
            monthly = shard["frequency"] == "monthly"
            start = date.fromisoformat(shard["period"] + ("-01" if monthly else ""))
            days = monthrange(start.year, start.month)[1] if monthly else 1
            path = self.root / "binance-usdm" / shard["path"]
            if path.is_file():
                result.append((millis(start), millis(start + timedelta(days=days)), path))
        return sorted(result)

    @staticmethod
    def _rows(path):
        with ZipFile(path) as archive, archive.open(archive.namelist()[0]) as stream:
            for row in csv.reader(io.TextIOWrapper(stream, encoding="utf-8-sig")):
                if row and row[0] not in ("open_time", "openTime"):
                    yield int(row[0]), row

    def minute_rows(self, start, end, shards=None):
        shards = self.shards() if shards is None else shards
        eligible = (item for item in shards if item[1] > start and item[0] < end)
        for _, month in groupby(eligible, key=lambda item: utc_day(item[0]).replace(day=1)):
            for timestamp, raw in merge(*(self._rows(path) for _, _, path in month), key=lambda item: item[0]):
                if timestamp >= end:
                    break
                if timestamp >= start:
                    yield timestamp, raw

    def coverage(self):
        shards = self.shards()
        if not shards:
            return {"available": False}
        return {"available": True, "start": str(utc_day(shards[0][0])),
                "through": str(utc_day(max(last for _, last, _ in shards)-1)), "intervals": list(FRAMES)}

    def read(self, frame, start=None, end=None, *, warmup=0):
        if not isinstance(frame, str) or frame not in FRAMES:
            raise ValueError("K 線週期不受支援。")
        shards = self.shards()
        if not shards:
            raise ValueError("本機尚未下載歷史資料。")
        step = FRAMES[frame]
        lower, upper = shards[0][0], max(last for _, last, _ in shards)
        if any(value is not None and type(value) is not int for value in (start, end)):
            raise ValueError("歷史資料日期無效。")
        end = upper if end is None else end
        end = end // step * step
        if not lower < end <= upper:
            raise ValueError("結束日期超過本機行情覆蓋範圍。")
        start = max(lower, end - 1000*step) if start is None else start
        if not lower <= start < end:
            raise ValueError("開始日期超過本機行情覆蓋範圍。")
        start = -(-start // step) * step
        fetch_from = max(lower, start - warmup*step)
        if (end-fetch_from)//step > 100_000:
            raise ValueError("每次回測最多 100,000 根 K 線（含暖機），請縮短日期範圍。")
        if end - start < 2*step:
            raise ValueError("所選區間至少需兩根完整 K 線。")
        rows = []
        expected = fetch_from
        current = None
        for t, raw in self.minute_rows(fetch_from, end, shards):
            if t != expected or int(raw[6]) != t+MINUTE-1:
                raise ValueError("歷史行情在 " + datetime.fromtimestamp(expected/1000, timezone.utc).isoformat()
                                 + " 有缺根或重複。請縮短日期區間。")
            expected += MINUTE
            op, high, low, close, volume = map(float, raw[1:6])
            if t % step == 0:
                current = dict(t=t, open=op, high=high, low=low, close=close, volume=volume)
            else:
                current["high"] = max(current["high"], high)
                current["low"] = min(current["low"], low)
                current["close"] = close
                current["volume"] += volume
            if expected % step == 0:
                rows.append(current)
        if expected != end:
            raise ValueError("所選日期有缺少的歷史檔或尚未公布的行情。")
        validate_rows(rows, frame)
        return rows, start, end
