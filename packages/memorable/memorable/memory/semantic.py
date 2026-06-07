"""Semantic Memory (Layer 2)."""

import json
import sqlite3
from collections import defaultdict

from memorable.config import DB_PATH
from memorable.moss.client import MossSearch

CROSS_TASK_WARNINGS = [
    {
        "id": "sem-xfer-reset",
        "text": (
            "Warning: reset_network_settings has a high failure rate in related "
            "connectivity tasks — this is the same pattern as factory_reset_router "
            "for internet issues. Avoid full resets for phone connectivity complaints."
        ),
    },
]


def build_semantic_docs() -> tuple[list[dict], dict]:
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT task_type, steps, outcome, failure_step, duration_seconds FROM traces"
    ).fetchall()
    conn.close()

    if not rows:
        return [], {"patterns": 0, "tasks": 0}

    task_data: dict = defaultdict(
        lambda: {
            "success_paths": defaultdict(int),
            "failure_points": defaultdict(int),
            "durations": [],
            "total": 0,
            "successes": 0,
        }
    )

    for task_type, steps_json, outcome, failure_step, duration in rows:
        steps = json.loads(steps_json)
        td = task_data[task_type]
        td["total"] += 1
        if outcome == "success":
            td["successes"] += 1
            td["success_paths"][" → ".join(steps)] += 1
            if duration:
                td["durations"].append(duration)
        elif failure_step:
            td["failure_points"][failure_step] += 1

    docs = []
    n_patterns = 0

    for task_type, td in task_data.items():
        task_name = task_type.replace("_", " ")
        success_rate = td["successes"] / td["total"] if td["total"] > 0 else 0
        avg_dur = sum(td["durations"]) / len(td["durations"]) if td["durations"] else 0

        if td["success_paths"]:
            best_path = max(td["success_paths"], key=td["success_paths"].get)
            best_count = td["success_paths"][best_path]
            dur_str = f", avg {avg_dur:.0f}s" if avg_dur else ""
            docs.append(
                {
                    "id": f"sem-best-{task_type}",
                    "text": (
                        f"Best approach for {task_name}: {best_path} "
                        f"(used {best_count} times, {success_rate:.0%} success rate"
                        f"{dur_str})."
                    ),
                }
            )
            n_patterns += 1

        if td["failure_points"]:
            worst = max(td["failure_points"], key=td["failure_points"].get)
            worst_count = td["failure_points"][worst]
            docs.append(
                {
                    "id": f"sem-fail-{task_type}",
                    "text": (
                        f"Warning for {task_name}: the step "
                        f"'{worst.replace('_', ' ')}' has failed {worst_count} times. "
                        "Avoid this approach."
                    ),
                }
            )
            n_patterns += 1

    all_task_tools: dict[str, set] = {}
    for task_type, td in task_data.items():
        tools: set = set()
        for path in td["success_paths"]:
            tools.update(path.split(" → "))
        all_task_tools[task_type] = tools

    for task_type, steps_json, _outcome, failure_step, _ in rows:
        if failure_step:
            all_task_tools.setdefault(task_type, set()).add(failure_step)
        for step in json.loads(steps_json):
            all_task_tools.setdefault(task_type, set()).add(step)

    for task_a, tools_a in all_task_tools.items():
        for task_b, tools_b in all_task_tools.items():
            if task_a >= task_b:
                continue
            overlap = tools_a & tools_b
            if overlap:
                docs.append(
                    {
                        "id": f"sem-xref-{task_a}-{task_b}",
                        "text": (
                            f"Cross-reference: {task_a.replace('_', ' ')} and "
                            f"{task_b.replace('_', ' ')} share steps "
                            f"({', '.join(sorted(overlap))}). Failure patterns may "
                            "transfer between them."
                        ),
                    }
                )
                n_patterns += 1

    docs.extend(CROSS_TASK_WARNINGS)
    n_patterns += len(CROSS_TASK_WARNINGS)

    return docs, {"patterns": n_patterns, "tasks": len(task_data)}


async def extract_and_index_patterns(moss: MossSearch) -> dict:
    from memorable.memory.traces import build_episodic_docs

    episodic = build_episodic_docs()
    semantic, stats = build_semantic_docs()

    if not episodic and not semantic:
        return {"status": "no_data"}

    await moss.rebuild_memory_index(episodic, semantic)

    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "UPDATE layer_status SET status = 'active', detail = ? WHERE layer = 'semantic'",
        (f"{stats['patterns']} patterns, {stats['tasks']} task types",),
    )
    conn.commit()
    conn.close()

    return {
        "status": "indexed",
        "patterns": stats["patterns"],
        "tasks": stats["tasks"],
    }
