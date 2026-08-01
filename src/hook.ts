#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Store } from "./store.js";

interface HookInput { session_id?: string; agent_id?: string; agent_type?: string; cwd?: string; hook_event_name?: string; stop_hook_active?: boolean }

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
const session = input.agent_id ?? input.session_id;
if (!session) process.exit(0);
const agentId = `codex-${createHash("sha256").update(session).digest("hex").slice(0, 12)}`;
const name = input.agent_type ? `${input.agent_type}-${agentId.slice(-4)}` : `agent-${agentId.slice(-4)}`;
const store = new Store();
store.registerAgent(agentId, name, input.session_id, { cwd: input.cwd, agentType: input.agent_type });

const topics = (process.env.SMSAGENTS_TOPICS ?? "").split(",").map(x => x.trim()).filter(Boolean);
for (const topic of topics) store.subscribe(agentId, topic);
const messages = store.inbox(agentId, { limit: 25 });
store.close();

const summary = messages.map(m => `[${m.kind}] ${m.topic} from ${m.senderId} (${m.id}):\n${m.body}`).join("\n\n");
if (input.hook_event_name === "Stop" && messages.length && !input.stop_hook_active) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: `SMSAgents received ${messages.length} unacknowledged message(s). Handle them before stopping. Your agent_id is ${agentId}.\n\n${summary}\n\nAfter handling them, call ack_messages.` }));
} else if ((input.hook_event_name === "SessionStart" || input.hook_event_name === "SubagentStart") && messages.length) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: `SMSAgents agent_id: ${agentId}. Unacknowledged messages:\n\n${summary}\n\nHandle and acknowledge these messages.` } }));
} else if (input.hook_event_name === "SessionStart" || input.hook_event_name === "SubagentStart") {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: `Your SMSAgents agent_id is ${agentId}. Join a scoped topic before coordinating with other sessions.` } }));
}
