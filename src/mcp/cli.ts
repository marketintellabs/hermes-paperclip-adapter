#!/usr/bin/env node
/**
 * paperclip-mcp — stdio MCP server exposing Paperclip as structured tools.
 *
 * Launched by Hermes via ~/.hermes/config.yaml:
 *
 *   mcp_servers:
 *     paperclip:
 *       command: node
 *       args: ["/app/node_modules/@marketintellabs/hermes-paperclip-adapter/dist/mcp/cli.js"]
 *       env:
 *         PAPERCLIP_API_URL: "http://localhost:3100"
 *         PAPERCLIP_API_KEY: "..."
 *         PAPERCLIP_AGENT_ID: "..."
 *         PAPERCLIP_COMPANY_ID: "..."
 *
 * The adapter (`@marketintellabs/hermes-paperclip-adapter/server` → execute.ts)
 * is responsible for writing that config block before it spawns hermes.
 */

import { runStdioServer } from "./server.js";

runStdioServer().catch((err) => {
  process.stderr.write(
    `[paperclip-mcp] fatal: ${(err as Error)?.stack ?? String(err)}\n`,
  );
  process.exit(1);
});
