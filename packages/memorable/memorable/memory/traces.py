"""Episodic Memory (Layer 1)."""

import json
import sqlite3
from typing import Optional

from memorable.config import DB_PATH


def store_trace(
    session_id: str,
    task_type: str,
    steps: list[str],
    outcome: str,
    failure_step: Optional[str] = None,
    duration: Optional[float] = None,
) -> None:
    conn = sqlite3.connect(DB_PATH)

    conn.execute(
        "INSERT INTO traces (session_id, task_type, steps, outcome, failure_step, "
        "duration_seconds) VALUES (?, ?, ?, ?, ?, ?)",
        (session_id, task_type, json.dumps(steps), outcome, failure_step, duration),
    )

    for i in range(len(steps) - 1):
        from_tool = steps[i]
        to_tool = steps[i + 1]
        is_failure_edge = outcome == "failure" and to_tool == failure_step

        conn.execute(
            """
            INSERT INTO workflow_edges (task_type, from_tool, to_tool, success_count, failure_count)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(task_type, from_tool, to_tool) DO UPDATE SET
                success_count = success_count + excluded.success_count,
                failure_count = failure_count + excluded.failure_count
            """,
            (
                task_type,
                from_tool,
                to_tool,
                0 if is_failure_edge else 1,
                1 if is_failure_edge else 0,
            ),
        )

    trace_count = conn.execute("SELECT COUNT(*) FROM traces").fetchone()[0]
    conn.execute(
        "UPDATE layer_status SET status = 'active', detail = ? WHERE layer = 'episodic'",
        (f"{trace_count} traces",),
    )
    conn.commit()
    conn.close()


def build_episodic_docs() -> list[dict]:
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT session_id, task_type, steps, outcome, failure_step, duration_seconds "
        "FROM traces ORDER BY created_at DESC"
    ).fetchall()
    conn.close()

    docs = []
    for session_id, task_type, steps_json, outcome, failure_step, duration in rows:
        steps = json.loads(steps_json)
        step_str = " → ".join(steps)
        if outcome == "success":
            outcome_str = f"succeeded in {duration:.0f}s" if duration else "succeeded"
        else:
            outcome_str = f"failed at step '{failure_step}'"
        docs.append(
            {
                "id": f"ep-{session_id}",
                "text": (
                    f"Agent handled {task_type.replace('_', ' ')}: {step_str}. "
                    f"Outcome: {outcome_str}."
                ),
            }
        )
    return docs


def get_trace_count() -> int:
    conn = sqlite3.connect(DB_PATH)
    count = conn.execute("SELECT COUNT(*) FROM traces").fetchone()[0]
    conn.close()
    return count


def get_recent_traces(limit: int = 20) -> list[dict]:
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT session_id, task_type, steps, outcome, failure_step, duration_seconds, "
        "created_at FROM traces ORDER BY created_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [
        {
            "session_id": r[0],
            "task_type": r[1],
            "steps": json.loads(r[2]),
            "outcome": r[3],
            "failure_step": r[4],
            "duration": r[5],
            "created_at": r[6],
        }
        for r in rows
    ]


def seed_demo_traces() -> None:
    """Seed traces with strong internet_dropout contrast for demo."""
    success_path = ["check_outage_map", "check_line_signal", "reboot_modem"]
    fail_path = ["check_outage_map", "factory_reset_router"]

    demo: list[tuple] = []
    for i in range(1, 9):
        demo.append(
            (f"seed-id-{i}", "internet_dropout", success_path, "success", None, 45 + i)
        )
    for i in range(1, 6):
        demo.append(
            (
                f"seed-fail-{i}",
                "internet_dropout",
                fail_path,
                "failure",
                "factory_reset_router",
                15 + i,
            )
        )

    demo.extend(
        [
            (
                "seed-bd-1",
                "billing_dispute",
                ["pull_account_billing", "apply_bill_credit"],
                "success",
                None,
                35,
            ),
            (
                "seed-bd-2",
                "billing_dispute",
                ["pull_account_billing", "apply_bill_credit"],
                "success",
                None,
                42,
            ),
            (
                "seed-bd-3",
                "billing_dispute",
                ["pull_account_billing", "escalate_tier2"],
                "failure",
                "escalate_tier2",
                28,
            ),
            (
                "seed-ph-1",
                "phone_service_issue",
                ["reset_apn_settings", "reboot_modem"],
                "success",
                None,
                40,
            ),
            (
                "seed-ph-2",
                "phone_service_issue",
                ["reset_apn_settings"],
                "success",
                None,
                25,
            ),
            (
                "seed-ph-3",
                "phone_service_issue",
                ["factory_reset_router"],
                "failure",
                "factory_reset_router",
                12,
            ),
            ("seed-sim-1", "sim_activation", ["activate_sim"], "success", None, 30),
            ("seed-sim-2", "sim_activation", ["activate_sim"], "success", None, 28),
        ]
    )

    for session_id, task_type, steps, outcome, failure_step, duration in demo:
        conn = sqlite3.connect(DB_PATH)
        exists = conn.execute(
            "SELECT 1 FROM traces WHERE session_id = ?", (session_id,)
        ).fetchone()
        conn.close()
        if not exists:
            store_trace(
                session_id, task_type, steps, outcome, failure_step, float(duration)
            )
