import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type MessageKind = "message" | "question" | "answer" | "proposal" | "decision" | "blocker" | "done";

export interface Message {
  id: string;
  topic: string;
  senderId: string;
  kind: MessageKind;
  body: string;
  replyTo: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export function defaultDatabasePath(): string {
  const data = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
  if (data) return join(data, "smsagents.sqlite");
  return join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state"), "smsagents", "smsagents.sqlite");
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path = defaultDatabasePath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
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

  registerAgent(id: string, name: string, sessionId?: string, metadata: Record<string, unknown> = {}): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO agents(id,name,session_id,metadata,last_seen_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, session_id=COALESCE(excluded.session_id,agents.session_id), metadata=excluded.metadata, last_seen_at=excluded.last_seen_at`)
      .run(id, name, sessionId ?? null, JSON.stringify(metadata), now);
  }

  setOnline(id: string): void {
    this.db.prepare("UPDATE agents SET last_seen_at=? WHERE id=?").run(new Date().toISOString(), id);
  }

  subscribe(agentId: string, topic: string): void {
    this.requireAgent(agentId);
    this.db.prepare("INSERT OR IGNORE INTO subscriptions(agent_id,topic,created_at) VALUES(?,?,?)")
      .run(agentId, topic, new Date().toISOString());
  }

  unsubscribe(agentId: string, topic: string): boolean {
    return this.db.prepare("DELETE FROM subscriptions WHERE agent_id=? AND topic=?").run(agentId, topic).changes > 0;
  }

  publish(input: { topic: string; senderId: string; body: string; kind?: MessageKind; replyTo?: string; dedupeKey?: string; ttlSeconds?: number }): { message: Message; duplicate: boolean; recipients: number } {
    this.requireAgent(input.senderId);
    const now = new Date();
    const expiresAt = input.ttlSeconds ? new Date(now.getTime() + input.ttlSeconds * 1000).toISOString() : null;
    const id = `msg_${randomUUID()}`;
    let duplicate = false;
    try {
      this.db.prepare("INSERT INTO messages(id,topic,sender_id,kind,body,reply_to,dedupe_key,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id, input.topic, input.senderId, input.kind ?? "message", input.body, input.replyTo ?? null, input.dedupeKey ?? null, now.toISOString(), expiresAt);
    } catch (error) {
      if (!input.dedupeKey || !String(error).includes("UNIQUE")) throw error;
      duplicate = true;
    }
    const row = duplicate
      ? this.db.prepare("SELECT * FROM messages WHERE sender_id=? AND topic=? AND dedupe_key=?").get(input.senderId, input.topic, input.dedupeKey!)
      : this.db.prepare("SELECT * FROM messages WHERE id=?").get(id);
    if (!row) throw new Error("Unable to load published message");
    const message = mapMessage(row as Record<string, unknown>);
    if (!duplicate) {
      this.db.prepare(`INSERT OR IGNORE INTO deliveries(message_id,agent_id)
        SELECT ?, agent_id FROM subscriptions WHERE topic=? AND agent_id<>?`)
        .run(message.id, input.topic, input.senderId);
    }
    const recipients = Number((this.db.prepare("SELECT count(*) count FROM deliveries WHERE message_id=?").get(message.id) as { count: number }).count);
    return { message, duplicate, recipients };
  }

  inbox(agentId: string, options: { topic?: string; limit?: number; markDelivered?: boolean } = {}): Message[] {
    this.requireAgent(agentId);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = this.db.prepare(`SELECT m.* FROM messages m JOIN deliveries d ON d.message_id=m.id
      WHERE d.agent_id=? AND d.acked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?)
      AND (? IS NULL OR m.topic=?) ORDER BY m.sequence LIMIT ?`)
      .all(agentId, new Date().toISOString(), options.topic ?? null, options.topic ?? null, limit) as Record<string, unknown>[];
    if (options.markDelivered !== false && rows.length) {
      const stamp = new Date().toISOString();
      const mark = this.db.prepare("UPDATE deliveries SET delivered_at=COALESCE(delivered_at,?) WHERE message_id=? AND agent_id=?");
      for (const row of rows) mark.run(stamp, String(row.id), agentId);
    }
    return rows.map(mapMessage);
  }

  ack(agentId: string, messageIds: string[]): number {
    const statement = this.db.prepare("UPDATE deliveries SET acked_at=? WHERE agent_id=? AND message_id=? AND acked_at IS NULL");
    const now = new Date().toISOString();
    let count = 0;
    for (const id of messageIds) count += Number(statement.run(now, agentId, id).changes);
    return count;
  }

  status(topic: string): { subscribers: Array<{ id: string; name: string; lastSeenAt: string }>; messageCount: number; pendingCount: number } {
    const subscribers = this.db.prepare(`SELECT a.id,a.name,a.last_seen_at FROM agents a JOIN subscriptions s ON s.agent_id=a.id
      WHERE s.topic=? ORDER BY a.name`).all(topic) as Array<{ id: string; name: string; last_seen_at: string }>;
    const messageCount = Number((this.db.prepare("SELECT count(*) count FROM messages WHERE topic=?").get(topic) as { count: number }).count);
    const pendingCount = Number((this.db.prepare(`SELECT count(*) count FROM deliveries d JOIN messages m ON m.id=d.message_id
      WHERE m.topic=? AND d.acked_at IS NULL`).get(topic) as { count: number }).count);
    return { subscribers: subscribers.map(x => ({ id: x.id, name: x.name, lastSeenAt: x.last_seen_at })), messageCount, pendingCount };
  }

  private requireAgent(id: string): void {
    if (!this.db.prepare("SELECT 1 FROM agents WHERE id=?").get(id)) throw new Error(`Unknown agent: ${id}. Call register_agent first.`);
  }
}

function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id), topic: String(row.topic), senderId: String(row.sender_id),
    kind: String(row.kind) as MessageKind, body: String(row.body),
    replyTo: row.reply_to ? String(row.reply_to) : null,
    createdAt: String(row.created_at), expiresAt: row.expires_at ? String(row.expires_at) : null
  };
}
