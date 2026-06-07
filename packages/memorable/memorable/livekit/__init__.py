"""LiveKit integration — attach memory to any voice agent."""

from __future__ import annotations

import json
import logging
import time
from typing import TYPE_CHECKING, Literal

from memorable.memory.cascade import extract_avoid_tools
from memorable.livekit.briefing import format_agent_briefing

if TYPE_CHECKING:
    from memorable.client import Memorable

logger = logging.getLogger("memorable.livekit")

MemoryMode = Literal["cold", "full"]


class MemoryHook:
    """Inject memory context before each agent turn and constrain tool usage."""

    def __init__(
        self,
        memory: Memorable,
        mode: MemoryMode = "full",
        session_id: str = "livekit",
        task_type: str = "internet_dropout",
    ) -> None:
        self.memory = memory
        self.mode = mode
        self.session_id = session_id
        self.task_type = task_type
        self.steps: list[str] = []
        self.started = time.time()
        self.avoid_tools: set[str] = set()
        self.last_result: dict | None = None

    async def on_user_turn(self, user_message: str) -> str | None:
        result = await self.memory.query(user_message, mode=self.mode)
        self.last_result = result
        if self.mode == "full":
            self.avoid_tools = set(extract_avoid_tools(result))
        return format_agent_briefing(result, self.mode)

    def record_tool(self, tool_name: str, outcome: str = "success") -> None:
        self.steps.append(tool_name)
        if outcome == "failure":
            duration = time.time() - self.started
            self.memory.record_trace(
                self.session_id,
                self.task_type,
                self.steps,
                "failure",
                failure_step=tool_name,
                duration=duration,
            )

    def finalize(self, outcome: str = "success") -> None:
        if not self.steps:
            return
        duration = time.time() - self.started
        self.memory.record_trace(
            self.session_id,
            self.task_type,
            self.steps,
            outcome,
            duration=duration,
        )

    def is_tool_blocked(self, tool_name: str) -> bool:
        if self.mode != "full":
            return False
        return tool_name in self.avoid_tools


def parse_room_metadata(metadata: str | None) -> dict:
    if not metadata:
        return {}
    try:
        return json.loads(metadata)
    except json.JSONDecodeError:
        return {}


def attach(agent, memory: Memorable, mode: MemoryMode = "full") -> MemoryHook:
    """
    Attach Memorable to a LiveKit AgentSession.

    Usage:
        from memorable import Memorable
        from memorable.livekit import attach

        memory = Memorable.from_env()
        hook = attach(agent, memory, mode="full")
    """
    hook = MemoryHook(memory, mode=mode)

    @agent.on("user_turn_completed")
    async def _inject_memory(ctx):  # noqa: ANN001
        turn_ctx = ctx.turn_ctx
        last_msg = ""
        for item in reversed(turn_ctx.items):
            if hasattr(item, "role") and item.role == "user":
                if hasattr(item, "text_content"):
                    last_msg = item.text_content or ""
                break
        if not last_msg:
            return
        injection = await hook.on_user_turn(last_msg)
        if injection:
            turn_ctx.add_message(role="assistant", content=injection)

    logger.info("Memorable attached (mode=%s)", mode)
    return hook
