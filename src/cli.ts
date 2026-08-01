#!/usr/bin/env node
import { Store } from "./store.js";

const [command, ...args] = process.argv.slice(2);
const store = new Store();
try {
  if (command === "inbox") console.log(JSON.stringify(store.inbox(args[0]!, { limit: Number(args[1] ?? 50) }), null, 2));
  else if (command === "status") console.log(JSON.stringify(store.status(args[0]!), null, 2));
  else if (command === "ack") console.log(JSON.stringify({ acknowledged: store.ack(args[0]!, args.slice(1)) }));
  else {
    console.error("Usage: smsagents <inbox AGENT_ID [LIMIT] | status TOPIC | ack AGENT_ID MESSAGE_ID...>");
    process.exitCode = 2;
  }
} finally { store.close(); }
