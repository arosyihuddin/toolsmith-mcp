import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import "../../control-plane/db";
import { registerTools } from "./tools";
import { registerUpstreamTools } from "./tools/upstream.js";

export async function createServer() {
  const server = new McpServer({ name: "toolsmith-mcp-server", version: "0.1.0" });
  await registerTools(server);
  // Upstream servers that fail to connect are logged and skipped;
  // they never fail server creation.
  await registerUpstreamTools(server);
  return server;
}
