"""Train WorkflowGNN, persist weights, export to Moss workflows index."""

import sqlite3

import torch
import torch.nn as nn

from memorable.config import DB_PATH, GNN_MODEL_PATH
from memorable.gnn.graph_builder import WorkflowGraphBuilder
from memorable.gnn.model import WorkflowGNN
from memorable.moss.client import MossSearch


class GNNTrainer:
    def __init__(self) -> None:
        self.graph_builder = WorkflowGraphBuilder()
        self.model: WorkflowGNN | None = None
        self.final_loss: float = 0.0
        self._load_persisted()

    def _load_persisted(self) -> None:
        if not GNN_MODEL_PATH.exists():
            return
        try:
            checkpoint = torch.load(GNN_MODEL_PATH, weights_only=False)
            self.graph_builder.tool_to_id = checkpoint["tool_to_id"]
            self.graph_builder.task_to_id = checkpoint["task_to_id"]
            self.model = WorkflowGNN(
                n_tools=self.graph_builder.n_tools,
                n_tasks=self.graph_builder.n_tasks,
            )
            self.model.load_state_dict(checkpoint["state_dict"])
            self.model.eval()
            self.final_loss = checkpoint.get("final_loss", 0.0)
        except Exception:
            self.model = None

    def _save(self) -> None:
        if self.model is None:
            return
        GNN_MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
        torch.save(
            {
                "state_dict": self.model.state_dict(),
                "tool_to_id": self.graph_builder.tool_to_id,
                "task_to_id": self.graph_builder.task_to_id,
                "final_loss": self.final_loss,
            },
            GNN_MODEL_PATH,
        )

    def _get_all_task_types(self) -> list[str]:
        conn = sqlite3.connect(DB_PATH)
        tasks = [
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT task_type FROM workflow_edges"
            ).fetchall()
        ]
        conn.close()
        return tasks

    def train(self, epochs: int = 100) -> dict:
        tasks = self._get_all_task_types()
        if not tasks:
            return {"status": "no_data"}

        training_data = []
        for task in tasks:
            graph, task_id = self.graph_builder.build_graph(task)
            if graph.edge_index.size(1) == 0:
                continue
            n_nodes = graph.tool_ids.size(0)
            target = torch.zeros(n_nodes)
            for i in range(n_nodes):
                out_mask = graph.edge_index[0] == i
                if out_mask.any():
                    target[i] = graph.edge_weight[out_mask].mean()
                else:
                    in_mask = graph.edge_index[1] == i
                    if in_mask.any():
                        target[i] = graph.edge_weight[in_mask].mean()
            training_data.append((graph, task_id, target))

        if not training_data:
            return {"status": "no_data"}

        self.model = WorkflowGNN(
            n_tools=self.graph_builder.n_tools,
            n_tasks=self.graph_builder.n_tasks,
        )
        optimizer = torch.optim.Adam(self.model.parameters(), lr=0.01)
        loss_fn = nn.MSELoss()

        self.model.train()
        final_loss = 0.0
        for _ in range(epochs):
            total_loss = 0.0
            for graph, task_id, target in training_data:
                scores = self.model(
                    graph.tool_ids,
                    graph.edge_index,
                    graph.edge_weight,
                    torch.tensor(task_id),
                )
                loss = loss_fn(scores, target)
                optimizer.zero_grad()
                loss.backward()
                optimizer.step()
                total_loss += loss.item()
            final_loss = total_loss / len(training_data)

        self.final_loss = final_loss
        self._save()

        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            "UPDATE layer_status SET status = 'active', detail = ?, "
            "last_used = CURRENT_TIMESTAMP WHERE layer = 'workflow'",
            (f"GNN trained, loss: {final_loss:.4f}",),
        )
        conn.execute(
            "INSERT INTO metrics (key, value) VALUES ('gnn_loss', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (final_loss,),
        )
        conn.commit()
        conn.close()

        return {
            "status": "trained",
            "epochs": epochs,
            "final_loss": final_loss,
            "n_tasks": len(training_data),
            "n_tools": self.graph_builder.n_tools,
        }

    def get_recommendations(self) -> list[dict]:
        if self.model is None:
            return []
        self.model.eval()
        recs = []
        for task_type in self._get_all_task_types():
            graph, task_id = self.graph_builder.build_graph(task_type)
            if graph.edge_index.size(1) == 0:
                continue
            with torch.no_grad():
                scores = self.model(
                    graph.tool_ids,
                    graph.edge_index,
                    graph.edge_weight,
                    torch.tensor(task_id),
                )
            scored = []
            for tool_id, score in zip(graph.tool_ids.tolist(), scores.tolist()):
                name = self.graph_builder.get_tool_name(tool_id)
                if name and name != "__start__":
                    scored.append({"tool": name, "score": score})
            scored.sort(key=lambda x: -x["score"])
            recs.append(
                {
                    "task": task_type,
                    "recommended": [t for t in scored if t["score"] > 0.5],
                    "avoid": [t for t in scored if t["score"] < 0.3],
                }
            )
        return recs

    async def export_to_moss(self, moss: MossSearch) -> dict:
        recs = self.get_recommendations()
        if not recs:
            return {"status": "no_recommendations"}

        docs = []
        for rec in recs:
            task = rec["task"].replace("_", " ")
            compact = self.graph_builder.compact_export(rec["task"], recs)
            if rec["recommended"]:
                tool_list = ", ".join(
                    f"{t['tool'].replace('_', ' ')} ({t['score']:.0%})"
                    for t in rec["recommended"]
                )
                docs.append(
                    {
                        "id": f"wf-rec-{rec['task']}",
                        "text": (
                            f"RECOMMENDED for {task}: {tool_list}. "
                            f"Playbook: {compact}. GNN-distilled from historical runs."
                        ),
                    }
                )
            if rec["avoid"]:
                avoid_list = ", ".join(
                    f"{t['tool'].replace('_', ' ')} ({t['score']:.0%})"
                    for t in rec["avoid"]
                )
                docs.append(
                    {
                        "id": f"wf-avoid-{rec['task']}",
                        "text": (
                            f"AVOID for {task}: {avoid_list}. "
                            "These steps failed frequently in past runs."
                        ),
                    }
                )

        await moss.index_documents("workflows", docs)
        return {"status": "indexed", "documents": len(docs)}
