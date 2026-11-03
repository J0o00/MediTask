"""Shared configuration loaded from ml/config/*.json (exported from the JS app)."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

ML_ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = ML_ROOT / "config"
DATA_DIR = ML_ROOT / "data"
REPORTS_DIR = ML_ROOT / "reports"
MODELS_DIR = ML_ROOT / "models"
WEB_MODEL_DIR = ML_ROOT.parent / "models" / "web"

QUALITY_LABELS = ["correct", "incorrect", "incomplete"]


@lru_cache
def app_config() -> dict:
    """Exercise configs + rep thresholds exported by `npm run export-configs`."""
    return json.loads((CONFIG_DIR / "exercises.json").read_text())


@lru_cache
def taxonomy() -> dict:
    return json.loads((CONFIG_DIR / "label_taxonomy.json").read_text())


def exercise_config(exercise_id: str) -> dict | None:
    return app_config()["exercises"].get(exercise_id)


def primary_metric_for(exercise_id: str) -> str | None:
    cfg = exercise_config(exercise_id)
    if cfg:
        return cfg["primaryMetric"]
    return taxonomy()["classes"].get(exercise_id, {}).get("primary_metric")
