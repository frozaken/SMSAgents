import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";

type Runtime = "claude" | "codex";

function runtimeEnv(runtime: Runtime, dbPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SMSAGENTS_DB_PATH: dbPath };
  delete env.CLAUDECODE;
  if (runtime === "claude") env.CLAUDECODE = "1";
  return env;
}

const identity = (runtime: Runtime, sessionId: string) =>
  `${runtime}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;

for (const runtime of ["claude", "codex"] as const) {
  test(`session hook emits a stable ${runtime} agent identity`, () => {
    const data = mkdtempSync(join(tmpdir(), "smsagents-hook-"));
    const result = spawnSync(process.execPath, ["dist/hook.js"], {
      input: JSON.stringify({ session_id: "session-123", cwd: "/tmp/project", hook_event_name: "SessionStart" }),
      encoding: "utf8", env: runtimeEnv(runtime, join(data, "test.sqlite"))
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, new RegExp(identity(runtime, "session-123")));
  });
}

test("PostToolUse injects a newly claimed message exactly once", () => {
  const data = mkdtempSync(join(tmpdir(), "smsagents-hook-"));
  const dbPath = join(data, "test.sqlite");
  const sessionId = "receiver-session";
  const receiverId = identity("claude", sessionId);
  const store = new Store(dbPath);
  store.registerAgent("sender", "Sender");
  store.registerAgent(receiverId, "Receiver", sessionId);
  store.subscribe("sender", "t");
  store.subscribe(receiverId, "t");
  store.publish({ senderId: "sender", topic: "t", body: "new finding" });
  store.close();
  const input = JSON.stringify({ session_id: sessionId, cwd: "/tmp/project", hook_event_name: "PostToolUse" });
  const env = runtimeEnv("claude", dbPath);
  const first = spawnSync(process.execPath, ["dist/hook.js"], { input, encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /new finding/);
  const second = spawnSync(process.execPath, ["dist/hook.js"], { input, encoding: "utf8", env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "");
});

test("oversized deliveries are clamped below the context limit", () => {
  const data = mkdtempSync(join(tmpdir(), "smsagents-hook-"));
  const dbPath = join(data, "test.sqlite");
  const sessionId = "clamp-session";
  const receiverId = identity("claude", sessionId);
  const store = new Store(dbPath);
  store.registerAgent("sender", "Sender");
  store.registerAgent(receiverId, "Receiver", sessionId);
  store.subscribe("sender", "t");
  store.subscribe(receiverId, "t");
  store.publish({ senderId: "sender", topic: "t", body: "x".repeat(11999) });
  store.close();
  const result = spawnSync(process.execPath, ["dist/hook.js"], {
    input: JSON.stringify({ session_id: sessionId, hook_event_name: "PostToolUse" }),
    encoding: "utf8", env: runtimeEnv("claude", dbPath)
  });
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.ok(context.length <= 4000, `context length ${context.length} exceeds limit`);
  assert.match(context, /truncated; use check_inbox/);
});

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime} active Stop guard still continues for fresh messages`, () => {
    const data = mkdtempSync(join(tmpdir(), "smsagents-hook-"));
    const dbPath = join(data, "test.sqlite");
    const sessionId = `${runtime}-active-stop-session`;
    const receiverId = identity(runtime, sessionId);
    const store = new Store(dbPath);
    store.registerAgent("sender", "Sender");
    store.registerAgent(receiverId, "Receiver", sessionId);
    store.subscribe("sender", "t");
    store.subscribe(receiverId, "t");
    store.publish({ senderId: "sender", topic: "t", body: "deliver me later" });
    store.close();

    const result = spawnSync(process.execPath, ["dist/hook.js"], {
      input: JSON.stringify({ session_id: sessionId, hook_event_name: "Stop", stop_hook_active: true }),
      encoding: "utf8", env: runtimeEnv(runtime, dbPath)
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /deliver me later/);

    const reopened = new Store(dbPath);
    assert.equal(reopened.claimInbox(receiverId).length, 0);
    assert.equal(reopened.inbox(receiverId)[0]?.body, "deliver me later");
    reopened.close();
  });

  test(`${runtime} active Stop guard does not re-arm an outbound-question wait`, () => {
    const data = mkdtempSync(join(tmpdir(), "smsagents-hook-"));
    const dbPath = join(data, "test.sqlite");
    const sessionId = `${runtime}-active-wait-session`;
    const waitingId = identity(runtime, sessionId);
    const store = new Store(dbPath);
    store.registerAgent(waitingId, "Waiting", sessionId);
    store.registerAgent("responder", "Responder");
    store.subscribe(waitingId, "t");
    store.subscribe("responder", "t");
    store.publish({ senderId: waitingId, topic: "t", kind: "question", body: "Ready?" });
    store.close();

    const started = Date.now();
    const result = spawnSync(process.execPath, ["dist/hook.js"], {
      input: JSON.stringify({ session_id: sessionId, hook_event_name: "Stop", stop_hook_active: true }),
      encoding: "utf8", env: { ...runtimeEnv(runtime, dbPath), SMSAGENTS_LISTEN_SECONDS: "2" }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.ok(Date.now() - started < 1000, "active Stop guard unexpectedly re-armed the wait");
  });
}

test("Stop listener wakes when an expected reply arrives", async () => {
  const data = mkdtempSync(join(tmpdir(), "smsagents-hook-"));
  const dbPath = join(data, "test.sqlite");
  const sessionId = "waiting-session";
  const waitingId = identity("claude", sessionId);
  const store = new Store(dbPath);
  store.registerAgent(waitingId, "Waiting", sessionId);
  store.registerAgent("responder", "Responder");
  store.subscribe(waitingId, "t");
  store.subscribe("responder", "t");
  const question = store.publish({ senderId: waitingId, topic: "t", kind: "question", body: "Ready?" }).message;

  const child = spawn(process.execPath, ["dist/hook.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...runtimeEnv("claude", dbPath), SMSAGENTS_LISTEN_SECONDS: "2" }
  });
  child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: "/tmp/project", hook_event_name: "Stop", stop_hook_active: false }));
  await new Promise(resolve => setTimeout(resolve, 150));
  store.publish({ senderId: "responder", topic: "t", kind: "answer", body: "Yes", replyTo: question.id });
  store.close();

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number | null>(resolve => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  const output = JSON.parse(stdout);
  assert.equal(output.decision, "block");
  assert.match(output.reason, /Yes/);
});
