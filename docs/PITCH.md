# Memorable — 30-Second Pitch

**Problem:** Flight disruption agents repeat dead-end booking steps because they do not retain workflow memory.

**Solution:** Memorable adds a 3-layer memory system to LiveKit agents in five lines: episodic traces, semantic patterns, and GNN-distilled workflow playbooks.

**Proof:** Same cancellation prompt:
- Cold run retries restricted fare paths and escalates.
- Memory run executes waiver check -> partner search -> same-day policy -> auto rebook + voucher.

**Stack:** LiveKit + Moss + TrueFoundry + MiniMax + Memorable.
