"""Memorable LiveKit worker."""

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

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
    DEMO_ROUTE,
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
        if scenario == "flight_rebooking":
            return scenario
    return "flight_rebooking"


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
            instructions = f"""You are Jordan, an airline disruption support agent.

Institutional memory from past calls guides rebooking. You receive backend
results before you speak — relay them naturally in order.

Primary route {DEMO_ROUTE} is on file. Use this when describing options.
Prioritize valid same-day options and policy-compliant actions.

Never claim you ran a check unless you received a backend result for it this turn.
Never mention memory, tools, or playbooks. Sound human."""
        else:
            instructions = f"""You are Jordan, an airline disruption support agent.

You have no notes from past calls. You receive backend results before you speak —
relay them naturally.

Primary route {DEMO_ROUTE} is on file for context.

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
        self.trace_events: list[dict[str, Any]] = []

    async def _emit(self, event_type: str, data: dict) -> None:
        enriched = {
            **data,
            "mode": self.mode,
            "scenario_id": self.scenario_id,
            "run_id": self.run_id,
            "model_route": self.model_route,
        }
        ts = datetime.now(timezone.utc).isoformat()
        trace_entry = {"type": event_type, "timestamp": ts, "data": enriched}
        self.trace_events.append(trace_entry)
        if len(self.trace_events) > 250:
            self.trace_events = self.trace_events[-250:]

        logger.info("trace_event=%s", json.dumps(trace_entry, ensure_ascii=False))
        await publish_event(event_type, enriched)
        if self._room is None:
            return
        try:
            await self._room.local_participant.publish_data(
                json.dumps({"type": event_type, **enriched}).encode("utf-8"),
                reliable=True,
            )
        except Exception:
            pass

    async def _run_tool(self, tool_name: str) -> str | None:
        if tool_name in self.hook.steps:
            return None

        if self.hook.is_tool_blocked(tool_name):
            await self._emit(
                "tool_blocked",
                {"tool": tool_name, "steps": list(self.hook.steps), "reason": "avoid_list"},
            )
            return None

        runners = {
            "check_waiver_status": self._do_check_waiver_status,
            "search_partner_flights": self._do_search_partner_flights,
            "apply_same_day_policy": self._do_apply_same_day_policy,
            "auto_rebook_and_issue_voucher": self._do_auto_rebook_and_issue_voucher,
            "search_basic_fares": self._do_search_basic_fares,
            "choose_late_connection": self._do_choose_late_connection,
            "retry_booking_failed_fare_class": self._do_retry_booking_failed_fare_class,
            "escalate_manual_ticketing": self._do_escalate_manual_ticketing,
        }
        fn = runners.get(tool_name)
        if not fn:
            return None

        raw = await fn()
        summary = systems_note_for_tool(tool_name, raw)
        outcome = (
            "failure"
            if tool_name
            in {
                "retry_booking_failed_fare_class",
                "escalate_manual_ticketing",
                "choose_late_connection",
            }
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
                note = await self._run_tool(tool)
                if note:
                    tool_notes.append(note)

        if tool_notes:
            lines.append(format_backend_results(tool_notes))

        if not lines:
            return

        turn_ctx.add_message(role="developer", content="\n".join(lines))

    async def _do_check_waiver_status(self) -> str:
        self.hook.record_tool("check_waiver_status")
        return "Disruption waiver active for this route; change penalties can be waived."

    async def _do_search_partner_flights(self) -> str:
        self.hook.record_tool("search_partner_flights")
        return "Partner inventory found seat on a same-day itinerary arriving 20:15."

    async def _do_apply_same_day_policy(self) -> str:
        self.hook.record_tool("apply_same_day_policy")
        return "Same-day policy validated and applied with no change fee."

    async def _do_auto_rebook_and_issue_voucher(self) -> str:
        self.hook.record_tool("auto_rebook_and_issue_voucher")
        return "Rebooking confirmed and a disruption voucher has been issued."

    async def _do_search_basic_fares(self) -> str:
        self.hook.record_tool("search_basic_fares")
        return "Basic fare search returned limited options with long layovers."

    async def _do_choose_late_connection(self) -> str:
        self.hook.record_tool("choose_late_connection", outcome="failure")
        return "Late-connection option selected; projected missed arrival window."

    async def _do_retry_booking_failed_fare_class(self) -> str:
        self.hook.record_tool("retry_booking_failed_fare_class", outcome="failure")
        return "Retry failed: selected fare class is restricted under disruption rules."

    async def _do_escalate_manual_ticketing(self) -> str:
        self.hook.record_tool("escalate_manual_ticketing", outcome="failure")
        return "Escalated to manual ticketing queue; customer still waiting."

    @function_tool
    async def check_waiver_status(self) -> str:
        """Check disruption waiver eligibility for current itinerary."""
        return await self._run_tool("check_waiver_status") or "Already checked."

    @function_tool
    async def search_partner_flights(self) -> str:
        """Search partner-airline inventory for compliant same-day options."""
        return await self._run_tool("search_partner_flights") or "Already searched."

    @function_tool
    async def apply_same_day_policy(self) -> str:
        """Apply same-day policy to the selected option."""
        return await self._run_tool("apply_same_day_policy") or "Already applied."

    @function_tool
    async def auto_rebook_and_issue_voucher(self) -> str:
        """Finalize rebooking and issue disruption voucher."""
        return await self._run_tool("auto_rebook_and_issue_voucher") or "Already completed."

    @function_tool
    async def search_basic_fares(self) -> str:
        """Search baseline fares without memory-assisted routing."""
        return await self._run_tool("search_basic_fares") or "Already searched."

    @function_tool
    async def choose_late_connection(self) -> str:
        """Choose a late connection from baseline options."""
        return await self._run_tool("choose_late_connection") or "Already attempted."

    @function_tool
    async def retry_booking_failed_fare_class(self) -> str:
        """Retry booking on a restricted fare class."""
        return await self._run_tool("retry_booking_failed_fare_class") or "Already attempted."

    @function_tool
    async def escalate_manual_ticketing(self) -> str:
        """Escalate to manual ticketing when automation cannot complete."""
        return await self._run_tool("escalate_manual_ticketing") or "Already escalated."


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

    room_name = getattr(ctx.room, "name", "")
    room_sid = getattr(ctx.room, "sid", "")
    participant_sid = getattr(getattr(ctx.room, "local_participant", None), "sid", "")

    logger.info(
        "Session %s mode=%s route=%s room=%s room_sid=%s metadata=%s",
        sid,
        mode,
        active_route,
        room_name,
        room_sid,
        ctx.job.metadata,
    )
    await publish_event(
        "session_start",
        {
            "session_id": sid,
            "mode": mode,
            "scenario_id": scenario_id,
            "run_id": run_id,
            "model_route": active_route,
            "room_name": room_name,
            "room_sid": room_sid,
            "participant_sid": participant_sid,
        },
    )
    await publish_event(
        "livekit_trace",
        {
            "session_id": sid,
            "mode": mode,
            "scenario_id": scenario_id,
            "run_id": run_id,
            "model_route": active_route,
            "room_name": room_name,
            "room_sid": room_sid,
            "participant_sid": participant_sid,
            "job_metadata": ctx.job.metadata or "",
        },
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
        instructions="Greet briefly. Ask where they need to arrive and when."
    )

    async def on_shutdown() -> None:
        outcome = (
            "failure"
            if {
                "retry_booking_failed_fare_class",
                "escalate_manual_ticketing",
            }
            & set(hook.steps)
            else "success"
        )
        hook.finalize(outcome=outcome)
        await publish_event(
            "trace_snapshot",
            {
                "session_id": sid,
                "mode": mode,
                "scenario_id": scenario_id,
                "run_id": run_id,
                "model_route": active_route,
                "trace_events": agent.trace_events,
                "steps": hook.steps,
                "outcome": outcome,
            },
        )
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
