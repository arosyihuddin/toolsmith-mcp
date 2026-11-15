/**
 * Dashboard API for upstream (external) MCP servers.
 * Follows the pattern of tools-api.ts. All routes run behind the
 * dashboard Bearer <redacted> (authorizeHttpRequest in app.ts).
 * Secret values are never returned: see store.toPublic().
 */
import { getToolPermission, setToolPermission, permissionModes, customRules, type PermissionMode } from "../../control-plane/tools/permissions.js";
import { isToolExposed, setToolExposed } from "../../control-plane/tools/exposure.js";
import { isCustomPermissionRule, normalizeCustomPermissionRule } from "../../control-plane/tools/custom-rules.js";
import { validateCustomRuleFields } from "../../control-plane/tools/input-schema.js";
import { connectUpstream } from "../mcp/upstream/client.js";
import { upstreamManager } from "../mcp/upstream/manager.js";
import { getLiveServer, hideServerTools, registerServerTools, showServerTools } from "../mcp/tools/upstream.js";
import {
  createServer,
  deleteServer,
  getServerConfig,
  getServerPublic,
  listCachedTools,
  listServersPublic,
  updateServer,
} from "../mcp/upstream/store.js";
import { exposedToolName, riskForTool } from "../mcp/upstream/naming.js";
import { validateUpstreamServerInput } from "../mcp/upstream/types.js";

function noStore(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function errorResponse(error: unknown, status = 400): Response {
  return Response.json(
    { error: error instanceof Error ? error.message : "Unable to complete upstream request" },
    { status },
  );
}

async function refreshRegistration(serverId: string): Promise<void> {
  const live = getLiveServer();
  if (live) await registerServerTools(live, serverId);
}

export async function handleUpstreamApi(request: Request, url: URL): Promise<Response | null> {
  // POST /api/upstream/:id/test — test a connection without saving it.
  const testMatch = url.pathname.match(/^\/api\/upstream\/([^/]+)\/test$/);
  if (testMatch && request.method === "POST") {
    try {
      const body: unknown = await request.json();
      const { config, authSecret } = validateUpstreamServerInput(body);
      const connection = await connectUpstream(config, { authSecret });
      try {
        return noStore({
          serverInfo: { name: connection.serverName, version: connection.serverVersion },
          tools: connection.tools,
        });
      } finally {
        await connection.close();
      }
    } catch (error) {
      return errorResponse(error, error instanceof Error && /must be|Unknown|Invalid/i.test(error.message) ? 400 : 502);
    }
  }

  // PATCH /api/upstream/:id/tools/:tool — exposed / permission per upstream tool.
  const toolMatch = url.pathname.match(/^\/api\/upstream\/([^/]+)\/tools\/(.+)$/);
  if (toolMatch && request.method === "PATCH") {
    try {
      const serverId = decodeURIComponent(toolMatch[1]!);
      const toolName = decodeURIComponent(toolMatch[2]!);
      const cached = listCachedTools(serverId).find((tool) => tool.name === toolName);
      if (!cached) return noStore({ error: "Unknown upstream tool" }, 404);
      const exposed = exposedToolName(serverId, toolName);
      const body = (await request.json()) as {
        exposed?: unknown;
        permission?: unknown;
        customRule?: unknown;
      };
      if (body.exposed !== undefined) {
        if (typeof body.exposed !== "boolean") throw new Error("exposed must be a boolean");
        setToolExposed(exposed, body.exposed);
      }
      if (body.permission !== undefined || body.customRule !== undefined) {
        if (
          body.permission !== undefined &&
          body.permission !== null &&
          !permissionModes.includes(body.permission as PermissionMode)
        )
          throw new Error("Invalid permission mode");
        if (
          body.customRule !== undefined &&
          !(isCustomPermissionRule(body.customRule) ||
            (typeof body.customRule === "string" && customRules.includes(body.customRule)))
        )
          throw new Error("Invalid custom permission rule");
        if (body.customRule !== undefined) {
          const fieldError = validateCustomRuleFields(normalizeCustomPermissionRule(body.customRule), [exposed]);
          if (fieldError) throw new Error(fieldError);
        }
        setToolPermission(
          exposed,
          body.permission as PermissionMode | null,
          body.customRule === undefined ? undefined : normalizeCustomPermissionRule(body.customRule),
        );
      }
      if (body.exposed === undefined && body.permission === undefined && body.customRule === undefined)
        throw new Error("No tool setting provided");
      const permission = getToolPermission(exposed, riskForTool(cached.annotations));
      return noStore({
        tool: { name: cached.name, exposedName: exposed, exposed: isToolExposed(exposed), ...permission },
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  // POST /api/upstream/:id/reconnect
  const reconnectMatch = url.pathname.match(/^\/api\/upstream\/([^/]+)\/reconnect$/);
  if (reconnectMatch && request.method === "POST") {
    try {
      const serverId = decodeURIComponent(reconnectMatch[1]!);
      if (!getServerConfig(serverId)) return noStore({ error: "Unknown upstream server" }, 404);
      await upstreamManager.reconnect(serverId);
      await refreshRegistration(serverId);
      return noStore({ server: getServerPublic(serverId) });
    } catch (error) {
      return errorResponse(error, 502);
    }
  }

  // GET / POST / PATCH / DELETE /api/upstream/:id
  const serverMatch = url.pathname.match(/^\/api\/upstream\/([^/]+)$/);
  if (serverMatch) {
    const serverId = decodeURIComponent(serverMatch[1]!);
    if (request.method === "GET") {
      const server = getServerPublic(serverId);
      if (!server) return noStore({ error: "Unknown upstream server" }, 404);
      const tools = listCachedTools(serverId).map((tool) => {
        const exposed = exposedToolName(serverId, tool.name);
        return {
          name: tool.name,
          exposedName: exposed,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
          exposed: isToolExposed(exposed),
          ...getToolPermission(exposed, riskForTool(tool.annotations)),
        };
      });
      return noStore({ server, tools });
    }
    if (request.method === "PATCH") {
      try {
        const wasConnected = upstreamManager.isConnected(serverId);
        const body = (await request.json()) as Record<string, unknown>;
        const server = updateServer(serverId, body);
        if (!server.enabled) {
          await upstreamManager.disconnect(serverId);
          hideServerTools(serverId);
        } else if (wasConnected) {
          await upstreamManager.reconnect(serverId);
          await refreshRegistration(serverId);
        } else if (body.enabled === true) {
          await refreshRegistration(serverId);
          showServerTools(serverId);
        }
        return noStore({ server: getServerPublic(serverId) });
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === "DELETE") {
      try {
        hideServerTools(serverId);
        await upstreamManager.disconnect(serverId);
        if (!deleteServer(serverId)) return noStore({ error: "Unknown upstream server" }, 404);
        return noStore({ deleted: true, id: serverId });
      } catch (error) {
        return errorResponse(error);
      }
    }
    return null;
  }

  // GET /api/upstream
  if (url.pathname === "/api/upstream" && request.method === "GET") {
    return noStore({ servers: listServersPublic() });
  }

  // POST /api/upstream — create and connect immediately when enabled.
  if (url.pathname === "/api/upstream" && request.method === "POST") {
    try {
      const body: unknown = await request.json();
      const server = createServer(body);
      if (server.enabled) await refreshRegistration(server.id);
      return noStore({ server: getServerPublic(server.id) }, 201);
    } catch (error) {
      return errorResponse(error);
    }
  }

  return null;
}
