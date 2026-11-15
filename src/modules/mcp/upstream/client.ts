/**
 * MCP client for one upstream server. Fase 1: stdio (FigCraft) is fully
 * supported; Streamable HTTP is implemented with the SDK transport
 * (Bearer / API-key auth) and covered by tests/upstream-http.test.ts
 * (Fase 2) against a local mock MCP server.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { UpstreamServerConfig, UpstreamToolInfo } from "./types.js";

export interface UpstreamCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface UpstreamConnection {
  config: UpstreamServerConfig;
  serverName: string;
  serverVersion?: string;
  tools: UpstreamToolInfo[];
  callTool: (name: string, args: Record<string, unknown>, timeoutMs: number) => Promise<UpstreamCallResult>;
  close: () => Promise<void>;
}

function normalizeTool(raw: unknown): UpstreamToolInfo | null {
  if (raw === null || typeof raw !== "object") return null;
  const tool = raw as Record<string, unknown>;
  if (typeof tool.name !== "string" || tool.name.length === 0) return null;
  const inputSchema =
    tool.inputSchema !== null && typeof tool.inputSchema === "object"
      ? (tool.inputSchema as Record<string, unknown>)
      : {};
  const annotations =
    tool.annotations !== null && typeof tool.annotations === "object"
      ? (tool.annotations as UpstreamToolInfo["annotations"])
      : undefined;
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : undefined,
    inputSchema,
    annotations,
  };
}

/**
 * Turn a low-level SDK failure into a clear, actionable error. The SDK
 * already throws instead of hanging (initialize / listTools / callTool
 * all carry the configured timeout, and a non-2xx HTTP response becomes
 * a StreamableHTTPError), but its message hides the HTTP status and
 * which upstream failed. Keep the original message, prefix it with the
 * server and transport, and spell out the status for 401/404.
 */
function describeUpstreamError(config: UpstreamServerConfig, error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const where =
    config.transport === "streamable-http"
      ? `upstream '${config.id}' (streamable-http ${config.url ?? ""})`
      : `upstream '${config.id}' (stdio ${config.command ?? ""})`;
  if (error instanceof StreamableHTTPError && typeof error.code === "number") {
    const hint =
      error.code === 401
        ? " — upstream menolak auth, periksa token / authSecret server ini"
        : error.code === 404
          ? " — periksa path URL upstream"
          : "";
    return new Error(`${where}: HTTP ${error.code}: ${raw}${hint}`);
  }
  const timeoutHint = /timed out/i.test(raw) ? ` (timeout ${config.timeoutMs}ms)` : "";
  return new Error(`${where}: ${raw}${timeoutHint}`);
}

/**
 * Connect to one upstream server and list its tools.
 * `authSecret` is the decrypted Bearer / API-key secret, if any.
 * Throws on connect / list failure; the caller decides whether to
 * mark the server down (startup must never fail because of this).
 * A failure after connect never leaks a half-open connection: the
 * client is closed (and an HTTP session terminated) before rethrowing.
 */
export async function connectUpstream(
  config: UpstreamServerConfig,
  options: { authSecret?: string } = {},
): Promise<UpstreamConnection> {
  const timeoutMs = config.timeoutMs;
  const client = new Client(
    { name: "toolsmith-upstream", version: "0.4.0" },
    { capabilities: {} },
  );
  let httpTransport: StreamableHTTPClientTransport | undefined;
  const closeHalfOpen = async (): Promise<void> => {
    // End the HTTP session explicitly first: client.close() alone only
    // aborts the local transport, it never sends the DELETE that tells
    // a Streamable HTTP server the session is over. Best effort — a
    // server that answers 405 (stateless / no termination support) is
    // fine, the session just expires on its side.
    if (httpTransport) {
      try {
        await httpTransport.terminateSession();
      } catch {
        // Ignore: the session expires server-side on its own.
      }
    }
    try {
      await client.close();
    } catch {
      // Ignore: already closed / never connected.
    }
  };
  try {
    if (config.transport === "stdio") {
      if (!config.command) throw new Error(`stdio upstream '${config.id}' has no command`);
      // FigCraft automation confinement flags. They are only appended
      // when roots are configured; a generic stdio server with no
      // roots configured gets no extra arguments at all.
      const args = [...config.args];
      for (const root of config.readRoots) args.push("--automation-read-root", root);
      for (const root of config.writeRoots) args.push("--automation-write-root", root);
      const transport = new StdioClientTransport({
        command: config.command,
        args,
        env: { ...getDefaultEnvironment(), ...config.env },
        cwd: config.cwd,
        // FigCraft prints a startup banner to stderr; keep it out of
        // Toolsmith's logs. Upstream failures still surface as errors.
        stderr: "ignore",
      });
      await client.connect(transport, { timeout: timeoutMs });
    } else {
      if (!config.url) throw new Error(`streamable-http upstream '${config.id}' has no url`);
      const headers: Record<string, string> = { ...config.headers };
      // Drop any user-supplied Authorization / x-api-key header first:
      // header names are case-insensitive, so keeping both "Authorization"
      // (from headers) and "authorization" (from authSecret) would send a
      // duplicate. The configured authSecret always wins.
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === "authorization" || lower === "x-api-key") delete headers[key];
      }
      if (options.authSecret) {
        if (config.authType === "bearer") headers.authorization = "Bearer " + options.authSecret;
        else if (config.authType === "api-key") headers["x-api-key"] = options.authSecret;
      }
      httpTransport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers },
      });
      await client.connect(httpTransport, { timeout: timeoutMs });
    }
    const version = client.getServerVersion();
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    const tools = (listed.tools ?? [])
      .map(normalizeTool)
      .filter((tool): tool is UpstreamToolInfo => tool !== null);
    return {
      config,
      serverName: version?.name ?? config.id,
      serverVersion: version?.version,
      tools,
      callTool: async (name, args, callTimeoutMs) => {
        try {
          const result = await client.callTool(
            { name, arguments: args },
            undefined,
            { timeout: callTimeoutMs },
          );
          const out: UpstreamCallResult = {
            content: (result.content ?? []) as UpstreamCallResult["content"],
            structuredContent: (result as { structuredContent?: Record<string, unknown> }).structuredContent,
            isError: result.isError === true,
          };
          return out;
        } catch (error) {
          throw describeUpstreamError(config, error);
        }
      },
      close: async () => {
        await closeHalfOpen();
      },
    };
  } catch (error) {
    await closeHalfOpen();
    throw describeUpstreamError(config, error);
  }
}
