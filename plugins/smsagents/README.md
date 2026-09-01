# SMSAgents

SMSAgents is a local, durable topic mailbox for AI agent sessions. It bundles an MCP server, coordination instructions, and lifecycle hooks as one plugin that installs into both **Claude Code** and **Codex** from the same directory.

## Why

Separate agent sessions cannot normally exchange concise findings or blockers. SMSAgents gives them shared topics while keeping delivery durable across process and session boundaries.

## Tools

- `register_agent`
- `join_topic` / `leave_topic`
- `send_message`
- `check_inbox`
- `ack_messages`
- `topic_status`

Agents can advertise one or more responsibility scopes when they join, such as `platform`, `game`, or `release`. `join_topic` returns the current membership and active scopes immediately, and `topic_status` provides the same discovery view later.

Set `target_scope` to deliver only to topic members advertising that scope, or `target_agent_id` to deliver to one specific topic member. Omitting both broadcasts to the topic, which is deliberately considered noisy and should be reserved for genuinely cross-functional information: changes in direction, topic-wide decisions, or sudden shared incidents such as outages. The two targets are mutually exclusive, and neither can bypass topic membership. Messages are persisted in SQLite using WAL mode. Senders do not receive their own messages, and optional dedupe keys make retries idempotent.

For example:

```json
{ "agent_id": "agent-a", "topic": "repo:work", "scopes": ["platform", "release"] }
{ "agent_id": "agent-b", "topic": "repo:work", "body": "Can you verify the manifest?", "kind": "question", "target_scope": "platform" }
{ "agent_id": "agent-a", "topic": "repo:work", "body": "Verified.", "kind": "answer", "target_agent_id": "agent-b", "reply_to": "msg_..." }
```

## Runtime support

One core implementation serves both runtimes; only the manifests differ:

| Piece | Claude Code | Codex |
| --- | --- | --- |
| Manifest | `.claude-plugin/plugin.json` (bundled MCP server declared inline with `${CLAUDE_PLUGIN_ROOT}`) | `.codex-plugin/plugin.json` (points at `.mcp.json`, which must stay variable-free) |
| Hooks | `hooks/hooks.json` (shared) | `hooks/hooks.json` (shared) |
| Skill | `skills/coordinate-agents` (shared) | shared |

The shared hooks file uses `${CLAUDE_PLUGIN_ROOT}`, which Claude Code substitutes natively and Codex accepts as an alias for `${PLUGIN_ROOT}`. Hook context injection is capped at 4000 characters inside `dist/hook.js` itself (oversized batches are truncated with a pointer to `check_inbox`), so no runtime-specific limit fields are needed.

Agent identity is stable and runtime-scoped: the hook hashes the session id (or subagent id) and prefixes it with `claude-` when `CLAUDECODE` is set in the hook environment, `codex-` otherwise. Resuming a session keeps the same agent id and subscriptions.

## Development

Requires Node.js 22.5 or newer.

```sh
npm install
npm test
```

The committed `dist/` bundle is the plugin runtime and must be rebuilt after source changes:

```sh
npm run build
```

## Plugin behavior

Lifecycle hooks register sessions and deliver unread messages at `SessionStart`, `SubagentStart`, `UserPromptSubmit`, `PostToolUse`, and before `Stop`/`SubagentStop`. Both runtimes require users to review and trust plugin hooks before they execute.

Set `SMSAGENTS_TOPICS` to a comma-separated list to auto-subscribe new sessions. Otherwise, agents join topics explicitly through MCP.

The SQLite database defaults to `$XDG_STATE_HOME/smsagents/smsagents.sqlite` or `~/.local/state/smsagents/smsagents.sqlite`, so MCP processes and lifecycle hooks share the same mailbox. Set `SMSAGENTS_DB_PATH` to override it.

## Delivery and wake-up semantics

SMSAgents is push-shaped only where the host runtime allows it. What each event can and cannot do in Claude Code (Codex behaves equivalently):

| Moment | Event | Can it deliver messages? |
| --- | --- | --- |
| Session starts or resumes | `SessionStart` | Yes — pending messages are injected as additional context, along with the agent id. |
| Subagent spawns | `SubagentStart` | Yes — same injection for the subagent's own identity. |
| User submits a prompt | `UserPromptSubmit` | Yes — messages that arrived while idle ride in with the next prompt. |
| After every tool call | `PostToolUse` | Yes — this is the main mid-turn delivery path while an agent is actively working. |
| Agent tries to stop | `Stop` / `SubagentStop` | Yes — unhandled messages block the stop (`decision: "block"`) so the agent processes them before ending the turn. |
| Agent stopped with an unanswered `question` | `Stop` (held open) | Yes, within a window — the hook process stays alive up to `SMSAGENTS_LISTEN_SECONDS` (default 300, max 300; the hook timeout is 310s). A reply ends the wait immediately and continues the same turn. No model tokens are spent while waiting. |
| Session fully idle | — | **No.** Once a turn has ended and no hook is running, nothing can wake a Claude Code session: there is no `SessionIdle` event and no external API to inject a turn. Messages queue durably and are delivered by whichever event above fires next. |

Deliberate non-goals, per the project's operating model: no busy polling by the model, and the plugin never spawns `claude`/`codex` processes itself. Goal- or loop-driven agents (which keep taking turns) receive messages promptly via `PostToolUse`; a truly idle session needs a user prompt, a resume, or a runtime-level scheduler to wake.

For collaborative work, start each participant with an explicit goal whose completion criteria include the peer deliverable it needs. In both Claude Code and Codex, `/goal` is the simplest way to keep the session progressing through useful work while lifecycle hooks deliver messages. Use a bounded application loop in hosts without goal mode. Do not keep sessions alive with `sleep` or repeated empty `check_inbox` calls.

SMSAgents composes with other Stop hooks such as `/goal`: when `stop_hook_active` is already set, it does not arm another reply wait, but a newly arrived message still blocks that stop once so the agent can handle it. Atomic claims make this continuation bounded; the same delivery cannot trigger the Stop hook twice.

## Reproducible experiment

[`experiments/two-session`](../../experiments/two-session) runs two headless Claude Code sessions against an isolated mailbox and verifies identity stability, hook injection on resume, and the stop-hook wake-up end to end.
