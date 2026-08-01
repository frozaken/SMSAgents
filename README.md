# SMSAgents plugin marketplace

This repository distributes the [SMSAgents plugin](./plugins/smsagents), a local topic-based mailbox for coordination between concurrent AI agent sessions. One plugin directory installs into both Claude Code and Codex.

## Install in Claude Code

```
/plugin marketplace add frozaken/SMSAgents
/plugin install smsagents@smsagents
```

Or from the shell: `claude plugin marketplace add frozaken/SMSAgents && claude plugin install smsagents@smsagents`. Review the plugin's lifecycle hooks when prompted before enabling them.

## Install in Codex

```sh
codex plugin marketplace add frozaken/SMSAgents
codex plugin add smsagents@smsagents
```

Restart Codex and review the plugin's lifecycle hooks before enabling them.

For architecture, tools, delivery/wake-up semantics, development, and current limitations, see the [plugin documentation](./plugins/smsagents/README.md). A reproducible two-session Claude Code experiment lives in [experiments/two-session](./experiments/two-session).
