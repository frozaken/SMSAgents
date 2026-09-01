import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";

test("delivers topic messages to other subscribers and supports acknowledgement", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "smsagents-")), "test.sqlite"));
  store.registerAgent("alpha", "Alpha");
  store.registerAgent("beta", "Beta");
  store.registerAgent("outsider", "Outsider");
  store.subscribe("alpha", "repo:test");
  store.subscribe("beta", "repo:test");

  const sent = store.publish({ senderId: "alpha", topic: "repo:test", kind: "question", body: "Can you verify this?" });
  assert.equal(sent.recipients, 1);
  assert.equal(store.inbox("alpha").length, 0);
  assert.equal(store.inbox("outsider").length, 0);
  assert.equal(store.inbox("beta")[0]?.body, "Can you verify this?");
  assert.equal(store.ack("beta", [sent.message.id]), 1);
  assert.equal(store.inbox("beta").length, 0);
  store.close();
});

test("dedupe keys make retries idempotent", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "smsagents-")), "test.sqlite"));
  store.registerAgent("alpha", "Alpha");
  const first = store.publish({ senderId: "alpha", topic: "t", body: "one", dedupeKey: "run-1" });
  const second = store.publish({ senderId: "alpha", topic: "t", body: "two", dedupeKey: "run-1" });
  assert.equal(second.duplicate, true);
  assert.equal(second.message.id, first.message.id);
  assert.equal(second.message.body, "one");
  store.close();
});

test("hook delivery claims a message once while inbox retains it until acknowledgement", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "smsagents-")), "test.sqlite"));
  store.registerAgent("alpha", "Alpha");
  store.registerAgent("beta", "Beta");
  store.subscribe("alpha", "t");
  store.subscribe("beta", "t");
  store.publish({ senderId: "alpha", topic: "t", body: "once" });
  assert.equal(store.claimInbox("beta").length, 1);
  assert.equal(store.claimInbox("beta").length, 0);
  assert.equal(store.inbox("beta").length, 1);
  store.close();
});

test("questions remain pending until a reply references them", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "smsagents-")), "test.sqlite"));
  store.registerAgent("alpha", "Alpha");
  store.registerAgent("beta", "Beta");
  store.subscribe("alpha", "t");
  store.subscribe("beta", "t");
  const question = store.publish({ senderId: "alpha", topic: "t", kind: "question", body: "Ready?" }).message;
  assert.equal(store.pendingOutboundQuestions("alpha").length, 1);
  store.publish({ senderId: "beta", topic: "t", kind: "answer", body: "Yes", replyTo: question.id });
  assert.equal(store.pendingOutboundQuestions("alpha").length, 0);
  store.close();
});

test("advertises responsibility scopes and updates them without leaving the topic", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "smsagents-")), "test.sqlite"));
  store.registerAgent("alpha", "Alpha");
  store.registerAgent("beta", "Beta");
  store.subscribe("alpha", "t", ["platform", "release", "platform"]);
  store.subscribe("beta", "t", ["game"]);

  assert.deepEqual(store.status("t").activeScopes, [
    { scope: "game", agentCount: 1 },
    { scope: "platform", agentCount: 1 },
    { scope: "release", agentCount: 1 }
  ]);
  assert.deepEqual(store.status("t").subscribers.find(agent => agent.id === "alpha")?.scopes, ["platform", "release"]);

  store.subscribe("alpha", "t", ["infra"]);
  assert.deepEqual(store.status("t").subscribers.find(agent => agent.id === "alpha")?.scopes, ["infra"]);
  store.subscribe("alpha", "t");
  assert.deepEqual(store.status("t").subscribers.find(agent => agent.id === "alpha")?.scopes, ["infra"]);
  store.close();
});

test("targets messages to a responsibility scope or one topic member", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "smsagents-")), "test.sqlite"));
  for (const id of ["sender", "platform-1", "platform-2", "game", "outsider"]) store.registerAgent(id, id);
  store.subscribe("sender", "t", ["coordination"]);
  store.subscribe("platform-1", "t", ["platform"]);
  store.subscribe("platform-2", "t", ["platform", "release"]);
  store.subscribe("game", "t", ["game"]);

  const scoped = store.publish({ senderId: "sender", topic: "t", body: "Platform question", targetScope: "platform" });
  assert.equal(scoped.recipients, 2);
  assert.equal(scoped.message.targetScope, "platform");
  assert.equal(store.inbox("platform-1")[0]?.id, scoped.message.id);
  assert.equal(store.inbox("platform-2")[0]?.id, scoped.message.id);
  assert.equal(store.inbox("game").length, 0);

  const direct = store.publish({ senderId: "sender", topic: "t", body: "Just you", targetAgentId: "game" });
  assert.equal(direct.recipients, 1);
  assert.equal(direct.message.targetAgentId, "game");
  assert.equal(store.inbox("game")[0]?.id, direct.message.id);

  const outOfTopic = store.publish({ senderId: "sender", topic: "t", body: "No topic bypass", targetAgentId: "outsider" });
  assert.equal(outOfTopic.recipients, 0);
  assert.equal(store.inbox("outsider").length, 0);
  assert.throws(() => store.publish({ senderId: "sender", topic: "t", body: "Ambiguous", targetScope: "platform", targetAgentId: "game" }), /either targetScope or targetAgentId/);
  store.close();
});

test("migrates existing databases for scopes and message targets", () => {
  const path = join(mkdtempSync(join(tmpdir(), "smsagents-")), "old.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, session_id TEXT, metadata TEXT NOT NULL DEFAULT '{}', last_seen_at TEXT NOT NULL);
    CREATE TABLE subscriptions (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, topic TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (agent_id, topic));
    CREATE TABLE messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, topic TEXT NOT NULL, sender_id TEXT NOT NULL REFERENCES agents(id), kind TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT, dedupe_key TEXT, created_at TEXT NOT NULL, expires_at TEXT, UNIQUE(sender_id, topic, dedupe_key));
    CREATE TABLE deliveries (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, delivered_at TEXT, acked_at TEXT, PRIMARY KEY (message_id, agent_id));
  `);
  legacy.close();

  const store = new Store(path);
  store.registerAgent("alpha", "Alpha");
  store.subscribe("alpha", "t", ["platform"]);
  assert.deepEqual(store.status("t").activeScopes, [{ scope: "platform", agentCount: 1 }]);
  assert.equal(store.publish({ senderId: "alpha", topic: "t", body: "direct", targetAgentId: "alpha" }).message.targetAgentId, "alpha");
  store.close();
});
