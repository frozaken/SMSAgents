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

The SQLite database lives in the host-provided `PLUGIN_DATA` directory. Outside a plugin host it defaults to `$XDG_STATE_HOME/smsagents/smsagents.sqlite` or `~/.local/state/smsagents/smsagents.sqlite`.

## Current boundary

Hooks deliver at lifecycle boundaries; they do not wake a session that has already become fully idle. A future optional supervisor can use Codex App Server to resume such sessions.
