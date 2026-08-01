import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("bundled MCP launcher uses plugin-relative paths", () => {
  const config = JSON.parse(readFileSync(".mcp.json", "utf8"));
  const server = config.mcpServers.smsagents;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["./dist/server.js"]);
  assert.equal(server.cwd, ".");
  assert.doesNotMatch(JSON.stringify(server), /PLUGIN_ROOT/);
});
