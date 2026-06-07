"""Natural-language briefings for the voice agent (never shown to the customer)."""

from memorable.memory.tools import DEMO_ROUTE

LAYER_HINTS = {
    "workflow": "From past calls on similar issues",
    "semantic": "Pattern across recent cases",
    "episodic": "From a recent similar case",
    "knowledge": "From the support knowledge base",
}


def format_agent_briefing(result: dict, mode: str) -> str | None:
    """Turn cascade output into a brief the agent reads internally."""
    if not result:
        return None

    layer = result.get("primary_layer", "none")
    parts: list[str] = []

    if mode == "cold":
        if result.get("context"):
            parts.append(
                "You only have standard documentation — no notes from past calls on what worked."
            )
            parts.append(f"Docs: {result['context'][:280]}")
        parts.append(
            "Without run history, confirm intent, search baseline fares, and continue step-by-step."
        )
        return "\n".join(parts) if parts else None

    hint = LAYER_HINTS.get(layer, "From memory")
    if result.get("context"):
        parts.append(f"{hint}: {result['context'][:320]}")

    avoid = result.get("avoid_tools") or []
    if avoid:
        labels = ", ".join(t.replace("_", " ") for t in avoid[:3])
        parts.append(f"Past calls say avoid: {labels}.")

    next_action = result.get("next_action")
    if next_action:
        parts.append(f"Memory recommends: {next_action}.")

    parts.append(
        f"Primary customer route {DEMO_ROUTE} is on file. "
        "Relay each backend result below in order; do not skip steps."
    )
    return "\n".join(parts) if parts else None


def systems_note_for_tool(tool: str, raw_result: str) -> str:
    """Facts the agent can paraphrase — not spoken verbatim."""
    notes = {
        "check_waiver_status": "Ops waiver is active for this disruption window, penalties can be bypassed.",
        "search_partner_flights": "Partner inventory found an earlier seat that satisfies same-day constraints.",
        "apply_same_day_policy": "Same-day rebooking policy applied with no change fee.",
        "auto_rebook_and_issue_voucher": (
            "Customer rebooked and disruption voucher issued in one flow."
        ),
        "search_basic_fares": "Only baseline fares returned, no policy-aware routing yet.",
        "choose_late_connection": "Selected a late connection with high miss-risk and poor arrival time.",
        "retry_booking_failed_fare_class": (
            "Booking retry failed because fare class is restricted under current disruption rules."
        ),
        "escalate_manual_ticketing": "Manual queue escalation created; issue remains unresolved on this call.",
    }
    return notes.get(tool, raw_result)


def format_backend_results(notes: list[str]) -> str:
    if not notes:
        return ""
    lines = ["Backend results (relay in order, plain language):"]
    for i, note in enumerate(notes, 1):
        lines.append(f"{i}. {note}")
    return "\n".join(lines)
