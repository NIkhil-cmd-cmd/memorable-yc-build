"""Playbook resolution by scenario — cold vs memory diverge visibly."""

FLIGHT_KEYWORDS = (
    "flight",
    "rebook",
    "cancel",
    "delayed",
    "delay",
    "itinerary",
    "airline",
    "voucher",
)

PLAYBOOKS = {
    "flight_rebooking": {
        "full": [
            "check_waiver_status",
            "search_partner_flights",
            "apply_same_day_policy",
            "auto_rebook_and_issue_voucher",
        ],
        "cold": [
            "search_basic_fares",
            "choose_late_connection",
            "retry_booking_failed_fare_class",
            "escalate_manual_ticketing",
        ],
    }
}

DEMO_ROUTE = "SJC -> SFO"


def is_flight_request(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in FLIGHT_KEYWORDS)


def playbook_for_mode(mode: str, scenario_id: str) -> list[str]:
    scenario = PLAYBOOKS.get(scenario_id, PLAYBOOKS["flight_rebooking"])
    return scenario["full" if mode == "full" else "cold"]


def pending_playbook_tools(
    *,
    mode: str,
    scenario_id: str,
    steps: list[str],
    run_playbook: bool,
    avoid_tools: set[str] | None = None,
) -> list[str]:
    """Tools still to run for this session, respecting memory avoid-list."""
    if not run_playbook:
        return []
    avoid = avoid_tools or set()
    playbook = playbook_for_mode(mode, scenario_id)
    pending: list[str] = []
    for tool in playbook:
        if tool in steps:
            continue
        if tool in avoid:
            continue
        pending.append(tool)
    return pending


def next_playbook_tool(
    *,
    mode: str,
    scenario_id: str,
    steps: list[str],
    run_playbook: bool,
    avoid_tools: set[str] | None = None,
) -> str | None:
    pending = pending_playbook_tools(
        mode=mode,
        scenario_id=scenario_id,
        steps=steps,
        run_playbook=run_playbook,
        avoid_tools=avoid_tools,
    )
    return pending[0] if pending else None
