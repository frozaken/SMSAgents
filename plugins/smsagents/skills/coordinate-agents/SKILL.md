---
name: coordinate-agents
description: Coordinate two or more concurrent local agent sessions through SMSAgents topics and goal- or loop-driven work. Use when agents are asked to collaborate across separate sessions, exchange findings, ask one another questions, report blockers, or converge on a shared decision.
---

# Coordinate agents with SMSAgents

Use SMSAgents as a concise work-coordination channel, not as a transcript mirror.

1. For work that depends on peer exchanges, use the host's goal or bounded-loop mode so the agent remains active until explicit completion criteria are met. In Codex or Claude Code, ask the user to start `/goal` unless they already requested a persistent goal. Never create a persistent goal without explicit user authorization.
2. Include peer deliverables in the completion criteria: required answers received, shared decisions recorded, and handled messages acknowledged.
3. Use the `agent_id` supplied by the lifecycle hook. If none was supplied, choose a stable ID for this session and call `register_agent`.
4. Agree on a scoped topic such as `repo:smsagents/issue:12` or one supplied by the user, then call `join_topic`. Advertise short responsibility `scopes` such as `platform`, `game`, or `review` and inspect the returned subscribers and active scopes before dividing work.
5. Send messages only when another agent can act on them. Prefer `target_scope` for work owned by a responsibility and `target_agent_id` for a specific peer. Broadcasting to every topic member is noisy: omit both targets only for genuinely cross-functional information that every agent needs, such as a change in direction, a topic-wide decision, or a sudden shared incident like an outage. Prefer `question`, `answer`, `proposal`, `decision`, `blocker`, or `done` kinds.
6. Include concrete evidence such as file paths, symbols, test names, or command results. Do not send private chain-of-thought or large raw logs.
7. Continue useful independent work between exchanges. Hooks deliver new mail at normal lifecycle boundaries; do not busy-poll, sleep, or run an empty inbox loop.
8. Check the inbox at natural boundaries: after exploration, before conflicting edits, after tests, and before finishing.
9. Acknowledge a message only after incorporating it or responding to it.
10. Avoid reply loops. Do not reply to acknowledgements, `done` messages, or information that requires no action.

When parallel agents edit one worktree, establish file ownership in the topic before editing. One agent should own final integration.

Questions create a bounded expected-reply window. When this agent attempts to stop with an unanswered question, SMSAgents keeps a lightweight hook listener open. A reply continues the agent without a polling tool or model tokens spent waiting. Use `reply_to` when answering so the sender's listener can resolve the question, and use `target_agent_id` when only that sender needs the answer.

A fully stopped session is not resumed automatically. Its messages remain durable and arrive on the next session start, user prompt, tool boundary, or goal continuation. Prefer goals and bounded loops over external process spawning.
