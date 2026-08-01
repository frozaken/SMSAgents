import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SHARED_HOOK_EVENTS = ["SessionStart", "SubagentStart", "UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop"];

test("bundled Codex MCP launcher uses plugin-relative paths", () => {
  const config = JSON.parse(readFileSync(".mcp.json", "utf8"));
  const server = config.mcpServers.smsagents;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["./dist/server.js"]);
  assert.equal(server.cwd, ".");
  assert.doesNotMatch(JSON.stringify(server), /PLUGIN_ROOT/);
});

test("Codex manifest still references the relative MCP config", () => {
  const manifest = JSON.parse(readFileSync(".codex-plugin/plugin.json", "utf8"));
  assert.equal(manifest.name, "smsagents");
  assert.equal(manifest.mcpServers, "./.mcp.json");
});

test("Claude Code manifest declares the bundled MCP server via CLAUDE_PLUGIN_ROOT", () => {
  const manifest = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
  assert.equal(manifest.name, "smsagents");
  assert.equal(manifest.skills, "./skills/");
  const server = manifest.mcpServers.smsagents;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"]);
});

test("shared hooks config is valid for both runtimes", () => {
  const config = JSON.parse(readFileSync("hooks/hooks.json", "utf8"));
  assert.deepEqual(Object.keys(config.hooks).sort(), [...SHARED_HOOK_EVENTS].sort());
  for (const [event, matchers] of Object.entries<any>(config.hooks)) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        assert.equal(hook.type, "command");
        assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/hook\.js/, `${event} must launch the bundled hook`);
        assert.doesNotMatch(hook.command, /\$\{PLUGIN_ROOT\}/, "legacy PLUGIN_ROOT variable is Codex-only; use CLAUDE_PLUGIN_ROOT (Codex substitutes both)");
        assert.equal(typeof hook.timeout, "number");
        if (event === "Stop" || event === "SubagentStop") {
          assert.ok(hook.timeout >= 305, `${event} timeout must cover the 300s reply-listen window`);
        }
      }
    }
  }
});

test("repository marketplace exposes the plugin to Claude Code", () => {
  const marketplace = JSON.parse(readFileSync("../../.claude-plugin/marketplace.json", "utf8"));
  assert.equal(marketplace.name, "smsagents");
  const entry = marketplace.plugins.find((p: { name: string }) => p.name === "smsagents");
  assert.ok(entry, "marketplace must list the smsagents plugin");
  assert.equal(entry.source, "./plugins/smsagents");
});
