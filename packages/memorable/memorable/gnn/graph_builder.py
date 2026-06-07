"""Converts workflow edge data from SQLite into PyTorch Geometric Data objects."""

import sqlite3
from typing import Optional

import torch
from torch_geometric.data import Data

from memorable.config import DB_PATH


class WorkflowGraphBuilder:
    def __init__(self) -> None:
        self.tool_to_id: dict[str, int] = {}
        self.task_to_id: dict[str, int] = {}

    def _get_tool_id(self, tool: str) -> int:
        if tool not in self.tool_to_id:
            self.tool_to_id[tool] = len(self.tool_to_id)
        return self.tool_to_id[tool]

    def _get_task_id(self, task: str) -> int:
        if task not in self.task_to_id:
            self.task_to_id[task] = len(self.task_to_id)
        return self.task_to_id[task]

    @property
    def n_tools(self) -> int:
        return max(len(self.tool_to_id), 1)

    @property
    def n_tasks(self) -> int:
        return max(len(self.task_to_id), 1)

    def get_tool_name(self, tool_id: int) -> Optional[str]:
        return next(
            (name for name, tid in self.tool_to_id.items() if tid == tool_id), None
        )

    def build_graph(self, task_type: str) -> tuple[Data, int]:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            "SELECT from_tool, to_tool, success_count, failure_count "
            "FROM workflow_edges WHERE task_type = ?",
            (task_type,),
        ).fetchall()
        conn.close()

        task_id = self._get_task_id(task_type)

        if not rows:
            return (
                Data(
                    tool_ids=torch.tensor(
                        [self._get_tool_id("__start__")], dtype=torch.long
                    ),
                    edge_index=torch.zeros(2, 0, dtype=torch.long),
                    edge_weight=torch.zeros(0, dtype=torch.float),
                ),
                task_id,
            )

        tools_in_graph: set[str] = set()
        for f, t, _, _ in rows:
            tools_in_graph.add(f)
            tools_in_graph.add(t)

        tool_list = sorted(tools_in_graph)
        local_idx = {t: i for i, t in enumerate(tool_list)}
        tool_ids = [self._get_tool_id(t) for t in tool_list]

        sources, targets, weights = [], [], []
        for f, t, success, failure in rows:
            sources.append(local_idx[f])
            targets.append(local_idx[t])
            total = success + failure
            weights.append(success / total if total > 0 else 0.5)

        return (
            Data(
                tool_ids=torch.tensor(tool_ids, dtype=torch.long),
                edge_index=torch.tensor([sources, targets], dtype=torch.long),
                edge_weight=torch.tensor(weights, dtype=torch.float),
            ),
            task_id,
        )

    def get_graph_for_viz(self, task_type: Optional[str] = None) -> dict:
        conn = sqlite3.connect(DB_PATH)
        if task_type:
            rows = conn.execute(
                "SELECT from_tool, to_tool, success_count, failure_count "
                "FROM workflow_edges WHERE task_type = ?",
                (task_type,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT from_tool, to_tool, success_count, failure_count "
                "FROM workflow_edges"
            ).fetchall()
        conn.close()

        nodes_set: set[str] = set()
        edges = []
        for f, t, success, failure in rows:
            nodes_set.add(f)
            nodes_set.add(t)
            total = success + failure
            rate = success / total if total > 0 else 0.5
            edges.append(
                {
                    "id": f"{f}->{t}",
                    "source": f,
                    "target": t,
                    "success": success,
                    "failure": failure,
                    "rate": rate,
                }
            )

        nodes = [{"id": tool, "label": tool.replace("_", " ")} for tool in sorted(nodes_set)]
        return {"nodes": nodes, "edges": edges}

    def compact_export(self, task_type: str, recs: list[dict]) -> str:
        """Compact playbook string for Moss indexing."""
        rec = next((r for r in recs if r["task"] == task_type), None)
        if not rec:
            return ""
        recommended = ">".join(t["tool"] for t in rec.get("recommended", [])[:4])
        avoid = ",".join(t["tool"] for t in rec.get("avoid", []))
        parts = [f"{task_type}: {recommended}"]
        if avoid:
            parts.append(f"avoid:{avoid}")
        return " | ".join(parts)
