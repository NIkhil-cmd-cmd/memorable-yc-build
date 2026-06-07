"""Natural-language briefings for the voice agent (never shown to the customer)."""

from memorable.memory.tools import DEMO_ZIP

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
            "Without run history you will run a speed test, then try a full router reset if drops continue."
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
        f"Account zip {DEMO_ZIP} is on file — use it for outage checks. "
        "Relay each backend result below in order; do not skip steps."
    )
    return "\n".join(parts) if parts else None


def systems_note_for_tool(tool: str, raw_result: str) -> str:
    """Facts the agent can paraphrase — not spoken verbatim."""
    notes = {
        "check_outage_map": (
            f"Outage map for zip {DEMO_ZIP}: no active outages in the customer's area."
        ),
        "check_line_signal": "Line diagnostics: signal weak at −18 dBm — likely cause of drops.",
        "reboot_modem": "Modem reboot sent — connection should stabilize in a few minutes.",
        "factory_reset_router": "Factory reset failed — router did not come back online.",
        "run_speed_test": "Speed test: 45 Mbps down / 12 Mbps up — looks fine on paper.",
        "pull_account_billing": "Billing review: duplicate prorated fee identified on the latest invoice.",
        "apply_bill_credit": "Billing correction applied with a one-time $25 credit.",
        "escalate_tier2": "Tier-2 escalation placed; issue remains unresolved on this call.",
        "reset_apn_settings": "APN reset completed; mobile registration recovered.",
    }
    return notes.get(tool, raw_result)


def format_backend_results(notes: list[str]) -> str:
    if not notes:
        return ""
    lines = ["Backend results (relay in order, plain language):"]
    for i, note in enumerate(notes, 1):
        lines.append(f"{i}. {note}")
    return "\n".join(lines)
