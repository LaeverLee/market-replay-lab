from math import isfinite, inf

FRAMES = dict(zip(("1m", "5m", "15m", "30m", "1h", "4h", "1d"),
                  (60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 86_400_000)))
FLAGS = ("enter_long", "exit_long", "enter_short", "exit_short")
FIELDS = ("open", "high", "low", "close", "volume")


def number(value):
    return type(value) in (int, float) and isfinite(value)


def validate_rows(rows, frame):
    if frame not in FRAMES or not isinstance(rows, list) or not 2 <= len(rows) <= 100_000:
        raise ValueError("回測需要 2–100,000 根支援週期的 K 線。")
    previous = None
    for row in rows:
        if (not isinstance(row, dict) or type(row.get("t")) is not int
                or abs(row["t"]) > 8_640_000_000_000_000
                or not all(number(row.get(key)) for key in FIELDS)
                or row["low"] <= 0 or row["volume"] < 0
                or row["low"] > min(row["open"], row["close"])
                or row["high"] < max(row["open"], row["close"])):
            raise ValueError("無效的 OHLCV 或時間戳。")
        if previous is not None and row["t"] - previous != FRAMES[frame]:
            raise ValueError("K 線時間戳重複、倒序或缺根。")
        previous = row["t"]


def validate_sizing(sizing):
    if not isinstance(sizing, dict) or not all(number(sizing.get(k)) for k in
            ("capital", "fee", "slippage", "allocation")):
        raise ValueError("本金、部位比例、手續費或滑價無效。")
    if (sizing["capital"] < 1 or not 0 <= sizing["fee"] < 5
            or not 0 <= sizing["slippage"] < 5 or not 0 < sizing["allocation"] <= 100
            or not number(sizing.get("leverage", 1)) or sizing.get("leverage", 1) not in (1, 3)):
        raise ValueError("本金、部位比例、手續費、滑價或槓桿超出範圍。")


def indicator(values, definition):
    period = definition["period"]
    kind = definition["type"]
    result = [None] * len(values)
    total = gain = loss = 0.0
    ema = None
    for i, value in enumerate(values):
        if kind == "rsi":
            if i == 0:
                continue
            diff = value - values[i - 1]
            up, down = max(diff, 0), max(-diff, 0)
            if i <= period:
                gain += up / period
                loss += down / period
            else:
                gain = (gain * (period - 1) + up) / period
                loss = (loss * (period - 1) + down) / period
            if i >= period:
                result[i] = 50 if gain + loss == 0 else 100 * gain / (gain + loss)
        elif kind in ("high", "low"):
            if i >= period:
                result[i] = (max if kind == "high" else min)(values[i-period:i])
        else:
            total += value - (values[i-period] if i >= period else 0)
            if i >= period - 1:
                if kind == "ema":
                    ema = total / period if ema is None else ema + 2 / (period + 1) * (value - ema)
                    result[i] = ema
                else:
                    result[i] = total / period
    return result


def rule_signals(rows, strategy):
    series = {key: [row[key] for row in rows] for key in FIELDS}
    for name, definition in strategy.get("indicators", {}).items():
        series[name] = indicator(series[definition.get("source", "close")], definition)

    def read(operand, i):
        return operand if number(operand) else series[operand][i] if i >= 0 else None

    def matches(rule, i):
        left, op, right = rule
        a, b = read(left, i), read(right, i)
        if not number(a) or not number(b):
            return False
        if op == "above":
            return a > b
        if op == "below":
            return a < b
        if op == "gte":
            return a >= b
        if op == "lte":
            return a <= b
        previous_a, previous_b = read(left, i-1), read(right, i-1)
        if not number(previous_a) or not number(previous_b):
            return False
        if op == "crossAbove":
            return a > b and previous_a <= previous_b
        return a < b and previous_a >= previous_b

    for i in range(len(rows)):
        yield {flag: i >= strategy.get("warmup", 0) and bool(strategy.get(flag))
               and all(matches(rule, i) for rule in strategy[flag]) for flag in FLAGS}


