#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store } from "./store.js";

const store = new Store();
const server = new McpServer(
  { name: "smsagents", version: "0.1.0" },
  { instructions: "Use SMSAgents for concise coordination between local agent sessions. Register once, join a scoped topic with responsibility scopes, check the inbox at natural boundaries, and acknowledge handled messages. Prefer scope or direct targeting. Broadcasting is noisy and should be reserved for cross-functional direction changes, topic-wide decisions, or shared incidents such as outages. Avoid replying to messages that do not require action." }
);

const ok = (data: unknown) => ({ structuredContent: data as Record<string, unknown>, content: [{ type: "text" as const, text: JSON.stringify(data) }] });

server.registerTool("register_agent", {
  title: "Register agent", description: "Register or refresh this agent session before using other SMSAgents tools.",
  inputSchema: { agent_id: z.string().min(1), name: z.string().min(1), session_id: z.string().optional(), metadata: z.record(z.unknown()).optional() }
}, async ({ agent_id, name, session_id, metadata }) => { store.registerAgent(agent_id, name, session_id, metadata); return ok({ agentId: agent_id }); });

server.registerTool("join_topic", {
  title: "Join topic", description: "Subscribe an agent to future topic messages, optionally advertising responsibility scopes. Returns all active subscribers and scopes for discovery.",
  inputSchema: { agent_id: z.string(), topic: z.string().min(1), scopes: z.array(z.string().min(1).max(100)).max(20).optional() }
}, async ({ agent_id, topic, scopes }) => {
  store.subscribe(agent_id, topic, scopes);
  return ok({ subscribed: true, agentId: agent_id, topic, ...store.status(topic) });
});

server.registerTool("leave_topic", {
  title: "Leave topic", description: "Stop receiving future messages from a topic.",
  inputSchema: { agent_id: z.string(), topic: z.string().min(1) }
}, async ({ agent_id, topic }) => ok({ unsubscribed: store.unsubscribe(agent_id, topic), agentId: agent_id, topic }));

server.registerTool("send_message", {
  title: "Send message", description: "Send to one advertised responsibility scope or one agent. Omit a target to broadcast only for cross-functional direction changes, topic-wide decisions, or shared incidents such as outages; broadcasts are noisy. Targets only receive messages when subscribed to the topic.",
  inputSchema: {
    agent_id: z.string(), topic: z.string().min(1), body: z.string().min(1).max(12000),
    kind: z.enum(["message", "question", "answer", "proposal", "decision", "blocker", "done"]).optional(),
    reply_to: z.string().optional(), dedupe_key: z.string().optional(), ttl_seconds: z.number().int().positive().max(604800).optional(),
    target_scope: z.string().trim().min(1).max(100).optional(), target_agent_id: z.string().min(1).optional()
  }
}, async ({ agent_id, topic, body, kind, reply_to, dedupe_key, ttl_seconds, target_scope, target_agent_id }) => {
  if (target_scope && target_agent_id) throw new Error("Choose either target_scope or target_agent_id, not both.");
  return ok(store.publish({ senderId: agent_id, topic, body, kind, replyTo: reply_to, dedupeKey: dedupe_key, ttlSeconds: ttl_seconds, targetScope: target_scope, targetAgentId: target_agent_id }));
});

server.registerTool("check_inbox", {
  title: "Check inbox", description: "Read unacknowledged messages for an agent, optionally restricted to one topic.",
  inputSchema: { agent_id: z.string(), topic: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
  annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
}, async ({ agent_id, topic, limit }) => ok({ messages: store.inbox(agent_id, { topic, limit }) }));

server.registerTool("ack_messages", {
  title: "Acknowledge messages", description: "Mark messages as handled after their contents have been incorporated or answered.",
  inputSchema: { agent_id: z.string(), message_ids: z.array(z.string()).min(1).max(200) }
}, async ({ agent_id, message_ids }) => ok({ acknowledged: store.ack(agent_id, message_ids) }));

server.registerTool("topic_status", {
  title: "Topic status", description: "Inspect topic subscribers, their advertised responsibility scopes, active scope counts, and aggregate message counts.",
  inputSchema: { topic: z.string().min(1) }, annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
}, async ({ topic }) => ok(store.status(topic)));

process.on("SIGINT", () => { store.close(); process.exit(0); });
await server.connect(new StdioServerTransport());
