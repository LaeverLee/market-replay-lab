"""Audit archive integrity, coverage and every 1m timestamp."""
from collections import defaultdict
import argparse
import csv
import io
from hashlib import sha256
import json
from pathlib import Path
import sys
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
from backend.history import HistoricalArchive, MINUTE


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict-mark", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    archive = HistoricalArchive(ROOT)
    shards = defaultdict(list)
    for entry in manifest["shards"]:
        if entry["status"] != "verified":
            continue
        file = ROOT / "binance-usdm" / entry["path"]
        if sha256(file.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError("SHA-256 mismatch: " + entry["path"])
        shards[entry["series"]].append(entry)
    time_shards = archive.shards()
    lower = time_shards[0][0]
    upper = max(last for _, last, _ in time_shards)
    coverage = archive.coverage()

    def scan(entries):
        count = 0
        gaps = []
        expected = lower
        for timestamp, row in archive.minute_rows(lower, upper, entries):
            if timestamp != expected or int(row[6]) != timestamp+MINUTE-1:
                gaps.append({"expected": expected, "observed": timestamp})
            count += 1
            expected = timestamp+MINUTE
        if expected != upper:
            gaps.append({"expected": expected, "end": upper})
        return {"candles": count, "gaps": gaps}

    funding = []
    for entry in shards["fundingRate"]:
        file = ROOT / "binance-usdm" / entry["path"]
        with ZipFile(file) as z, z.open(z.namelist()[0]) as stream:
            funding.extend(int(row[0]) for row in csv.reader(io.TextIOWrapper(stream, encoding="utf-8-sig"))
                           if row and row[0].isdigit())
    funding.sort()
    if len(set(funding)) != len(funding):
        raise ValueError("Duplicate funding timestamp")
    funding_coverage = {"events": len(funding), "first_ms": funding[0], "last_ms": funding[-1],
                        "largest_spacing_ms": max(b-a for a, b in zip(funding, funding[1:]))}
    report = {"coverage": coverage, "verified_shards": {key: len(value) for key, value in shards.items()},
              "trade_1m": scan(time_shards), "mark_1m": scan(archive.shards("markPriceKlines")), "funding": funding_coverage}
    (ROOT / "coverage-audit.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    if report["trade_1m"]["gaps"] or (args.strict_mark and report["mark_1m"]["gaps"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
