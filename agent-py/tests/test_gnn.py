"""Tests for GNN training and graph building."""

import sqlite3
from pathlib import Path

import pytest

from gnn.graph_builder import WorkflowGraphBuilder
from gnn.trainer import GNNTrainer
from memory.traces import store_trace

AGENT_DIR = Path(__file__).resolve().parent.parent
DB_PATH = AGENT_DIR / "memorable.db"


@pytest.fixture
def clean_db(tmp_path, monkeypatch):
    db = tmp_path / "test.db"
    conn = sqlite3.connect(db)
    conn.executescript("""
        CREATE TABLE traces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            task_type TEXT NOT NULL,
            steps TEXT NOT NULL,
            outcome TEXT NOT NULL,
            failure_step TEXT,
            duration_seconds REAL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE workflow_edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_type TEXT NOT NULL,
            from_tool TEXT NOT NULL,
            to_tool TEXT NOT NULL,
            success_count INTEGER DEFAULT 0,
            failure_count INTEGER DEFAULT 0,
            UNIQUE(task_type, from_tool, to_tool)
        );
        CREATE TABLE layer_status (
            layer TEXT PRIMARY KEY,
            status TEXT DEFAULT 'inactive',
            last_used TIMESTAMP,
            detail TEXT
        );
        CREATE TABLE metrics (
            key TEXT PRIMARY KEY,
            value REAL DEFAULT 0
        );
        INSERT INTO layer_status (layer, status, detail) VALUES
            ('episodic', 'inactive', '0 traces'),
            ('semantic', 'inactive', '0 patterns'),
            ('workflow', 'inactive', 'GNN: untrained');
        INSERT INTO metrics (key, value) VALUES ('gnn_loss', 0), ('dead_ends_avoided', 0);
    """)
    conn.commit()
    conn.close()

    import gnn.graph_builder as gb_mod
    import gnn.trainer as trainer_mod
    import memory.traces as traces_mod

    monkeypatch.setattr(traces_mod, "DB_PATH", db)
    monkeypatch.setattr(gb_mod, "DB_PATH", db)
    monkeypatch.setattr(trainer_mod, "DB_PATH", db)
    return db


def test_graph_builder_edge_index_shape(clean_db):
    store_trace("s1", "internet_dropout", ["a", "b", "c"], "success", duration=30.0)
    builder = WorkflowGraphBuilder()
    graph, _ = builder.build_graph("internet_dropout")
    assert graph.edge_index.dim() == 2
    assert graph.edge_index.size(0) == 2


def test_gnn_trains_on_traces(clean_db):
    for i in range(5):
        store_trace(
            f"s{i}",
            "internet_dropout",
            ["check_outage_map", "reboot_modem"],
            "success",
            duration=40.0,
        )
    trainer = GNNTrainer()
    result = trainer.train(epochs=20)
    assert result["status"] == "trained"
    assert result["final_loss"] >= 0
