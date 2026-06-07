# Memorable — 30-Second Pitch

**Problem:** Enterprise voice agents forget everything between calls. They repeat mistakes — factory resets that fail, skipped outage checks — because they have no institutional memory.

**Solution:** Memorable adds a 3-layer memory system to any LiveKit agent in five lines of code.

1. **Episodic** — every tool call is traced to SQLite and indexed in Moss
2. **Semantic** — patterns emerge: "factory reset failed 5×, modem reboot succeeded 8×"
3. **Workflow GNN** — PyTorch Geometric distills compact playbooks, exported to Moss

**Proof:** Same scenario ("my internet keeps dropping"):
- Cold agent → factory reset (fails)
- Memory agent → outage check first, factory reset blocked

**Stack:** LiveKit (voice) + Moss (retrieval) + TrueFoundry/MiniMax (LLM) + Memorable (learning loop)

**Integrate:**
```python
from memorable import Memorable
from memorable.livekit import attach
attach(agent, Memorable.from_env(), mode="full")
```

**Ask:** We're looking for teams building production voice agents who want memory that actually changes behavior — not just retrieval scores.
