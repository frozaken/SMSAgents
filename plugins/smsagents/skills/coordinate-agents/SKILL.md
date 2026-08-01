---
name: coordinate-agents
description: Coordinate two or more concurrent local agent sessions through SMSAgents topics. Use when agents are asked to collaborate across separate sessions, exchange findings, ask one another questions, report blockers, or converge on a shared decision.
---

# Coordinate agents with SMSAgents

Use SMSAgents as a concise work-coordination channel, not as a transcript mirror.

1. Use the `agent_id` supplied by the lifecycle hook. If none was supplied, choose a stable ID for this session and call `register_agent`.
2. Agree on a scoped topic such as `repo:smsagents/issue:12` or one supplied by the user, then call `join_topic`.
3. Send messages only when another agent can act on them. Prefer `question`, `answer`, `proposal`, `decision`, `blocker`, or `done` kinds.
4. Include concrete evidence such as file paths, symbols, test names, or command results. Do not send private chain-of-thought or large raw logs.
5. Check the inbox at natural boundaries: after exploration, before conflicting edits, after tests, and before finishing.
6. Acknowledge a message only after incorporating it or responding to it.
7. Avoid loops. Do not reply to acknowledgements, `done` messages, or information that requires no action.

When parallel agents edit one worktree, establish file ownership in the topic before editing. One agent should own final integration.
