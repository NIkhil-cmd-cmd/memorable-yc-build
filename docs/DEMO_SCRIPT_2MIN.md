# Memorable 2-Minute Demo Script (Flight Rebooking)

## 0:00-0:15 — Hook
"Voice agents fail in disruption calls because they forget what worked in past calls. They retry bad fare paths and escalate manually."

"We built Memorable: a memory layer for LiveKit voice agents that learns successful workflows and replays them in the next call."

## 0:15-0:30 — Stack callout
"Our stack is LiveKit for realtime voice, Moss for retrieval and embeddings, TrueFoundry for model routing, and MiniMax as the primary model route through TrueFoundry."

## 0:30-1:25 — Cold vs memory trace demo
"I’m running the same prompt in both modes: 'My flight got canceled, I need to get to SF tonight.'"

"Cold run first: it goes through `search_basic_fares`, picks a late connection, retries a restricted fare class, then escalates to manual ticketing. It burns steps and still doesn’t resolve."

"Now memory mode on the same scenario: it starts with `check_waiver_status`, uses `search_partner_flights`, applies same-day policy, and finishes with `auto_rebook_and_issue_voucher`."

"You can see the divergence in the workflow graph and tool timeline: memory blocks dead-end transitions and replays the proven path."

## 1:25-1:45 — Result
"Compared to cold, memory uses fewer tool calls, lower token usage, and faster resolution. This is behavior change, not just better retrieval scores."

## 1:45-2:00 — Close
"Memorable turns every call into trace data, extracts reusable workflow memory, and injects it into the next LiveKit agent run."

"Repo: https://github.com/NIkhil-cmd-cmd/memorable-yc-build"
