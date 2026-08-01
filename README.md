# SMSAgents plugin marketplace

This repository distributes the [SMSAgents plugin](./plugins/smsagents), a local topic-based mailbox for coordination between concurrent AI agent sessions.

## Install

```sh
codex plugin marketplace add frozaken/SMSAgents
codex plugin add smsagents@smsagents
```

Restart Codex and review the plugin's lifecycle hooks before enabling them.

For architecture, tools, development, and current limitations, see the [plugin documentation](./plugins/smsagents/README.md).
