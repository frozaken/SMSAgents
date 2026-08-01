import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
