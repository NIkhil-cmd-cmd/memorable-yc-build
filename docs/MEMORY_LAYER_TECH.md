# Memorable Memory Layer: Technical Design

This doc explains how the memory system in this repo is designed and how it changes agent behavior at runtime.

## 1) Design goals

- Convert every run into reusable memory.
- Prevent repeat dead ends by reusing successful tool paths.
- Keep memory layered so retrieval can degrade gracefully.
- Work in LiveKit voice sessions without changing core agent UX.

## 2) Core architecture

Memorable is implemented as a Python memory SDK (`packages/memorable`) plus a LiveKit runtime hook (`memorable.livekit.attach`).

Primary runtime flow:

1. Agent receives user message in LiveKit.
2. Memory query runs (`Memorable.query`).
3. Retrieved context + constraints are injected into the turn.
4. Agent executes tools.
5. Trace is recorded (`record_trace`) and fed back into memory.

## 3) Three memory layers

Memorable uses three logical layers:

- Episodic: raw session traces with provenance.
- Semantic: extracted cross-trace patterns.
- Workflow: distilled playbooks from workflow-graph training.

In Moss, these are stored as:

- Physical index `memory` for episodic + semantic docs (with `metadata.layer`).
- Physical index `workflows` for workflow playbooks.
- Physical index `knowledge` for static domain docs.

## 4) Storage model and trace ingestion

SQLite tables (created in `memorable/client.py`) are the local source of truth:

- `traces`: session-level records (`session_id`, `task_type`, `steps`, `outcome`, duration, etc.).
- `workflow_edges`: transition counts between tools (`from_tool`, `to_tool`, success/failure counts).
- `layer_status` / `metrics`: health and training stats.

When `store_trace(...)` runs:

- The full step sequence is persisted.
- Edge transitions are incrementally aggregated in `workflow_edges`.
- Layer status for episodic memory is updated.

## 5) Retrieval cascade (runtime decision policy)

`memorable/memory/cascade.py` drives selection:

- In full memory mode:
  - Query workflow layer first.
  - If weak/no workflow hit, fall back to semantic + episodic.
  - Include relevant knowledge hits.
  - Extract avoid-list constraints from workflow hits when present.
- In cold mode:
  - Query only knowledge docs (no workflow/semantic/episodic guidance).

This gives a clean behavioral split for benchmark comparisons.

## 6) Workflow learning (graph + GNN)

Workflow memory is trained from aggregated `workflow_edges`:

- `gnn/graph_builder.py` converts edge data into graph tensors.
- `gnn/trainer.py` trains `WorkflowGNN` and exports ranked workflow docs.
- Exported docs are indexed into Moss `workflows`.

At runtime, these workflow docs are used as high-priority guidance.

## 7) LiveKit integration

`memorable.livekit.MemoryHook` is attached to the voice agent:

- Pre-turn: injects memory context and constraints.
- Post-turn: records executed tool traces.
- The hook supports modes (`cold`, `full`) so both baselines can run in the same app.

Worker integration in this repo (`worker/agent.py`) also emits trace events for UI playback and benchmarking.

## 8) Why this improves outcomes

Without memory, agents explore tool branches repeatedly.

With memory:

- Successful paths are replayed earlier.
- Known bad transitions are suppressed via constraints.
- Fewer retries/dead ends reduce total steps, token usage, and completion time.

## 9) Key files

- `packages/memorable/memorable/client.py`
- `packages/memorable/memorable/memory/cascade.py`
- `packages/memorable/memorable/memory/traces.py`
- `packages/memorable/memorable/gnn/graph_builder.py`
- `packages/memorable/memorable/gnn/trainer.py`
- `packages/memorable/memorable/livekit/__init__.py`
- `packages/memorable/memorable/moss/client.py`
- `worker/agent.py`
