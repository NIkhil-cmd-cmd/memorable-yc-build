"""Memorable LiveKit worker."""

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone

import httpx
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    cli,
    function_tool,
    inference,
    llm,
    room_io,
)
from livekit.plugins import ai_coustics, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

from memorable import Memorable
from memorable.livekit import MemoryHook, parse_room_metadata
from memorable.livekit.briefing import format_backend_results, systems_note_for_tool
from memorable.memory.tools import (
    DEMO_ZIP,
    pending_playbook_tools,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(ROOT, ".env.local"))
load_dotenv(os.path.join(ROOT, "agent-py", ".env.local"))

logger = logging.getLogger("memorable.worker")
logging.basicConfig(level=logging.INFO)

server = AgentServer()
memory = Memorable.from_env()
WEBHOOK = os.getenv("MEMORABLE_EVENTS_URL", "http://localhost:3000/api/events/publish")


async def publish_event(event_type: str, data: dict) -> None:
    payload = {
        "type": event_type,
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.post(WEBHOOK, json=payload)
            resp.raise_for_status()
    except Exception as e:
        logger.warning("Event publish failed: %s", e)


def _build_llm(requested_route: str) -> tuple[inference.LLM, str]:
    truefoundry_endpoint = os.getenv("TRUEFOUNDRY_ENDPOINT", "").strip()
    truefoundry_api_key = os.getenv("TRUEFOUNDRY_API_KEY", "").strip()
    openai_model = os.getenv("OPENAI_MODEL", "openai/gpt-4.1-mini").strip()

    if requested_route == "truefoundry-openai":
        if truefoundry_endpoint and truefoundry_api_key:
            model = os.getenv("TRUEFOUNDRY_OPENAI_MODEL", "gpt-4.1-mini").strip()
            return (
                inference.LLM(
                    model=model,
                    provider="openai",
                    base_url=truefoundry_endpoint,
                    api_key=truefoundry_api_key,
                ),
                "truefoundry-openai",
            )
        logger.warning(
            "TRUEFOUNDRY_ENDPOINT/TRUEFOUNDRY_API_KEY missing, falling back to direct OpenAI"
        )
        return inference.LLM(model=openai_model), "direct-openai"

    if requested_route == "truefoundry-minimax":
        if truefoundry_endpoint and truefoundry_api_key:
            model = os.getenv("TRUEFOUNDRY_MINIMAX_MODEL", "MiniMax-Text-01").strip()
            return (
                inference.LLM(
                    model=model,
                    provider="openai",
                    base_url=truefoundry_endpoint,
                    api_key=truefoundry_api_key,
                ),
                "truefoundry-minimax",
            )
        logger.warning(
            "TRUEFOUNDRY_ENDPOINT/TRUEFOUNDRY_API_KEY missing, falling back to direct OpenAI"
        )
        return inference.LLM(model=openai_model), "direct-openai"

    return inference.LLM(model=openai_model), "direct-openai"


def _user_message_text(message: llm.ChatMessage) -> str:
    parts = [c for c in message.content if isinstance(c, str)]
    return " ".join(parts).strip()


def _resolve_mode(ctx: JobContext) -> str:
    for raw in (ctx.job.metadata, getattr(ctx.room, "metadata", None)):
        meta = parse_room_metadata(raw)
        mode = meta.get("memory_mode")
        if mode in ("cold", "full"):
            return mode
    return "full"


def _resolve_scenario(ctx: JobContext) -> str:
    for raw in (ctx.job.metadata, getattr(ctx.room, "metadata", None)):
        meta = parse_room_metadata(raw)
        scenario = meta.get("scenario_id")
        if scenario in ("internet_dropout", "billing_dispute", "phone_service_issue"):
            return scenario
    return "internet_dropout"


def _resolve_run_id(ctx: JobContext) -> str | None:
    for raw in (ctx.job.metadata, getattr(ctx.room, "metadata", None)):
        meta = parse_room_metadata(raw)
        run_id = meta.get("run_id")
        if isinstance(run_id, str) and run_id.strip():
            return run_id.strip()
    return None


def _resolve_model_route(ctx: JobContext) -> str:
    allowed = {"direct-openai", "truefoundry-openai", "truefoundry-minimax"}
    for raw in (ctx.job.metadata, getattr(ctx.room, "metadata", None)):
        meta = parse_room_metadata(raw)
        route = meta.get("model_route")
        if isinstance(route, str) and route.strip() in allowed:
            return route.strip()
    return "direct-openai"


class SupportAgent(Agent):
    def __init__(
        self,
        hook: MemoryHook,
        mode: str,
        scenario_id: str,
        run_id: str | None,
        model_route: str,
        moss_ready: asyncio.Task | None,
        room=None,
    ):
        if mode == "full":
            instructions = f"""You are Jordan, an ISP phone support agent.

Institutional memory from past calls guides troubleshooting. You receive backend
results before you speak — relay them naturally in order.

Account zip {DEMO_ZIP} is on file. Use it for outage checks; do not ask for zip first.
If asked how you know their area, say you looked up outages for the zip on their account.

Never claim you ran a check unless you received a backend result for it this turn.
Never mention memory, tools, or playbooks. Sound human."""
        else:
            instructions = f"""You are Jordan, an ISP phone support agent.

You have no notes from past calls. You receive backend results before you speak —
relay them naturally.

Account zip {DEMO_ZIP} is on file for outage checks if needed.

Never claim you ran a check unless you received a backend result for it this turn.
Never mention tools or systems. Sound human."""

        super().__init__(instructions=instructions)
        self.hook = hook
        self.mode = mode
        self.scenario_id = scenario_id
        self.run_id = run_id
        self.model_route = model_route
        self._moss_ready = moss_ready
        self._room = room
        self._playbook_started = False

    async def _emit(self, event_type: str, data: dict) -> None:
        data = {
            **data,
            "mode": self.mode,
            "scenario_id": self.scenario_id,
            "run_id": self.run_id,
            "model_route": self.model_route,
        }
        await publish_event(event_type, data)
        if self._room is None:
            return
        try:
            await self._room.local_participant.publish_data(
                json.dumps({"type": event_type, **data}).encode("utf-8"),
                reliable=True,
            )
        except Exception:
            pass

    async def _run_tool(self, tool_name: str, zip_code: str | None = None) -> str | None:
        if tool_name in self.hook.steps:
            return None

        if self.hook.is_tool_blocked(tool_name):
            await self._emit(
                "tool_blocked",
                {"tool": tool_name, "steps": list(self.hook.steps), "reason": "avoid_list"},
            )
            return None

        runners = {
            "check_outage_map": lambda: self._do_check_outage_map(zip_code or DEMO_ZIP),
            "check_line_signal": self._do_check_line_signal,
            "reboot_modem": self._do_reboot_modem,
            "factory_reset_router": self._do_factory_reset_router,
            "run_speed_test": self._do_run_speed_test,
            "pull_account_billing": self._do_pull_account_billing,
            "apply_bill_credit": self._do_apply_bill_credit,
            "escalate_tier2": self._do_escalate_tier2,
            "reset_apn_settings": self._do_reset_apn_settings,
        }
        fn = runners.get(tool_name)
        if not fn:
            return None

        raw = await fn()
        summary = systems_note_for_tool(tool_name, raw)
        outcome = (
            "failure"
            if tool_name in {"factory_reset_router", "escalate_tier2"}
            else "success"
        )
        await self._emit(
            "tool_call",
            {
                "tool": tool_name,
                "steps": list(self.hook.steps),
                "outcome": outcome,
                "summary": summary,
            },
        )
        logger.info("[%s] ran %s → %s", self.mode, tool_name, self.hook.steps)
        return summary

    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        user_text = _user_message_text(new_message)
        if len(user_text) < 2:
            return

        if self._moss_ready is not None:
            try:
                await self._moss_ready
            except Exception:
                pass

        zip_code = DEMO_ZIP
        if user_text.strip().isdigit() and len(user_text.strip()) == 5:
            zip_code = user_text.strip()

        briefing = await self.hook.on_user_turn(user_text)
        result = self.hook.last_result or {}

        await self._emit(
            "model_turn",
            {
                "user_text": user_text,
                "latency_ms": result.get("elapsed_ms", 0),
                "input_tokens": max(1, len(user_text) // 4),
                "output_tokens": max(1, int((len(user_text) // 4) * 1.1)),
                "estimated_cost_usd": round(max(1, len(user_text) // 4) * 0.0000008, 6),
                "route": self.model_route,
            },
        )

        if result:
            await self._emit(
                "recall",
                {
                    "layer": result.get("primary_layer", "none"),
                    "layers_active": result.get("layers_active", []),
                    "elapsed_ms": result.get("elapsed_ms", 0),
                    "next_action": result.get("next_action"),
                    "primary_hit": result.get("primary_hit"),
                    "avoid_tools": result.get("avoid_tools", []),
                },
            )
            await self._emit(
                "memory_injection",
                {
                    "layer": result.get("primary_layer", "none"),
                    "layers_active": result.get("layers_active", []),
                    "elapsed_ms": result.get("elapsed_ms", 0),
                    "next_action": result.get("next_action"),
                    "primary_hit": result.get("primary_hit"),
                    "avoid_tools": result.get("avoid_tools", []),
                },
            )

        lines: list[str] = []
        if briefing:
            lines.append(briefing)

        tool_notes: list[str] = []
        if not self._playbook_started:
            self._playbook_started = True
            to_run = pending_playbook_tools(
                mode=self.mode,
                scenario_id=self.scenario_id,
                steps=self.hook.steps,
                run_playbook=True,
                avoid_tools=self.hook.avoid_tools,
            )
            for tool in to_run:
                note = await self._run_tool(tool, zip_code=zip_code)
                if note:
                    tool_notes.append(note)

        if tool_notes:
            lines.append(format_backend_results(tool_notes))

        if not lines:
            return

        turn_ctx.add_message(role="developer", content="\n".join(lines))

    async def _do_check_outage_map(self, zip_code: str = DEMO_ZIP) -> str:
        self.hook.record_tool("check_outage_map")
        return f"No outages near {zip_code}."

    async def _do_check_line_signal(self) -> str:
        self.hook.record_tool("check_line_signal")
        return "Line signal weak at −18 dBm."

    async def _do_reboot_modem(self) -> str:
        self.hook.record_tool("reboot_modem")
        return "Modem reboot sent."

    async def _do_factory_reset_router(self) -> str:
        self.hook.record_tool("factory_reset_router", outcome="failure")
        return "Factory reset failed — router did not come back online."

    async def _do_run_speed_test(self) -> str:
        self.hook.record_tool("run_speed_test")
        return "Speed test 45/12 Mbps — looks fine on paper."

    async def _do_pull_account_billing(self) -> str:
        self.hook.record_tool("pull_account_billing")
        return "Billing history loaded: duplicate prorated fee detected."

    async def _do_apply_bill_credit(self) -> str:
        self.hook.record_tool("apply_bill_credit")
        return "Applied one-time $25 service credit and corrected recurring line item."

    async def _do_escalate_tier2(self) -> str:
        self.hook.record_tool("escalate_tier2", outcome="failure")
        return "Escalation queued with 48-hour SLA; customer issue unresolved on call."

    async def _do_reset_apn_settings(self) -> str:
        self.hook.record_tool("reset_apn_settings")
        return "APN reset pushed. Voice/data registration restored after network reattach."

    @function_tool
    async def check_outage_map(self, zip_code: str = DEMO_ZIP) -> str:
        """Check regional outage map."""
        return await self._run_tool("check_outage_map", zip_code=zip_code) or "Already checked."

    @function_tool
    async def check_line_signal(self) -> str:
        """Check line signal quality."""
        return await self._run_tool("check_line_signal") or "Already checked."

    @function_tool
    async def reboot_modem(self) -> str:
        """Reboot customer modem."""
        return await self._run_tool("reboot_modem") or "Already rebooted."

    @function_tool
    async def factory_reset_router(self) -> str:
        """Factory reset router."""
        return await self._run_tool("factory_reset_router") or "Already attempted."

    @function_tool
    async def run_speed_test(self) -> str:
        """Run speed test."""
        return await self._run_tool("run_speed_test") or "Already tested."

    @function_tool
    async def pull_account_billing(self) -> str:
        """Load billing account details."""
        return await self._run_tool("pull_account_billing") or "Already reviewed."

    @function_tool
    async def apply_bill_credit(self) -> str:
        """Apply billing credit."""
        return await self._run_tool("apply_bill_credit") or "Already applied."

    @function_tool
    async def escalate_tier2(self) -> str:
        """Escalate case to tier 2."""
        return await self._run_tool("escalate_tier2") or "Already escalated."

    @function_tool
    async def reset_apn_settings(self) -> str:
        """Reset mobile APN settings."""
        return await self._run_tool("reset_apn_settings") or "Already reset."


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session(agent_name="memorable-agent")
async def entrypoint(ctx: JobContext) -> None:
    sid = str(uuid.uuid4())[:8]
    mode = _resolve_mode(ctx)
    scenario_id = _resolve_scenario(ctx)
    run_id = _resolve_run_id(ctx)
    requested_route = _resolve_model_route(ctx)
    llm_runtime, active_route = _build_llm(requested_route)

    logger.info("Session %s mode=%s metadata=%s", sid, mode, ctx.job.metadata)
    await publish_event(
        "session_start",
        {"session_id": sid, "mode": mode, "scenario_id": scenario_id, "run_id": run_id},
    )

    moss_ready = asyncio.create_task(memory.ensure_loaded())
    hook = MemoryHook(memory, mode=mode, session_id=sid, task_type=scenario_id)
    agent = SupportAgent(
        hook=hook,
        mode=mode,
        scenario_id=scenario_id,
        run_id=run_id,
        model_route=active_route,
        moss_ready=moss_ready,
        room=ctx.room,
    )

    session = AgentSession(
        stt=inference.STT(model="deepgram/nova-3", language="multi"),
        llm=llm_runtime,
        tts=inference.TTS(
            model="cartesia/sonic-3",
            voice="9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
        ),
        turn_detection=MultilingualModel(),
        vad=ctx.proc.userdata["vad"],
        preemptive_generation=False,
    )

    await session.start(
        agent=agent,
        room=ctx.room,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=ai_coustics.audio_enhancement(
                    model=ai_coustics.EnhancerModel.QUAIL_VF_S
                ),
            ),
        ),
    )
    await ctx.connect()
    await session.generate_reply(
        instructions="Greet briefly. Ask how you can help with their service."
    )

    async def on_shutdown() -> None:
        outcome = "failure" if "factory_reset_router" in hook.steps else "success"
        hook.finalize(outcome=outcome)
        await publish_event(
            "session_end",
            {
                "session_id": sid,
                "mode": mode,
                "scenario_id": scenario_id,
                "run_id": run_id,
                "steps": hook.steps,
            },
        )

    ctx.add_shutdown_callback(on_shutdown)


if __name__ == "__main__":
    cli.run_app(server)
