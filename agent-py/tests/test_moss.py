"""Unit tests for Memorable memory cascade and agent helpers."""

import pytest

import agent as agent_module
from agent import SupportAgent, detect_task, detect_tools
from memory.cascade import cascade_query, extract_next_action


class _FakeMossSearch:
    def __init__(self) -> None:
        self.query_results: dict[str, list[dict]] = {}
        self.indexed: list[tuple] = []

    async def ensure_all_loaded(self) -> None:
        pass

    async def query_index(self, index_name: str, query: str, top_k: int = 3) -> list[dict]:
        return self.query_results.get(index_name, [])

    async def index_documents(self, index_name: str, docs: list[dict]) -> None:
        self.indexed.append((index_name, docs))


@pytest.fixture
def stub_moss(monkeypatch):
    fake = _FakeMossSearch()
    monkeypatch.setattr(agent_module, "moss", fake)
    return fake


def test_detect_task_internet():
    assert detect_task("My internet keeps dropping") == "internet_dropout"


def test_detect_tools_modem():
    assert "reboot_modem" in detect_tools("Please reboot my modem")


def test_extract_next_action_from_workflow():
    result = {
        "primary_hit": {
            "text": "RECOMMENDED for internet dropout: reboot modem (100%), check line signal (100%). GNN-distilled.",
            "score": 0.99,
        },
        "primary_layer": "workflow",
    }
    assert extract_next_action(result) == "reboot modem (100%)"


@pytest.mark.asyncio
async def test_cascade_knowledge_fallback(stub_moss):
    stub_moss.query_results = {
        "workflows": [],
        "semantic": [],
        "episodic": [],
        "knowledge": [
            {"id": "internet-dropout", "text": "Check outage map first.", "score": 0.9}
        ],
    }
    result = await cascade_query(stub_moss, "internet keeps dropping")
    assert "Check outage map" in result["context"]
    assert result["primary_layer"] == "knowledge"


@pytest.mark.asyncio
async def test_run_memory_cascade_records_tools(stub_moss):
    stub_moss.query_results = {
        "workflows": [],
        "semantic": [],
        "episodic": [],
        "knowledge": [],
    }
    agent = SupportAgent(session_id="test-2", initial_context="")
    await agent._run_memory_cascade("I need to reboot my modem for billing")
    assert "reboot_modem" in agent.steps
    assert "pull_account_billing" in agent.steps
