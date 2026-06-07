"""Moss client — 3 physical indexes: knowledge, memory, workflows."""

import asyncio
import os

from moss import DocumentInfo, MossClient, QueryOptions

from memorable.config import load_env

load_env()

QUERY_TIMEOUT_S = 2.5
PHYSICAL_INDEXES = ["knowledge", "memory", "workflows"]
LAYER_CONFIG: dict[str, tuple[str, str | None]] = {
    "knowledge": ("knowledge", None),
    "episodic": ("memory", "episodic"),
    "semantic": ("memory", "semantic"),
    "workflows": ("workflows", None),
}


class MossSearch:
    def __init__(self) -> None:
        self._project_id = os.getenv("MOSS_PROJECT_ID", "")
        self._project_key = os.getenv("MOSS_PROJECT_KEY", "")
        self.client: MossClient | None = None
        self._loaded: set[str] = set()
        self._load_lock = asyncio.Lock()
        self._model_id = os.getenv("MOSS_MODEL_ID", "moss-minilm")

    def _get_client(self) -> MossClient:
        if self.client is None:
            if not self._project_id or not self._project_key:
                raise RuntimeError(
                    "MOSS_PROJECT_ID and MOSS_PROJECT_KEY must be set in .env.local"
                )
            self.client = MossClient(self._project_id, self._project_key)
        return self.client

    async def _ensure_loaded(self, physical_index: str) -> None:
        if physical_index in self._loaded:
            return
        async with self._load_lock:
            if physical_index in self._loaded:
                return
            try:
                await self._get_client().load_index(physical_index)
                self._loaded.add(physical_index)
            except Exception:
                pass

    async def ensure_all_loaded(self) -> None:
        await asyncio.gather(*(self._ensure_loaded(idx) for idx in PHYSICAL_INDEXES))

    async def reload_index(self, physical_index: str) -> None:
        self._loaded.discard(physical_index)
        await self._ensure_loaded(physical_index)

    async def query_index(
        self, layer_name: str, query: str, top_k: int = 3
    ) -> list[dict]:
        physical, layer_filter = LAYER_CONFIG.get(layer_name, (layer_name, None))
        await self._ensure_loaded(physical)
        try:
            options = QueryOptions(top_k=top_k)
            if layer_filter:
                options = QueryOptions(
                    top_k=top_k,
                    filter={"field": "layer", "condition": {"$eq": layer_filter}},
                )
            results = await asyncio.wait_for(
                self._get_client().query(physical, query, options),
                timeout=QUERY_TIMEOUT_S,
            )
            return [
                {"text": doc.text, "score": doc.score, "id": doc.id}
                for doc in results.docs
            ]
        except (asyncio.TimeoutError, Exception):
            return []

    async def _replace_index(
        self, physical_index: str, moss_docs: list[DocumentInfo]
    ) -> None:
        client = self._get_client()
        existing = {idx.name for idx in await client.list_indexes()}
        if physical_index in existing:
            await client.delete_index(physical_index)
        await client.create_index(physical_index, moss_docs, self._model_id)
        await self.reload_index(physical_index)

    async def index_documents(self, physical_index: str, docs: list[dict]) -> None:
        moss_docs = [
            DocumentInfo(
                id=d["id"],
                text=d["text"],
                metadata={k: str(v) for k, v in d.get("metadata", {}).items()},
            )
            for d in docs
        ]
        await self._replace_index(physical_index, moss_docs)

    async def rebuild_memory_index(
        self, episodic_docs: list[dict], semantic_docs: list[dict]
    ) -> None:
        moss_docs: list[DocumentInfo] = []
        for d in episodic_docs:
            moss_docs.append(
                DocumentInfo(id=d["id"], text=d["text"], metadata={"layer": "episodic"})
            )
        for d in semantic_docs:
            moss_docs.append(
                DocumentInfo(id=d["id"], text=d["text"], metadata={"layer": "semantic"})
            )
        if not moss_docs:
            moss_docs = [
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
            ]
        await self._replace_index("memory", moss_docs)
