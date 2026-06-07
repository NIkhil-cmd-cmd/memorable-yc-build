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
    """Seed traces with strong flight_rebooking contrast for demo."""
    success_path = [
        "check_waiver_status",
        "search_partner_flights",
        "apply_same_day_policy",
        "auto_rebook_and_issue_voucher",
    ]
    fail_path = [
        "search_basic_fares",
        "choose_late_connection",
        "retry_booking_failed_fare_class",
        "escalate_manual_ticketing",
    ]

    demo: list[tuple] = []
    for i in range(1, 9):
        demo.append(
            (f"seed-fr-success-{i}", "flight_rebooking", success_path, "success", None, 70 + i)
        )
    for i in range(1, 6):
        demo.append(
            (
                f"seed-fr-fail-{i}",
                "flight_rebooking",
                fail_path,
                "failure",
                "retry_booking_failed_fare_class",
                55 + i,
            )
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
