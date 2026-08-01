# Two-session handshake experiment

`run.sh` proves the SMSAgents delivery loop end-to-end with two real headless Claude Code sessions sharing one isolated SQLite mailbox.

## What it demonstrates

1. **Stable identity** — session B is primed once, then resumed with `--resume`; both runs hash the same `session_id`, so B keeps one `claude-…` agent id and its subscription.
2. **Hook injection on resume** — when B is resumed, its `SessionStart` hook claims A's pending question and injects it as additional context; B never calls `check_inbox`.
3. **Stop-hook wake-up** — A sends a `question` and ends its turn. Because it has an unanswered outbound question, its `Stop` hook holds the process open (up to `SMSAGENTS_LISTEN_SECONDS`). B's `answer` un-blocks the hook, which returns `decision: "block"` with the reply, so A continues the same turn, acknowledges, and reports the handshake code — with no model-driven polling.

## Run it

```sh
./run.sh
```

Requirements: a logged-in `claude` CLI (v2.1.220+), Node 22.5+, `sqlite3`. The mailbox lives in a fresh temp directory (`SMSAGENTS_DB_PATH`), so the experiment never touches your real mailbox; artifacts are kept only on failure.

Environment knobs: `SMS_EXP_MODEL` pins a model for both sessions; `SMSAGENTS_LISTEN_SECONDS` (default 120 here) bounds how long A listens for the reply.

## Why B is primed first

Publishing fans out deliveries to the subscribers that exist at publish time. B must therefore register and subscribe (step 1) before A sends its question (step 2). A fresh session in step 4 would get a new `session_id`, a new agent id, and no delivery row — resuming the primed session is what makes the identity stable and the delivery land.

## Caveats

Steps 2 and 4 depend on the model following short tool instructions; a run can occasionally fail for model-behavior reasons rather than plugin reasons. Re-run once before treating a failure as a regression — the script prints session stderr and preserves the work directory on failure.
