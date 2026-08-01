#!/usr/bin/env node

// src/hook.ts
import { createHash } from "node:crypto";

// src/store.ts
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
function defaultDatabasePath() {
  if (process.env.SMSAGENTS_DB_PATH) return process.env.SMSAGENTS_DB_PATH;
  return join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state"), "smsagents", "smsagents.sqlite");
}
var Store = class {
  db;
  constructor(path = defaultDatabasePath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }
  close() {
    this.db.close();
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, session_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}', last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        topic TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, topic)
      );
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        topic TEXT NOT NULL, sender_id TEXT NOT NULL REFERENCES agents(id),
        kind TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT,
        dedupe_key TEXT, created_at TEXT NOT NULL, expires_at TEXT,
        UNIQUE(sender_id, topic, dedupe_key)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        delivered_at TEXT, acked_at TEXT,
        PRIMARY KEY (message_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_topic_sequence ON messages(topic, sequence);
      CREATE INDEX IF NOT EXISTS idx_deliveries_agent_ack ON deliveries(agent_id, acked_at);
    `);
  }
  registerAgent(id, name2, sessionId, metadata = {}) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare(`INSERT INTO agents(id,name,session_id,metadata,last_seen_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, session_id=COALESCE(excluded.session_id,agents.session_id), metadata=excluded.metadata, last_seen_at=excluded.last_seen_at`).run(id, name2, sessionId ?? null, JSON.stringify(metadata), now);
  }
  setOnline(id) {
    this.db.prepare("UPDATE agents SET last_seen_at=? WHERE id=?").run((/* @__PURE__ */ new Date()).toISOString(), id);
  }
  subscribe(agentId2, topic) {
    this.requireAgent(agentId2);
    this.db.prepare("INSERT OR IGNORE INTO subscriptions(agent_id,topic,created_at) VALUES(?,?,?)").run(agentId2, topic, (/* @__PURE__ */ new Date()).toISOString());
  }
  unsubscribe(agentId2, topic) {
    return this.db.prepare("DELETE FROM subscriptions WHERE agent_id=? AND topic=?").run(agentId2, topic).changes > 0;
  }
  publish(input2) {
    this.requireAgent(input2.senderId);
    const now = /* @__PURE__ */ new Date();
    const expiresAt = input2.ttlSeconds ? new Date(now.getTime() + input2.ttlSeconds * 1e3).toISOString() : null;
    const id = `msg_${randomUUID()}`;
    let duplicate = false;
    try {
      this.db.prepare("INSERT INTO messages(id,topic,sender_id,kind,body,reply_to,dedupe_key,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, input2.topic, input2.senderId, input2.kind ?? "message", input2.body, input2.replyTo ?? null, input2.dedupeKey ?? null, now.toISOString(), expiresAt);
    } catch (error) {
      if (!input2.dedupeKey || !String(error).includes("UNIQUE")) throw error;
      duplicate = true;
    }
    const row = duplicate ? this.db.prepare("SELECT * FROM messages WHERE sender_id=? AND topic=? AND dedupe_key=?").get(input2.senderId, input2.topic, input2.dedupeKey) : this.db.prepare("SELECT * FROM messages WHERE id=?").get(id);
    if (!row) throw new Error("Unable to load published message");
    const message = mapMessage(row);
    if (!duplicate) {
      this.db.prepare(`INSERT OR IGNORE INTO deliveries(message_id,agent_id)
        SELECT ?, agent_id FROM subscriptions WHERE topic=? AND agent_id<>?`).run(message.id, input2.topic, input2.senderId);
    }
    const recipients = Number(this.db.prepare("SELECT count(*) count FROM deliveries WHERE message_id=?").get(message.id).count);
    return { message, duplicate, recipients };
  }
  inbox(agentId2, options = {}) {
    this.requireAgent(agentId2);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = this.db.prepare(`SELECT m.* FROM messages m JOIN deliveries d ON d.message_id=m.id
      WHERE d.agent_id=? AND d.acked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?)
      AND (? IS NULL OR m.topic=?) ORDER BY m.sequence LIMIT ?`).all(agentId2, (/* @__PURE__ */ new Date()).toISOString(), options.topic ?? null, options.topic ?? null, limit);
    if (options.markDelivered !== false && rows.length) {
      const stamp = (/* @__PURE__ */ new Date()).toISOString();
      const mark = this.db.prepare("UPDATE deliveries SET delivered_at=COALESCE(delivered_at,?) WHERE message_id=? AND agent_id=?");
      for (const row of rows) mark.run(stamp, String(row.id), agentId2);
    }
    return rows.map(mapMessage);
  }
  claimInbox(agentId2, options = {}) {
    this.requireAgent(agentId2);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`SELECT m.* FROM messages m JOIN deliveries d ON d.message_id=m.id
        WHERE d.agent_id=? AND d.acked_at IS NULL AND d.delivered_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at>?) AND (? IS NULL OR m.topic=?)
        ORDER BY m.sequence LIMIT ?`).all(agentId2, now, options.topic ?? null, options.topic ?? null, limit);
      const mark = this.db.prepare("UPDATE deliveries SET delivered_at=? WHERE message_id=? AND agent_id=? AND delivered_at IS NULL");
      for (const row of rows) mark.run(now, String(row.id), agentId2);
      this.db.exec("COMMIT");
      return rows.map(mapMessage);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  pendingOutboundQuestions(agentId2) {
    this.requireAgent(agentId2);
    const rows = this.db.prepare(`SELECT q.* FROM messages q
      WHERE q.sender_id=? AND q.kind='question' AND (q.expires_at IS NULL OR q.expires_at>?)
      AND EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id=q.id)
      AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to=q.id)
      ORDER BY q.sequence`).all(agentId2, (/* @__PURE__ */ new Date()).toISOString());
    return rows.map(mapMessage);
  }
  ack(agentId2, messageIds) {
    const statement = this.db.prepare("UPDATE deliveries SET acked_at=? WHERE agent_id=? AND message_id=? AND acked_at IS NULL");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let count = 0;
    for (const id of messageIds) count += Number(statement.run(now, agentId2, id).changes);
    return count;
  }
  status(topic) {
    const subscribers = this.db.prepare(`SELECT a.id,a.name,a.last_seen_at FROM agents a JOIN subscriptions s ON s.agent_id=a.id
      WHERE s.topic=? ORDER BY a.name`).all(topic);
    const messageCount = Number(this.db.prepare("SELECT count(*) count FROM messages WHERE topic=?").get(topic).count);
    const pendingCount = Number(this.db.prepare(`SELECT count(*) count FROM deliveries d JOIN messages m ON m.id=d.message_id
      WHERE m.topic=? AND d.acked_at IS NULL`).get(topic).count);
    return { subscribers: subscribers.map((x) => ({ id: x.id, name: x.name, lastSeenAt: x.last_seen_at })), messageCount, pendingCount };
  }
  requireAgent(id) {
    if (!this.db.prepare("SELECT 1 FROM agents WHERE id=?").get(id)) throw new Error(`Unknown agent: ${id}. Call register_agent first.`);
  }
};
function mapMessage(row) {
  return {
    id: String(row.id),
    topic: String(row.topic),
    senderId: String(row.sender_id),
    kind: String(row.kind),
    body: String(row.body),
    replyTo: row.reply_to ? String(row.reply_to) : null,
    createdAt: String(row.created_at),
    expiresAt: row.expires_at ? String(row.expires_at) : null
  };
}

// src/hook.ts
var CONTEXT_LIMIT = 4e3;
var clamp = (text) => text.length <= CONTEXT_LIMIT ? text : `${text.slice(0, CONTEXT_LIMIT - 60)}
\u2026[truncated; use check_inbox for the full messages]`;
var raw = "";
for await (const chunk of process.stdin) raw += chunk;
var input = raw.trim() ? JSON.parse(raw) : {};
var session = input.agent_id ?? input.session_id;
if (!session) process.exit(0);
var runtime = process.env.CLAUDECODE ? "claude" : "codex";
var agentId = `${runtime}-${createHash("sha256").update(session).digest("hex").slice(0, 12)}`;
var name = input.agent_type ? `${input.agent_type}-${agentId.slice(-4)}` : `agent-${agentId.slice(-4)}`;
var store = new Store();
store.registerAgent(agentId, name, input.session_id, { cwd: input.cwd, agentType: input.agent_type, runtime });
var topics = (process.env.SMSAGENTS_TOPICS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
for (const topic of topics) store.subscribe(agentId, topic);
var isStop = input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop";
var messages = store.claimInbox(agentId, { limit: 25 });
if (isStop && messages.length === 0 && !input.stop_hook_active && store.pendingOutboundQuestions(agentId).length > 0) {
  const listenSeconds = Math.max(0, Math.min(Number(process.env.SMSAGENTS_LISTEN_SECONDS ?? 300), 300));
  const deadline = Date.now() + listenSeconds * 1e3;
  while (messages.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, deadline - Date.now())));
    messages = store.claimInbox(agentId, { limit: 25 });
  }
}
store.close();
var summary = messages.map((m) => `[${m.kind}] ${m.topic} from ${m.senderId} (${m.id}):
${m.body}`).join("\n\n");
if (isStop && messages.length) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: clamp(`SMSAgents received ${messages.length} unacknowledged message(s). Handle them before stopping. Your agent_id is ${agentId}.

${summary}

After handling them, call ack_messages.`) }));
} else if ((input.hook_event_name === "SessionStart" || input.hook_event_name === "SubagentStart") && messages.length) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: clamp(`SMSAgents agent_id: ${agentId}. Unacknowledged messages:

${summary}

Handle and acknowledge these messages.`) } }));
} else if (input.hook_event_name === "SessionStart" || input.hook_event_name === "SubagentStart") {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: `Your SMSAgents agent_id is ${agentId}. Join a scoped topic before coordinating with other sessions.` } }));
} else if (messages.length && (input.hook_event_name === "PostToolUse" || input.hook_event_name === "UserPromptSubmit")) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: clamp(`SMSAgents delivered ${messages.length} message(s) to agent_id ${agentId}:

${summary}

Handle and acknowledge these messages.`) } }));
}
//# sourceMappingURL=hook.js.map
