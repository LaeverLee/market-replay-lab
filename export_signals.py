"""Export historical signals from a trusted local Python strategy."""
import argparse
import importlib.util
import sys
from pathlib import Path

import pandas as pd

CANDLES = ["timestamp", "open", "high", "low", "close", "volume"]
FLAGS = ["enter_long", "exit_long", "enter_short", "exit_short"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strategy", required=True, type=Path)
    parser.add_argument("--candles", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    path = args.strategy.resolve()
    if args.output.resolve() in {path, args.candles.resolve()}:
        parser.error("--output must be different from both input paths")
    data = pd.read_csv(args.candles)
    if missing := set(CANDLES) - set(data.columns):
        parser.error("Missing candle columns: " + ", ".join(sorted(missing)))
    data["timestamp"] = pd.to_datetime(data["timestamp"], utc=True, errors="raise")
    spec = importlib.util.spec_from_file_location("market_replay_local_strategy", path)
    if spec is None or spec.loader is None:
        parser.error("--strategy must point to a Python module")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(path.parent))
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    if not callable(getattr(module, "generate_signals", None)):
        parser.error("The module must define generate_signals(candles)")
    output = module.generate_signals(data.copy(deep=True))
    if not isinstance(output, pd.DataFrame) or any(flag not in output for flag in FLAGS):
        parser.error("Expected a DataFrame with all four trade flags")
    if not output.index.equals(data.index) or not output["timestamp"].equals(data["timestamp"]):
        parser.error("Signal rows must match the candle timestamps and order")
    for flag in FLAGS:
        if output[flag].isna().any() or not pd.api.types.is_bool_dtype(output[flag]):
            parser.error(flag + " must contain non-null boolean values")
    columns = CANDLES + (["is_closed"] if "is_closed" in data else [])
    data[columns].join(output[FLAGS]).to_csv(args.output, index=False)
    print(f"Exported {len(data)} candles to {args.output}")


if __name__ == "__main__":
    main()

