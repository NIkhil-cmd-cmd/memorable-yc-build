"""Playbook resolution by scenario — cold vs memory diverge visibly."""

INTERNET_KEYWORDS = ("internet", "drop", "disconnect", "wifi", "outage", "slow", "connection")

PLAYBOOKS = {
    "internet_dropout": {
        "full": ["check_outage_map", "check_line_signal", "reboot_modem"],
        "cold": ["run_speed_test", "factory_reset_router"],
    },
    "billing_dispute": {
        "full": ["pull_account_billing", "apply_bill_credit"],
        "cold": ["escalate_tier2"],
    },
    "phone_service_issue": {
        "full": ["reset_apn_settings", "reboot_modem"],
        "cold": ["factory_reset_router"],
    },
}

DEMO_ZIP = "95014"


def is_internet_issue(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in INTERNET_KEYWORDS)


def playbook_for_mode(mode: str, scenario_id: str) -> list[str]:
    scenario = PLAYBOOKS.get(scenario_id, PLAYBOOKS["internet_dropout"])
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
