from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from math import inf
from zipfile import BadZipFile
import re
from replay_engine import FLAGS, FRAMES, replay, validate_rows, validate_sizing
from replay_engine.replay import FIELDS, number
from .history import millis

RULE_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)
COLOR = re.compile(r"#[0-9a-f]{6}", re.I)
OPERATORS = ("above", "below", "gte", "lte", "crossAbove", "crossBelow")


def validate_rule(item):
    required = ("id", "color", "name")
    allowed = {*required, "version", "side", "interval", "intervals", "warmup",
               "indicators", "stopPct", "takePct", *FLAGS}
    if (not isinstance(item, dict) or not all(isinstance(item.get(k), str) for k in required)
            or not RULE_ID.fullmatch(item["id"]) or not COLOR.fullmatch(item["color"])
            or not 1 <= len(item["name"].strip()) <= 80 or type(item.get("version")) is not int
            or item["version"] != 1 or item.get("side") not in ("long", "both")
            or set(item) - allowed):
        raise ValueError("策略名稱、格式、識別碼或顏色無效。")
    interval, intervals = item.get("interval"), item.get("intervals")
    if ("interval" in item and (not isinstance(interval, str) or interval not in FRAMES)
            or "intervals" in item and (not isinstance(intervals, list) or not intervals
                or any(not isinstance(x, str) or x not in FRAMES for x in intervals)
                or len(set(intervals)) != len(intervals) or (interval and interval not in intervals))):
        raise ValueError("策略週期無效。")
    warmup, indicators = item.get("warmup", 0), item.get("indicators", {})
    if type(warmup) is not int or not 0 <= warmup <= 500 or not isinstance(indicators, dict) or len(indicators) > 20:
        raise ValueError("策略暖機或指標設定無效。")
    for key, spec in indicators.items():
        if (not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,30}", key) or key in FIELDS
                or not isinstance(spec, dict) or spec.get("type") not in ("sma", "ema", "rsi", "high", "low")
                or spec.get("source", "close") not in FIELDS
                or type(spec.get("period")) is not int or not 2 <= spec["period"] <= 500):
            raise ValueError("指標設定無效。")
    operands = set(FIELDS) | indicators.keys()

    def operand(value):
        return number(value) or isinstance(value, str) and value in operands

    for flag in FLAGS:
        rules = item.get(flag, [])
        if (not isinstance(rules, list) or len(rules) > 16 or
                any(not isinstance(rule, list) or len(rule) != 3 or rule[1] not in OPERATORS
                    or not operand(rule[0]) or not operand(rule[2]) for rule in rules)
                or item["side"] == "long" and flag.endswith("short") and rules):
            raise ValueError("策略訊號條件無效。")
    if not item.get("enter_long") and not item.get("enter_short"):
        raise ValueError("請設定至少一個進場條件。")
    if any(key in item and (not number(item[key]) or not 0 < item[key] < 100)
           for key in ("stopPct", "takePct")):
        raise ValueError("停損或停利比例無效。")
    return dict(item, name=item["name"].strip())


