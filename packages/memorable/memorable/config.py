"""Paths and env loading for the memorable package."""

import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent.parent.parent
DATA_DIR = ROOT_DIR / "data"
DB_PATH = ROOT_DIR / "data" / "memorable.db"
KNOWLEDGE_PATH = DATA_DIR / "knowledge_base.json"
GNN_MODEL_PATH = DATA_DIR / "gnn_model.pt"


def load_env() -> None:
    from dotenv import load_dotenv

    for path in (ROOT_DIR / ".env.local", ROOT_DIR / "agent-py" / ".env.local"):
        if path.exists():
            load_dotenv(path)
            break
