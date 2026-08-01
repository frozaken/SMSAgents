import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server supports a two-agent exchange", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist", "server.js")],
    env: { ...process.env, SMSAGENTS_DB_PATH: join(mkdtempSync(join(tmpdir(), "smsagents-mcp-")), "test.sqlite") } as Record<string, string>
  });
  const client = new Client({ name: "smsagents-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
      "ack_messages", "check_inbox", "join_topic", "leave_topic", "register_agent", "send_message", "topic_status"
    ]);
    for (const id of ["alpha", "beta"]) {
      await client.callTool({ name: "register_agent", arguments: { agent_id: id, name: id } });
      await client.callTool({ name: "join_topic", arguments: { agent_id: id, topic: "repo:e2e" } });
    }
    const sent = await client.callTool({ name: "send_message", arguments: { agent_id: "alpha", topic: "repo:e2e", kind: "question", body: "Ready?" } });
    assert.equal(sent.isError, undefined);
    const inbox = await client.callTool({ name: "check_inbox", arguments: { agent_id: "beta" } });
    const result = inbox.structuredContent as { messages: Array<{ body: string }> };
    assert.equal(result.messages[0]?.body, "Ready?");

  } finally {
    await client.close();
  }
});
