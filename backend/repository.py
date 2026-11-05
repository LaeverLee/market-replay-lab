import json
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock


class StrategyRepository:
    """Local persistence adapter. The service uses list, add_missing and remove."""

    def __init__(self, path):
        self.path = Path(path)
        self.lock = Lock()

    def list(self):
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []

    def _save(self, rules):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = None
        try:
            with NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                    delete=False) as stream:
                temp = Path(stream.name)
                json.dump(rules, stream, ensure_ascii=False, allow_nan=False, indent=2)
            temp.replace(self.path)
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)

    def add_missing(self, items):
        with self.lock:
            rules = {rule["id"]: rule for rule in self.list()}
            for item in items:
                rules.setdefault(item["id"], item)
            result = list(rules.values())
            self._save(result)
            return result

    def remove(self, rule_id):
        with self.lock:
            self._save([rule for rule in self.list() if rule["id"] != rule_id])
