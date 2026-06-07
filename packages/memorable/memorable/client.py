"""Memorable client — main SDK entry point."""

import asyncio
import json
import sqlite3
from typing import Literal

from memorable.config import DB_PATH, KNOWLEDGE_PATH, load_env
from memorable.gnn.graph_builder import WorkflowGraphBuilder
from memorable.gnn.trainer import GNNTrainer
from memorable.memory.cascade import cascade_query, cascade_query_cold
from memorable.memory.semantic import extract_and_index_patterns
from memorable.memory.traces import (
    build_episodic_docs,
    get_recent_traces,
    get_trace_count,
    seed_demo_traces,
    store_trace,
)
from memorable.moss.client import MossSearch
from memorable.moss.setup import seed_knowledge_from_file

load_env()

MemoryMode = Literal["cold", "full"]


class Memorable:
    def __init__(self, moss: MossSearch | None = None) -> None:
        self.moss = moss or MossSearch()
        self.trainer = GNNTrainer()
        self.graph_builder = WorkflowGraphBuilder()

    @classmethod
    def from_env(cls) -> "Memorable":
        load_env()
        return cls()

    async def ensure_loaded(self) -> None:
        await self.moss.ensure_all_loaded()

    async def query(self, user_message: str, mode: MemoryMode = "full") -> dict:
        if mode == "cold":
            return await cascade_query_cold(self.moss, user_message)
        return await cascade_query(self.moss, user_message)

    def record_trace(
        self,
        session_id: str,
        task_type: str,
        steps: list[str],
        outcome: str,
        failure_step: str | None = None,
        duration: float | None = None,
    ) -> None:
        store_trace(session_id, task_type, steps, outcome, failure_step, duration)

    async def init_all(self) -> dict:
        """Setup DB, seed traces, index Moss, train GNN — idempotent."""
        setup_database()
        seed_demo_traces()
        await seed_knowledge_from_file()
        await extract_and_index_patterns(self.moss)
        train_result = self.trainer.train()
        moss_result = await self.trainer.export_to_moss(self.moss)
        return {
            "traces": get_trace_count(),
            "train": train_result,
            "workflows": moss_result,
        }

    def get_status(self) -> dict:
        conn = sqlite3.connect(DB_PATH)
        layers = conn.execute(
            "SELECT layer, status, detail, last_used FROM layer_status"
        ).fetchall()
        metrics = conn.execute("SELECT key, value FROM metrics").fetchall()
        conn.close()
        return {
            "layers": [
                {"layer": l, "status": s, "detail": d, "last_used": u}
                for l, s, d, u in layers
            ],
            "metrics": dict(metrics),
            "trace_count": get_trace_count(),
        }

    def get_graph(self, task_type: str | None = None) -> dict:
        return self.graph_builder.get_graph_for_viz(task_type)

    def get_recent_traces(self, limit: int = 20) -> list[dict]:
        return get_recent_traces(limit)


def setup_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS traces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            task_type TEXT NOT NULL,
            steps TEXT NOT NULL,
            outcome TEXT NOT NULL,
            failure_step TEXT,
            duration_seconds REAL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS workflow_edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_type TEXT NOT NULL,
            from_tool TEXT NOT NULL,
            to_tool TEXT NOT NULL,
            success_count INTEGER DEFAULT 0,
            failure_count INTEGER DEFAULT 0,
            UNIQUE(task_type, from_tool, to_tool)
        );

        CREATE TABLE IF NOT EXISTS layer_status (
            layer TEXT PRIMARY KEY,
            status TEXT DEFAULT 'inactive',
            last_used TIMESTAMP,
            detail TEXT
        );

        CREATE TABLE IF NOT EXISTS metrics (
            key TEXT PRIMARY KEY,
            value REAL DEFAULT 0
        );

        INSERT OR IGNORE INTO layer_status (layer, status, detail) VALUES
            ('episodic', 'inactive', '0 traces'),
            ('semantic', 'inactive', '0 patterns'),
            ('workflow', 'inactive', 'GNN: untrained');

        INSERT OR IGNORE INTO metrics (key, value) VALUES
            ('dead_ends_avoided', 0),
            ('gnn_loss', 0);
    """)
    conn.commit()
    conn.close()


async def run_init() -> None:
    memory = Memorable.from_env()
    result = await memory.init_all()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    asyncio.run(run_init())
