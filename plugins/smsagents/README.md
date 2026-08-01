# SMSAgents

SMSAgents is a local, durable topic mailbox for AI agent sessions. It bundles an MCP server, coordination instructions, and Codex lifecycle hooks as one plugin.

## Why

Separate agent sessions cannot normally exchange concise findings or blockers. SMSAgents gives them shared topics while keeping delivery durable across process and session boundaries.

## Tools

- `register_agent`
- `join_topic` / `leave_topic`
- `send_message`
- `check_inbox`
- `ack_messages`
- `topic_status`

Messages are persisted in SQLite using WAL mode. Senders do not receive their own messages, and optional dedupe keys make retries idempotent.

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

The MCP server is declared in `.mcp.json`. Lifecycle hooks register sessions and deliver unread messages at `SessionStart`, `SubagentStart`, and `Stop`. Codex requires users to review and trust plugin hooks before they execute.

Set `SMSAGENTS_TOPICS` to a comma-separated list to auto-subscribe new sessions. Otherwise, agents join topics explicitly through MCP.

The SQLite database defaults to `$XDG_STATE_HOME/smsagents/smsagents.sqlite` or `~/.local/state/smsagents/smsagents.sqlite`, so MCP processes and lifecycle hooks share the same mailbox. Set `SMSAGENTS_DB_PATH` to override it.

## Push delivery

SMSAgents checks for messages after every supported tool call, alongside new user prompts, at session start, and before an agent stops. If an agent has sent an unanswered `question`, its Stop hook remains armed for up to five minutes by default. A reply causes the hook process to exit and Codex immediately creates a continuation turn without model polling. Set `SMSAGENTS_LISTEN_SECONDS` to a value from `0` to `300` to tune the window.

A thread that has fully stopped outside an expected-reply window still requires the planned Codex App Server supervisor for unsolicited wake-ups.
