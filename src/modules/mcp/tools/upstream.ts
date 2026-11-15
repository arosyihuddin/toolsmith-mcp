/**
 * Re-expose upstream MCP tools through Toolsmith's own MCP server.
 *
 * Every upstream tool is registered with registerExposedTool(), the
 * single enforcement point: exposure, permission, custom rules,
 * approval and call logging apply exactly as for local tools.
 * Nothing here bypasses that wrapper.
 *
 * Tool names are prefixed `<server>__<tool>` (see upstream/naming).
 * Read-only upstream tools are low risk (always_allow by default);
 * mutating tools are medium risk (require_approval by default,
 * via the edit_delete section default).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { setToolExposed } from "../../../control-plane/tools/exposure.js";
import { logger } from "../../../lib/logger.js";
import { upstreamManager } from "../upstream/manager.js";
import { jsonSchemaToZodShape } from "../upstream/schema.js";
import { listCachedTools } from "../upstream/store.js";
import { exposedToolName } from "../upstream/naming.js";
import { errorMessage, errorResult } from "./shared.js";
import { registerExposedTool } from "./register.js";

const registeredByServer = new WeakMap<McpServer, Set<string>>();
let liveServer: McpServer | null = null;

export function getLiveServer(): McpServer | null {
  return liveServer;
}

function registeredNames(server: McpServer): Set<string> {
  let names = registeredByServer.get(server);
  if (!names) {
    names = new Set<string>();
    registeredByServer.set(server, names);
  }
  return names;
}

function registerOneTool(server: McpServer, serverId: string, toolName: string): void {
  const exposed = exposedToolName(serverId, toolName);
  const names = registeredNames(server);
  if (names.has(exposed)) return;
  const cached = listCachedTools(serverId).find((tool) => tool.name === toolName);
  if (!cached) return;
  const annotations = cached.annotations ?? {};
  registerExposedTool(
    server,
    exposed,
    {
      title: annotations.title ?? toolName,
      description: "[" + serverId + "] " + (cached.description ?? toolName),
      inputSchema: jsonSchemaToZodShape(cached.inputSchema),
      annotations: {
        title: annotations.title,
        readOnlyHint: annotations.readOnlyHint ?? false,
        destructiveHint: annotations.destructiveHint ?? false,
        idempotentHint: annotations.idempotentHint ?? false,
        openWorldHint: annotations.openWorldHint ?? false,
      },
    },
    async (args) => {
      try {
        const result = await upstreamManager.callTool(
          serverId,
          toolName,
          (args ?? {}) as Record<string, unknown>,
        );
        if (result.content.length > 0) {
          return {
            content: result.content as CallToolResult["content"],
            ...(result.isError ? { isError: true as const } : {}),
          };
        }
        if (result.structuredContent !== undefined) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
          };
        }
        return { content: [{ type: "text" as const, text: "{}" }] };
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    },
  );
  names.add(exposed);
}

/**
 * Connect one enabled upstream server and register its tools on
 * `server`. Failures are logged and swallowed: a dead upstream
 * must never fail Toolsmith startup or another server.
 */
export async function registerServerTools(server: McpServer, serverId: string): Promise<void> {
  try {
    const connection = await upstreamManager.connect(serverId);
    for (const tool of connection.tools) registerOneTool(server, serverId, tool.name);
  } catch (error) {
    logger.warn(
      { server: serverId, error: errorMessage(error) },
      "Upstream MCP server unavailable, its tools were not registered",
    );
  }
}

/**
 * Startup registration: remember the live server (so the dashboard
 * API can register tools for servers added later) and register the
 * tools of every enabled upstream server that connects.
 */
export async function registerUpstreamTools(server: McpServer): Promise<void> {
  liveServer = server;
  const { connected } = await upstreamManager.connectEnabled();
  for (const serverId of connected) {
    const connection = upstreamManager.getConnection(serverId);
    if (!connection) continue;
    for (const tool of connection.tools) registerOneTool(server, serverId, tool.name);
  }
}

/** Hide a server's tools from tools/list (keeps the registration). */
export function hideServerTools(serverId: string): void {
  for (const tool of listCachedTools(serverId))
    setToolExposed(exposedToolName(serverId, tool.name), false);
}

/** Show a server's tools again after hideServerTools(). */
export function showServerTools(serverId: string): void {
  for (const tool of listCachedTools(serverId))
    setToolExposed(exposedToolName(serverId, tool.name), true);
}
