"""Moss index bootstrap."""

import os

from moss import DocumentInfo, MossClient

from memorable.config import KNOWLEDGE_PATH, load_env

load_env()


async def ensure_indexes(
    client: MossClient,
    *,
    knowledge_docs: list[DocumentInfo],
    model_id: str = "moss-minilm",
) -> None:
    existing = {idx.name for idx in await client.list_indexes()}
    if "knowledge" not in existing:
        await client.create_index("knowledge", knowledge_docs, model_id)
    if "memory" not in existing:
        await client.create_index(
            "memory",
            [
                DocumentInfo(
                    id="init-episodic",
                    text="No episodic traces captured yet.",
                    metadata={"layer": "episodic"},
                ),
                DocumentInfo(
                    id="init-semantic",
                    text="No semantic patterns extracted yet.",
                    metadata={"layer": "semantic"},
                ),
            ],
            model_id,
        )
    if "workflows" not in existing:
        await client.create_index(
            "workflows",
            [
                DocumentInfo(
                    id="init-wf",
                    text="No workflow recommendations yet. Train the GNN first.",
                )
            ],
            model_id,
        )


async def seed_knowledge_from_file() -> None:
    import json

    from memorable.moss.client import MossSearch

    project_id = os.environ.get("MOSS_PROJECT_ID")
    project_key = os.environ.get("MOSS_PROJECT_KEY")
    if not project_id or not project_key:
        return

    with open(KNOWLEDGE_PATH) as f:
        docs_raw = json.load(f)
    knowledge_docs = [DocumentInfo(id=d["id"], text=d["text"]) for d in docs_raw]
    client = MossClient(project_id, project_key)
    model_id = os.getenv("MOSS_MODEL_ID", "moss-minilm")
    await ensure_indexes(client, knowledge_docs=knowledge_docs, model_id=model_id)
    moss = MossSearch()
    await moss.reload_index("knowledge")