class ReplayService:
    def __init__(self, repository, native_catalog, history, *, parallel_batch=True):
        self.repository = repository
        self.native_catalog = native_catalog
        self.history = history
        self.batch_workers = ThreadPoolExecutor(max_workers=2, thread_name_prefix="archive") if parallel_batch else None

    def archive_backtest(self, data):
        if not isinstance(data, dict):
            raise ValueError("回測設定無效。")
        frame, native_id = data.get("frame"), data.get("id")
        rows, start, end = self.history.read(frame, data.get("from"), data.get("to"),
                                             warmup=0 if native_id else 1000)
        period = [row for row in rows if row["t"] >= start]
        if native_id:
            return {"rows": period, "report": self.native_catalog.replay(native_id, period, frame)}
        sizing = data.get("sizing")
        if not isinstance(sizing, dict):
            raise ValueError("回測帳戶設定無效。")
        payload = dict(data, rows=rows, sizing={**sizing, "leverage": 3}, signalStrategies=[])
        payload.update({"from": start, "to": end})
        return {"rows": period, "accounts": self.backtest(payload)}

    def archive_batch(self, data):
        if not isinstance(data, dict) or not isinstance(data.get("strategies"), list):
            raise ValueError("請提供批次策略清單。")
        selection = data["strategies"]
        if not 1 <= len(selection) <= 1000:
            raise ValueError("批次需有 1–1,000 個策略。")
        rules = {rule["id"]: rule for rule in self.repository.list()}
        natives = {rule["id"]: rule for rule in self.native_catalog.list()}
        groups = {}
        seen = set()
        for item in selection:
            if not isinstance(item, dict) or not all(isinstance(item.get(k), str) for k in ("id", "frame")):
                raise ValueError("策略識別碼或週期無效。")
            key, frame = item["id"], item["frame"]
            rule = rules.get(key) or natives.get(key)
            if not rule or key in seen:
                raise ValueError("批次策略重複或已移除。")
            allowed = rule.get("intervals") or ([rule["interval"]] if rule.get("interval") else FRAMES)
            if frame not in allowed:
                raise ValueError("所選週期與策略契約不相容。")
            seen.add(key)
            groups.setdefault(frame, []).append((rule, key in natives))

        sizing = data.get("sizing")
        if any(not native for items in groups.values() for _, native in items):
            if not isinstance(sizing, dict):
                raise ValueError("回測帳戶設定無效。")
            sizing = {**sizing, "leverage": 3}
            validate_sizing(sizing)
        start, end = data.get("from"), data.get("to")
        if any(value is not None and type(value) is not int for value in (start, end)):
            raise ValueError("回測區間無效。")
        # Use the same UTC calendar window for every group, including the default run.
        coverage = self.history.coverage()
        if not coverage["available"]:
            raise ValueError("本機尚未下載歷史資料。")
        if end is None:
            end = millis(date.fromisoformat(coverage["through"]) + timedelta(days=1))
        if start is None:
            days = max(2, min(30, 1000*min(FRAMES[frame] for frame in groups)//86_400_000))
            start = max(millis(date.fromisoformat(coverage["start"])), end-days*86_400_000)

        def run_group(frame, items):
            descriptors = [{"id": rule["id"], "name": rule["name"], "frame": frame}
                           for rule, _ in items]
            try:
                warmup = 1000 if any(not native for _, native in items) else 0
                rows, first, last = self.history.read(frame, start, end, warmup=warmup)
                period = [row for row in rows if row["t"] >= first]
            except ValueError as error:
                return frame, [], [dict(item, error=str(error)) for item in descriptors]
            except (OSError, BadZipFile):
                return frame, [], [dict(item, error="此週期的本機行情檔無法讀取。") for item in descriptors]
            results = []
            for (rule, native), item in zip(items, descriptors, strict=True):
                try:
                    if native:
                        item["report"] = self.native_catalog.replay(rule["id"], period, frame)
                    else:
                        item.update(color=rule["color"], account=replay(rows, rule, sizing, first, last))
                except (ValueError, ArithmeticError) as error:
                    item["error"] = str(error)
                except OSError:
                    item["error"] = "本機策略或回測輸出無法讀取。"
                results.append(item)
            return frame, period, results

        if self.batch_workers is None:
            completed = (run_group(frame, items) for frame, items in groups.items())
        else:
            tasks = [self.batch_workers.submit(run_group, frame, items) for frame, items in groups.items()]
            completed = (task.result() for task in tasks)
        results, charts = {}, {}
        for frame, rows, items in completed:
            if rows:
                charts[frame] = rows
            results.update((item["id"], item) for item in items)
        return {"results": [results[item["id"]] for item in selection], "charts": charts,
                "from": start, "to": end}

    def save_rules(self, items):
        if not isinstance(items, list) or len(items) > 1000:
            raise ValueError("策略清單格式無效。")
        return self.repository.add_missing([validate_rule(item) for item in items])

    def backtest(self, data):
        frame, rows = data.get("frame"), data.get("rows")
        validate_rows(rows, frame)
        start, end = data.get("from"), data.get("to")
        if any(value is not None and type(value) is not int for value in (start, end)):
            raise ValueError("回測區間無效。")
        start, end = -inf if start is None else start, inf if end is None else end
        if sum(start <= row["t"] < end for row in rows) < 2:
            raise ValueError("所選區間至少需有兩根已收盤 K 線。")
        sizing = data.get("sizing")
        validate_sizing(sizing)
        rule_ids, snapshots = data.get("strategyIds"), data.get("signalStrategies")
        if not isinstance(rule_ids, list) or not isinstance(snapshots, list) or not 1 <= len(rule_ids)+len(snapshots) <= 1000:
            raise ValueError("請提供適用的策略。")
        stored = {item["id"]: item for item in self.repository.list()}
        jobs = []
        for key in rule_ids:
            rule = stored.get(key) if isinstance(key, str) else None
            if not rule or frame not in (rule.get("intervals") or ([rule["interval"]] if rule.get("interval") else FRAMES)):
                raise ValueError("策略已移除或不支援本次週期。")
            jobs.append((rule, None))
        for item in snapshots:
            if (not isinstance(item, dict) or not all(isinstance(item.get(k), str) for k in ("id", "name", "color"))
                    or not COLOR.fullmatch(item["color"])):
                raise ValueError("訊號策略資料無效。")
            signals = item.get("signals")
            if (not isinstance(signals, list) or len(signals) != len(rows)
                    or any(not isinstance(signal, dict) or any(type(signal.get(flag)) is not bool for flag in FLAGS)
                           for signal in signals)):
                raise ValueError("訊號 CSV 必須與回測 K 線一一對應。")
            jobs.append((item, signals))
        return [{**{key: rule[key] for key in ("id", "name", "color")},
                 "account": replay(rows, rule if signals is None else {}, sizing, start, end, signals=signals)}
                for rule, signals in jobs]
