#!/usr/bin/env node

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
        topic TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, topic)
      );
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        topic TEXT NOT NULL, sender_id TEXT NOT NULL REFERENCES agents(id),
        kind TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT,
        target_scope TEXT, target_agent_id TEXT,
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
    this.addColumnIfMissing("subscriptions", "scopes", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("messages", "target_scope", "TEXT");
    this.addColumnIfMissing("messages", "target_agent_id", "TEXT");
  }
  registerAgent(id, name, sessionId, metadata = {}) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare(`INSERT INTO agents(id,name,session_id,metadata,last_seen_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, session_id=COALESCE(excluded.session_id,agents.session_id), metadata=excluded.metadata, last_seen_at=excluded.last_seen_at`).run(id, name, sessionId ?? null, JSON.stringify(metadata), now);
  }
  setOnline(id) {
    this.db.prepare("UPDATE agents SET last_seen_at=? WHERE id=?").run((/* @__PURE__ */ new Date()).toISOString(), id);
  }
  subscribe(agentId, topic, scopes) {
    this.requireAgent(agentId);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (scopes === void 0) {
      this.db.prepare("INSERT OR IGNORE INTO subscriptions(agent_id,topic,created_at) VALUES(?,?,?)").run(agentId, topic, now);
      return;
    }
    const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
    this.db.prepare(`INSERT INTO subscriptions(agent_id,topic,scopes,created_at) VALUES(?,?,?,?)
      ON CONFLICT(agent_id,topic) DO UPDATE SET scopes=excluded.scopes`).run(agentId, topic, JSON.stringify(normalized), now);
  }
  unsubscribe(agentId, topic) {
    return this.db.prepare("DELETE FROM subscriptions WHERE agent_id=? AND topic=?").run(agentId, topic).changes > 0;
  }
  publish(input) {
    this.requireAgent(input.senderId);
    const targetScope = input.targetScope?.trim();
    if (input.targetScope !== void 0 && !targetScope) throw new Error("targetScope cannot be empty.");
    if (targetScope && input.targetAgentId) throw new Error("Choose either targetScope or targetAgentId, not both.");
    const now = /* @__PURE__ */ new Date();
    const expiresAt = input.ttlSeconds ? new Date(now.getTime() + input.ttlSeconds * 1e3).toISOString() : null;
    const id = `msg_${randomUUID()}`;
    let duplicate = false;
    try {
      this.db.prepare("INSERT INTO messages(id,topic,sender_id,kind,body,reply_to,target_scope,target_agent_id,dedupe_key,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, input.topic, input.senderId, input.kind ?? "message", input.body, input.replyTo ?? null, targetScope ?? null, input.targetAgentId ?? null, input.dedupeKey ?? null, now.toISOString(), expiresAt);
    } catch (error) {
      if (!input.dedupeKey || !String(error).includes("UNIQUE")) throw error;
      duplicate = true;
    }
    const row = duplicate ? this.db.prepare("SELECT * FROM messages WHERE sender_id=? AND topic=? AND dedupe_key=?").get(input.senderId, input.topic, input.dedupeKey) : this.db.prepare("SELECT * FROM messages WHERE id=?").get(id);
    if (!row) throw new Error("Unable to load published message");
    const message = mapMessage(row);
    if (!duplicate) {
      if (input.targetAgentId) {
        this.db.prepare(`INSERT OR IGNORE INTO deliveries(message_id,agent_id)
          SELECT ?, agent_id FROM subscriptions WHERE topic=? AND agent_id=? AND agent_id<>?`).run(message.id, input.topic, input.targetAgentId, input.senderId);
      } else if (targetScope) {
        this.db.prepare(`INSERT OR IGNORE INTO deliveries(message_id,agent_id)
          SELECT ?, s.agent_id FROM subscriptions s, json_each(s.scopes)
          WHERE s.topic=? AND json_each.value=? AND s.agent_id<>?`).run(message.id, input.topic, targetScope, input.senderId);
      } else {
        this.db.prepare(`INSERT OR IGNORE INTO deliveries(message_id,agent_id)
          SELECT ?, agent_id FROM subscriptions WHERE topic=? AND agent_id<>?`).run(message.id, input.topic, input.senderId);
      }
    }
    const recipients = Number(this.db.prepare("SELECT count(*) count FROM deliveries WHERE message_id=?").get(message.id).count);
    return { message, duplicate, recipients };
  }
  inbox(agentId, options = {}) {
    this.requireAgent(agentId);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = this.db.prepare(`SELECT m.* FROM messages m JOIN deliveries d ON d.message_id=m.id
      WHERE d.agent_id=? AND d.acked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?)
      AND (? IS NULL OR m.topic=?) ORDER BY m.sequence LIMIT ?`).all(agentId, (/* @__PURE__ */ new Date()).toISOString(), options.topic ?? null, options.topic ?? null, limit);
    if (options.markDelivered !== false && rows.length) {
      const stamp = (/* @__PURE__ */ new Date()).toISOString();
      const mark = this.db.prepare("UPDATE deliveries SET delivered_at=COALESCE(delivered_at,?) WHERE message_id=? AND agent_id=?");
      for (const row of rows) mark.run(stamp, String(row.id), agentId);
    }
    return rows.map(mapMessage);
  }
  claimInbox(agentId, options = {}) {
    this.requireAgent(agentId);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`SELECT m.* FROM messages m JOIN deliveries d ON d.message_id=m.id
        WHERE d.agent_id=? AND d.acked_at IS NULL AND d.delivered_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at>?) AND (? IS NULL OR m.topic=?)
        ORDER BY m.sequence LIMIT ?`).all(agentId, now, options.topic ?? null, options.topic ?? null, limit);
      const mark = this.db.prepare("UPDATE deliveries SET delivered_at=? WHERE message_id=? AND agent_id=? AND delivered_at IS NULL");
      for (const row of rows) mark.run(now, String(row.id), agentId);
      this.db.exec("COMMIT");
      return rows.map(mapMessage);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  pendingOutboundQuestions(agentId) {
    this.requireAgent(agentId);
    const rows = this.db.prepare(`SELECT q.* FROM messages q
      WHERE q.sender_id=? AND q.kind='question' AND (q.expires_at IS NULL OR q.expires_at>?)
      AND EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id=q.id)
      AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to=q.id)
      ORDER BY q.sequence`).all(agentId, (/* @__PURE__ */ new Date()).toISOString());
    return rows.map(mapMessage);
  }
  ack(agentId, messageIds) {
    const statement = this.db.prepare("UPDATE deliveries SET acked_at=? WHERE agent_id=? AND message_id=? AND acked_at IS NULL");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let count = 0;
    for (const id of messageIds) count += Number(statement.run(now, agentId, id).changes);
    return count;
  }
  status(topic) {
    const subscribers = this.db.prepare(`SELECT a.id,a.name,a.last_seen_at,s.scopes FROM agents a JOIN subscriptions s ON s.agent_id=a.id
      WHERE s.topic=? ORDER BY a.name`).all(topic);
    const activeScopes = this.db.prepare(`SELECT json_each.value scope, count(*) agent_count FROM subscriptions s, json_each(s.scopes)
      WHERE s.topic=? GROUP BY json_each.value ORDER BY json_each.value`).all(topic);
    const messageCount = Number(this.db.prepare("SELECT count(*) count FROM messages WHERE topic=?").get(topic).count);
    const pendingCount = Number(this.db.prepare(`SELECT count(*) count FROM deliveries d JOIN messages m ON m.id=d.message_id
      WHERE m.topic=? AND d.acked_at IS NULL`).get(topic).count);
    return {
      subscribers: subscribers.map((x) => ({ id: x.id, name: x.name, scopes: JSON.parse(x.scopes), lastSeenAt: x.last_seen_at })),
      activeScopes: activeScopes.map((x) => ({ scope: x.scope, agentCount: Number(x.agent_count) })),
      messageCount,
      pendingCount
    };
  }
  addColumnIfMissing(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    targetScope: row.target_scope ? String(row.target_scope) : null,
    targetAgentId: row.target_agent_id ? String(row.target_agent_id) : null,
    createdAt: String(row.created_at),
    expiresAt: row.expires_at ? String(row.expires_at) : null
  };
}

// src/cli.ts
var [command, ...args] = process.argv.slice(2);
var store = new Store();
try {
  if (command === "inbox") console.log(JSON.stringify(store.inbox(args[0], { limit: Number(args[1] ?? 50) }), null, 2));
  else if (command === "status") console.log(JSON.stringify(store.status(args[0]), null, 2));
  else if (command === "ack") console.log(JSON.stringify({ acknowledged: store.ack(args[0], args.slice(1)) }));
  else {
    console.error("Usage: smsagents <inbox AGENT_ID [LIMIT] | status TOPIC | ack AGENT_ID MESSAGE_ID...>");
    process.exitCode = 2;
  }
} finally {
  store.close();
}
//# sourceMappingURL=cli.js.map
