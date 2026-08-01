import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("session hook emits a stable agent identity", () => {
  const data = mkdtempSync(join(tmpdir(), "smsagents-hook-"));
  const result = spawnSync(process.execPath, ["dist/hook.js"], {
    input: JSON.stringify({ session_id: "session-123", cwd: "/tmp/project", hook_event_name: "SessionStart" }),
    encoding: "utf8", env: { ...process.env, PLUGIN_DATA: data }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /SMSAgents agent_id|SMSAgents agent_id is|Your SMSAgents agent_id/);
});