class Account:
    def __init__(self, sizing):
        validate_sizing(sizing)
        capital = sizing["capital"]
        self.state = dict(capital=capital, cash=capital, fee=sizing["fee"]/100,
                          slip=sizing["slippage"]/100, allocation=sizing["allocation"]/100,
                          leverage=sizing.get("leverage", 1), pos=None, orders=[], curve=[],
                          equity=capital, peak=capital, drawdown=0, lastClose=None,
                          lastOpen=None, pending=None)

    def exhaust_margin(self, timestamp, adverse_price):
        a = self.state
        pos = a["pos"]
        if a["leverage"] == 1 or pos is None:
            return False
        side, qty = pos["side"], pos["qty"]
        price = (side*pos["price"] - pos["margin"]/qty) / (side-a["fee"])
        if side*(adverse_price-price) > 0:
            return False
        a["cash"] = max(0, a["cash"]-pos["margin"])
        a["orders"].append(dict(action="exit", signal=timestamp, t=timestamp, side=side,
                                price=price, qty=qty, fee=price*qty*a["fee"],
                                pnl=-pos["margin"]-pos["fee"], reason="模擬保證金耗盡"))
        a["pos"] = a["pending"] = None
        return True

    def on_open(self, row):
        a = self.state
        t = row["t"]
        if a["lastOpen"] is not None and t <= a["lastOpen"]:
            return
        a["lastOpen"] = t
        if self.exhaust_margin(t, row["open"]):
            return
        order = a["pending"]
        a["pending"] = None
        if order is None:
            return
        pos = a["pos"]
        if order["action"] == "exit" and pos:
            side, qty = pos["side"], pos["qty"]
            price = row["open"]*(1-side*a["slip"])
            pnl, fee = side*(price-pos["price"])*qty, price*qty*a["fee"]
            a["cash"] += pnl-fee
            a["orders"].append(dict(order, t=t, side=side, price=price, qty=qty, fee=fee,
                                    pnl=pnl-fee-pos["fee"]))
            a["pos"] = None
        elif order["action"] == "entry" and not pos and a["cash"] > 0:
            side = order["side"]
            price = row["open"]*(1+side*a["slip"])
            notional = a["cash"]*a["allocation"]*a["leverage"]/(1+a["fee"]*a["leverage"])
            qty, fee = notional/price, notional*a["fee"]
            a["cash"] -= fee
            a["pos"] = dict(side=side, price=price, qty=qty, fee=fee,
                            margin=notional/a["leverage"], t=t)
            a["orders"].append(dict(order, t=t, price=price, qty=qty, fee=fee, pnl=None))

    def on_close(self, row, flags, strategy):
        a = self.state
        t = row["t"]
        if a["lastClose"] is not None and t <= a["lastClose"]:
            return
        a["lastClose"] = t
        exhausted = self.exhaust_margin(t, row["low"] if (a["pos"] or {}).get("side") == 1 else row["high"])
        pos = a["pos"]
        a["equity"] = a["cash"] + (pos["side"]*(row["close"]-pos["price"])*pos["qty"] if pos else 0)
        a["peak"] = max(a["peak"], a["equity"])
        a["drawdown"] = max(a["drawdown"], (a["peak"]-a["equity"])/a["peak"])
        a["curve"].append(dict(t=t, value=a["equity"]))
        if pos:
            move = pos["side"]*(row["close"]/pos["price"]-1)*100
            if move <= -strategy.get("stopPct", inf):
                reason = "收盤停損"
            elif move >= strategy.get("takePct", inf):
                reason = "收盤停利"
            elif flags.get("exit_long" if pos["side"] == 1 else "exit_short"):
                reason = "策略出場"
            else:
                return
            a["pending"] = dict(action="exit", signal=t, reason=reason)
        elif not exhausted and bool(flags.get("enter_long")) != bool(flags.get("enter_short")):
            a["pending"] = dict(action="entry", side=1 if flags.get("enter_long") else -1,
                                signal=t, reason="策略進場")


def replay(rows, strategy, sizing, start=-inf, end=inf, *, signals=None):
    """Run a rule or a supplied signal stream against already validated candles."""
    account = Account(sizing)
    flags = rule_signals(rows, strategy) if signals is None else signals
    for row, values in zip(rows, flags, strict=True):
        if start <= row["t"] < end:
            account.on_open(row)
            account.on_close(row, values, strategy)
    return account.state
