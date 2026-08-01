#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Store } from "./store.js";

interface HookInput { session_id?: string; agent_id?: string; agent_type?: string; cwd?: string; hook_event_name?: string; stop_hook_active?: boolean }

const CONTEXT_LIMIT = 4000;
const clamp = (text: string) => text.length <= CONTEXT_LIMIT ? text : `${text.slice(0, CONTEXT_LIMIT - 60)}\n…[truncated; use check_inbox for the full messages]`;

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
const session = input.agent_id ?? input.session_id;
if (!session) process.exit(0);
const runtime = process.env.CLAUDECODE ? "claude" : "codex";
const agentId = `${runtime}-${createHash("sha256").update(session).digest("hex").slice(0, 12)}`;
const name = input.agent_type ? `${input.agent_type}-${agentId.slice(-4)}` : `agent-${agentId.slice(-4)}`;
const store = new Store();
store.registerAgent(agentId, name, input.session_id, { cwd: input.cwd, agentType: input.agent_type, runtime });

const topics = (process.env.SMSAGENTS_TOPICS ?? "").split(",").map(x => x.trim()).filter(Boolean);
for (const topic of topics) store.subscribe(agentId, topic);

const isStop = input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop";
// A host sets stop_hook_active after this hook has already blocked one stop.
// Do not claim fresh mail in that guard invocation: the host will ignore another
// stop block, so claiming here would hide the mail from the next usable event.
let messages = isStop && input.stop_hook_active ? [] : store.claimInbox(agentId, { limit: 25 });
if (isStop && messages.length === 0 && !input.stop_hook_active && store.pendingOutboundQuestions(agentId).length > 0) {
  const listenSeconds = Math.max(0, Math.min(Number(process.env.SMSAGENTS_LISTEN_SECONDS ?? 300), 300));
  const deadline = Date.now() + listenSeconds * 1000;
  while (messages.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(200, deadline - Date.now())));
    messages = store.claimInbox(agentId, { limit: 25 });
  }
}
store.close();

const summary = messages.map(m => `[${m.kind}] ${m.topic} from ${m.senderId} (${m.id}):\n${m.body}`).join("\n\n");
if (isStop && messages.length && !input.stop_hook_active) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: clamp(`SMSAgents received ${messages.length} unacknowledged message(s). Handle them before stopping. Your agent_id is ${agentId}.\n\n${summary}\n\nAfter handling them, call ack_messages.`) }));
} else if ((input.hook_event_name === "SessionStart" || input.hook_event_name === "SubagentStart") && messages.length) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: clamp(`SMSAgents agent_id: ${agentId}. Unacknowledged messages:\n\n${summary}\n\nHandle and acknowledge these messages.`) } }));
} else if (input.hook_event_name === "SessionStart" || input.hook_event_name === "SubagentStart") {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: `Your SMSAgents agent_id is ${agentId}. Join a scoped topic before coordinating with other sessions.` } }));
} else if (messages.length && (input.hook_event_name === "PostToolUse" || input.hook_event_name === "UserPromptSubmit")) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: clamp(`SMSAgents delivered ${messages.length} message(s) to agent_id ${agentId}:\n\n${summary}\n\nHandle and acknowledge these messages.`) } }));
}
