from __future__ import annotations

import json
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[3]
FIXTURE = REPOSITORY / "artifacts" / "cloudproof" / "datasets" / "transitions-seed-1337.jsonl"


def fixture_record() -> dict:
    with FIXTURE.open("r", encoding="utf-8") as handle:
        return json.loads(next(line for line in handle if line.strip()))
