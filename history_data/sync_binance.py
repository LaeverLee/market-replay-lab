"""Download and verify official BTCUSDT USD-M archive shards."""
import argparse
import csv
import io
from calendar import monthrange
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
from time import sleep
from urllib.error import HTTPError
from urllib.request import urlopen
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent
BASE = "https://data.binance.vision/data/futures/um"
SERIES = ("klines", "markPriceKlines", "fundingRate")


def chunks(through):
    month = date(2020, 1, 1)
    while month <= through:
        last = month.replace(day=monthrange(month.year, month.month)[1])
        if last <= through:
            for series in SERIES:
                yield series, "monthly", month.strftime("%Y-%m")
        else:
            for i in range((through-month).days+1):
                for series in SERIES[:2]:
                    yield series, "daily", str(month+timedelta(days=i))
        month = last + timedelta(days=1)


def relative_path(series, frequency, period):
    name = "BTCUSDT-fundingRate" if series == "fundingRate" else "BTCUSDT-1m"
    folder = "" if series == "fundingRate" else "/1m"
    return f"{frequency}/{series}/BTCUSDT{folder}/{name}-{period}.zip"


def fetch(url):
    for attempt in range(4):
        try:
            with urlopen(url, timeout=20) as response:
                return response.read()
        except HTTPError as error:
            if error.code == 404:
                raise
            if error.code not in (429, 500, 502, 503, 504):
                raise
        except OSError:
            if attempt == 3:
                raise
        sleep(2**attempt)
    raise OSError("Repeated download failure")


def download(task):
    series, frequency, period = task
    relative = relative_path(*task)
    url = f"{BASE}/{relative}"
    output = ROOT / "binance-usdm" / relative
    check = output.with_suffix(".zip.CHECKSUM")
    try:
        checksum = check.read_bytes() if output.is_file() and check.is_file() else fetch(url+".CHECKSUM")
        expected = checksum.decode("ascii").split()[0].lower()
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError("Invalid upstream checksum")
        payload = output.read_bytes() if output.is_file() else b""
        if hashlib.sha256(payload).hexdigest() != expected:
            payload = fetch(url)
        if hashlib.sha256(payload).hexdigest() != expected:
            raise ValueError("SHA-256 mismatch")
        if not output.is_file() or output.read_bytes() != payload:
            output.parent.mkdir(parents=True, exist_ok=True)
            tmp = output.with_suffix(".tmp")
            tmp.write_bytes(payload)
            with ZipFile(tmp) as archive:
                if len(archive.namelist()) != 1 or archive.testzip() is not None:
                    raise ValueError("Invalid archive")
            tmp.replace(output)
        check.write_bytes(checksum)
        return {"series": series, "frequency": frequency, "period": period, "path": relative,
                "bytes": len(payload), "sha256": expected, "status": "verified"}
    except HTTPError as error:
        return {"series": series, "frequency": frequency, "period": period,
                "status": "unavailable" if error.code == 404 else "error", "http": error.code}
    except (OSError, ValueError) as error:
        return {"series": series, "frequency": frequency, "period": period,
                "status": "error", "error": str(error)}


def rest_day(task):
    series, day, *ranges = task
    start = int(datetime.combine(day, datetime.min.time(), timezone.utc).timestamp())*1000
    end = start+86_400_000
    endpoint = f"https://fapi.binance.com/fapi/v1/{series}"
    params = f"?symbol=BTCUSDT&startTime={start}&endTime={end-1}"
    if series == "fundingRate":
        points = json.loads(fetch(endpoint+params+"&limit=1000"))
        if not isinstance(points, list) or not points or any(
                not start <= point["fundingTime"] < end for point in points):
            raise ValueError(f"REST funding data unavailable on {day}")
        rows = [["fundingTime", "fundingRate", "markPrice"]]
        rows.extend([point["fundingTime"], point["fundingRate"], point["markPrice"]] for point in points)
    else:
        rows = []
        for offset, limit in ((0, 1000), (1000, 440)):
            query = f"?symbol=BTCUSDT&interval=1m&startTime={start+offset*60_000}&endTime={end-1}&limit={limit}"
            batch = json.loads(fetch(endpoint+query))
            if not isinstance(batch, list):
                raise ValueError(f"REST kline data unavailable on {day}")
            rows.extend(batch)
        if len(rows) != 1440 or any(row[0] != start+i*60_000 or row[6] != row[0]+59_999
                                    for i, row in enumerate(rows)):
            raise ValueError(f"REST data is missing closed bars on {day}")
    if ranges:
        rows = [row for row in rows if any(first <= row[0] < last for first, last in ranges[0])]
    relative = relative_path(series, "rest", str(day))
    output = ROOT / "binance-usdm" / relative
    output.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.StringIO(newline="")
    csv.writer(buffer, lineterminator="\n").writerows(rows)
    tmp = output.with_suffix(".tmp")
    with ZipFile(tmp, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr(output.stem+".csv", buffer.getvalue())
    tmp.replace(output)
    payload = output.read_bytes()
    return {"series": series, "frequency": "rest", "period": str(day), "path": relative,
            "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
            "status": "verified", "source": endpoint, "integrity": "local SHA-256 after REST validation"}


def mark_gap_tasks(audit):
    ranges = {}
    for gap in audit["mark_1m"]["gaps"]:
        start, end = gap["expected"], gap.get("observed", gap.get("end"))
        while start < end:
            day = datetime.fromtimestamp(start/1000, timezone.utc).date()
            boundary = min(end, int(datetime.combine(day+timedelta(days=1), datetime.min.time(), timezone.utc).timestamp())*1000)
            ranges.setdefault(day, []).append((start, boundary))
            start = boundary
    return [("markPriceKlines", day, missing) for day, missing in sorted(ranges.items())]


def rest_result(task):
    try:
        return rest_day(task)
    except (OSError, ValueError, KeyError) as error:
        return {"series": task[0], "frequency": "rest", "period": str(task[1]),
                "status": "error", "error": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--through", type=date.fromisoformat, required=True)
    parser.add_argument("--rest-days", type=date.fromisoformat, nargs="*", default=[])
    parser.add_argument("--rest-funding-days", type=date.fromisoformat, nargs="*", default=[])
    parser.add_argument("--rest-mark-gaps", type=Path)
    args = parser.parse_args()
    tasks = list(chunks(args.through))
    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(download, tasks))
        supplement = [(series, day) for day in args.rest_days for series in SERIES[:2]]
        supplement += [("fundingRate", day) for day in args.rest_funding_days]
        if args.rest_mark_gaps:
            audit = json.loads(args.rest_mark_gaps.read_text(encoding="utf-8"))
            supplement.extend(mark_gap_tasks(audit))
        results.extend(pool.map(rest_result, supplement))
    manifest = {"market": "BINANCE_BTCUSDT_USDT_PERPETUAL", "source": BASE,
                "through": str(args.through), "shards": results}
    temp = ROOT / "manifest.tmp"
    temp.write_text(json.dumps(manifest, indent=2)+"\n", encoding="utf-8")
    temp.replace(ROOT / "manifest.json")
    for series in SERIES:
        subset = [item for item in results if item["series"] == series]
        print(series, {key: sum(item["status"] == key for item in subset)
                       for key in ("verified", "unavailable", "error")})
    print("Bytes:", sum(item.get("bytes", 0) for item in results))


if __name__ == "__main__":
    main()
