"""3-Layer Memory Cascade with cold/full modes."""

import asyncio
import re
import sqlite3
import time

from memorable.config import DB_PATH
from memorable.moss.client import MossSearch

WORKFLOW_THRESHOLD = 0.5
SEMANTIC_THRESHOLD = 0.35
EPISODIC_THRESHOLD = 0.2
KNOWLEDGE_THRESHOLD = 0.45

MEMORY_LAYERS = ("workflow", "semantic", "episodic")
LAYER_LABELS = {
    "workflow": "Workflow",
    "semantic": "Patterns",
    "episodic": "Experiences",
    "knowledge": "Docs",
}


def _filter_hits(results: list[dict], threshold: float) -> list[dict]:
    return [
        r for r in results if r["score"] > threshold and not r["id"].startswith("init")
    ]


def _pick_workflow_hits(hits: list[dict]) -> tuple[dict | None, dict | None]:
    recommended = next((h for h in hits if h["text"].startswith("RECOMMENDED")), None)
    avoid = next((h for h in hits if h["text"].startswith("AVOID")), None)
    primary = recommended or (hits[0] if hits else None)
    return primary, avoid


def _pick_knowledge_hit(hits: list[dict], query: str) -> dict | None:
    if not hits:
        return None
    query_lower = query.lower()
    for hit in hits:
        text_lower = hit["text"].lower()
        if "internet" in query_lower and "internet" in text_lower:
            return hit
        if "drop" in query_lower and "drop" in text_lower:
            return hit
    return hits[0]


def _truncate(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def extract_next_action(result: dict) -> str | None:
    primary = result.get("primary_hit")
    if primary:
        text = primary.get("text", "")
        if text.startswith("RECOMMENDED"):
            body = text.split(":", 1)[-1]
            body = re.split(r"\.\s*(GNN|These)", body, maxsplit=1)[0]
            first = body.split(",")[0].strip()
            if first:
                return first
        if text.startswith("AVOID"):
            return None
        if result.get("primary_layer") in MEMORY_LAYERS:
            return _truncate(text, 72)

    knowledge = result.get("knowledge_hit")
    if knowledge:
        text = knowledge["text"]
        if ":" in text:
            step = text.split(":", 1)[-1].split(".")[0].strip()
            if step:
                return _truncate(step, 72)
    return None


def extract_avoid_tools(result: dict) -> set[str]:
    """Parse AVOID workflow hits into tool names."""
    avoid: set[str] = set()
    for hit in result.get("all_results", {}).get("workflow", []):
        text = hit.get("text", "")
        if not text.startswith("AVOID"):
            continue
        body = text.split(":", 1)[-1]
        for part in body.split(","):
            tool = part.split("(")[0].strip().replace(" ", "_").lower()
            if tool:
                avoid.add(tool)
    return avoid


def _build_result(*, hits: dict[str, list[dict]], user_message: str, started: float) -> dict:
    primary_layer = "none"
    primary_hit: dict | None = None
    workflow_avoid: dict | None = None

    for layer in MEMORY_LAYERS:
        if hits[layer]:
            if layer == "workflow":
                primary_hit, workflow_avoid = _pick_workflow_hits(hits[layer])
            else:
                primary_hit = {**hits[layer][0], "layer": layer}
            if primary_hit:
                primary_layer = layer
                primary_hit = {**primary_hit, "layer": layer}
            break

    knowledge_hit = _pick_knowledge_hit(hits["knowledge"], user_message)

    context_parts: list[str] = []
    if primary_hit:
        label = LAYER_LABELS[primary_layer]
        context_parts.append(f"{label}: {_truncate(primary_hit['text'], 220)}")
        if workflow_avoid and workflow_avoid is not primary_hit:
            context_parts.append(f"Constraint: {_truncate(workflow_avoid['text'], 120)}")
    elif knowledge_hit:
        primary_layer = "knowledge"
        primary_hit = {**knowledge_hit, "layer": "knowledge"}
        context_parts.append(f"Docs: {_truncate(knowledge_hit['text'], 220)}")

    if knowledge_hit and primary_layer != "knowledge":
        context_parts.append(f"Reference: {_truncate(knowledge_hit['text'], 120)}")

    layers_active = [layer for layer in MEMORY_LAYERS if hits[layer]]
    if knowledge_hit and "knowledge" not in layers_active:
        layers_active.append("knowledge")

    _record_layer_used(primary_layer)
    elapsed_ms = (time.perf_counter() - started) * 1000

    payload = {
        "context": "\n".join(context_parts),
        "primary_layer": primary_layer,
        "layers_active": layers_active,
        "primary_hit": primary_hit,
        "knowledge_hit": knowledge_hit if primary_layer != "knowledge" else None,
        "layer_used": primary_layer,
        "elapsed_ms": elapsed_ms,
        "all_results": {
            layer: (layer_hits[:1] if layer_hits else [])
            for layer, layer_hits in hits.items()
        },
    }
    payload["next_action"] = extract_next_action(payload)
    payload["avoid_tools"] = list(extract_avoid_tools(payload))
    return payload


async def cascade_query_cold(moss: MossSearch, user_message: str) -> dict:
    """Cold mode: knowledge Moss only — no workflow/semantic/episodic."""
    started = time.perf_counter()
    knowledge_results = await moss.query_index("knowledge", user_message, top_k=2)
    hits = {
        "workflow": [],
        "semantic": [],
        "episodic": [],
        "knowledge": _filter_hits(knowledge_results, KNOWLEDGE_THRESHOLD),
    }
    result = _build_result(hits=hits, user_message=user_message, started=started)
    # Cold agents get docs, not playbook steps — avoids steering identical to memory.
    result["next_action"] = None
    result["avoid_tools"] = []
    return result


async def cascade_query(moss: MossSearch, user_message: str) -> dict:
    """Full mode: 3-layer cascade."""
    started = time.perf_counter()

    workflow_results, knowledge_results = await asyncio.gather(
        moss.query_index("workflows", user_message, top_k=3),
        moss.query_index("knowledge", user_message, top_k=2),
    )

    hits = {
        "workflow": _filter_hits(workflow_results, WORKFLOW_THRESHOLD),
        "semantic": [],
        "episodic": [],
        "knowledge": _filter_hits(knowledge_results, KNOWLEDGE_THRESHOLD),
    }

    if not hits["workflow"]:
        semantic_results, episodic_results = await asyncio.gather(
            moss.query_index("semantic", user_message, top_k=2),
            moss.query_index("episodic", user_message, top_k=2),
        )
        hits["semantic"] = _filter_hits(semantic_results, SEMANTIC_THRESHOLD)
        hits["episodic"] = _filter_hits(episodic_results, EPISODIC_THRESHOLD)

    return _build_result(hits=hits, user_message=user_message, started=started)


def _record_layer_used(layer: str) -> None:
    if layer == "none":
        return
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "UPDATE layer_status SET status = 'active', last_used = CURRENT_TIMESTAMP "
        "WHERE layer = ?",
        (layer if layer != "knowledge" else "episodic",),
    )
    conn.commit()
    conn.close()
