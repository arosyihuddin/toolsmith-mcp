/**
 * Fase 2 integration test: Streamable HTTP upstream, proxied through an
 * isolated Toolsmith instance (own port, own DATA_DIR, own config file —
 * the running Toolsmith 0.4.0 install and its production database are
 * never touched).
 *
 * The upstream is a mock MCP server built with the same SDK (McpServer
 * + StreamableHTTPServerTransport, JSON mode) served by
 * node:http on 127.0.0.1 with a random port. It enforces Bearer auth at
 * the HTTP layer: any request without the right token gets 401 before
 * the MCP transport ever sees it, so the test really exercises auth in
 * Toolsmith's HTTP client transport. The mock is stateful with one
 * McpServer + transport per MCP session (the SDK's documented pattern:
 * a server transport serves exactly one session — DELETE closes it),
 * so Toolsmith's disconnect really terminates the session: close()
 * sends DELETE and the mock drops the session.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const root = new URL("../", import.meta.url).pathname;
const port = 3103;
const endpoint = `http://127.0.0.1:${port}/mcp`;
const apiToken = "test-upstream-http-token";
const sudoKey = "0123456789abcdef".repeat(4); // 64 chars, test only
const mockToken = "mock-http-secret-token";

const workDir = mkdtempSync(join(tmpdir(), "toolsmith-upstream-http-test-"));
const dataDir = join(workDir, "data");
const configFile = join(workDir, "config.yml");

let serverProcess: ReturnType<typeof Bun.spawn> | undefined;
let mockHttp: Server | undefined;
let mockPort = 0;

function mockServerConfig(authSecret: string) {
  return {
    id: "mock-http",
    name: "Mock HTTP",
    transport: "streamable-http",
    url: `http://127.0.0.1:${mockPort}/mcp`,
    authType: "bearer",
    authSecret,
    timeoutMs: 10000,
  };
}

async function startMockServer(): Promise<number> {
  // One McpServer + transport per MCP session (the SDK's documented
  // stateful pattern). A single server transport serves exactly one
  // session for its whole lifetime: DELETE closes it (_closed=true),
  // so a later initialize on the same transport is answered 404
  // "Session not found". Sessions are tracked by id and dropped when
  // the client terminates them.
  const transports = new Map<string, StreamableHTTPServerTransport>();
  async function createSessionTransport(): Promise<StreamableHTTPServerTransport> {
    const mock = new McpServer({ name: "mock-http", version: "1.0.0" });
    mock.tool(
    "echo_read",
    "Echo a string (read-only)",
    { text: z.string() },
    { readOnlyHint: true },
    async ({ text }) => ({ content: [{ type: "text" as const, text: `read:${text}` }] }),
  );
  mock.tool(
    "echo_write",
    "Echo a string (writes state)",
    { text: z.string() },
    { readOnlyHint: false },
    async ({ text }) => ({ content: [{ type: "text" as const, text: `write:${text}` }] }),
  );
  mock.tool(
    "echo_auth",
    "Echo a string (auth-gated at the HTTP layer)",
    { text: z.string() },
    { readOnlyHint: true },
    async ({ text }) => ({ content: [{ type: "text" as const, text: `auth:${text}` }] }),
  );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true, // plain JSON responses instead of SSE
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
      },
      onsessionclosed: (sessionId) => {
        transports.delete(sessionId);
      },
    });
    await mock.connect(transport);
    return transport;
  }
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.url !== "/mcp") {
        res.writeHead(404).end("not found");
        return;
      }
      // Auth is enforced here, before the MCP transport sees the request.
      if (req.headers.authorization !== `Bearer ${mockToken}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      let body: unknown;
      if (req.method === "POST") {
        const raw = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", (chunk) => {
            data += chunk;
          });
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        body = raw ? JSON.parse(raw) : undefined;
      }
      // Route by session: a request with a known mcp-session-id reuses
      // that session's transport; anything else (initialize, or an
      // unknown session) gets a fresh transport and lets the SDK
      // validate it (400/404 as appropriate).
      const sessionId = req.headers["mcp-session-id"];
      const transport =
        (typeof sessionId === "string" ? transports.get(sessionId) : undefined) ??
        (await createSessionTransport());
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end("mock server error");
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  mockHttp = httpServer;
  return (httpServer.address() as AddressInfo).port;
}

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      const response = await fetch(endpoint, { method: "GET" });
      if (response.status === 401) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Isolated Toolsmith did not start at ${endpoint}`);
}

function spawnServer(): void {
  serverProcess = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      TOOLSMITH_CONFIG: configFile,
      TOOLSMITH_DATA_DIR: dataDir,
      TOOLSMITH_DEFAULT_CWD: root,
      MCP_TRANSPORT: "http",
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_HTTP_PATH: "/mcp",
      MCP_PUBLIC_URL: " ",
      TOOLSMITH_OAUTH_USERNAME: "",
      TOOLSMITH_OAUTH_PASSWORD: "",
      TOOLSMITH_API_TOKEN: apiToken,
      TOOLSMITH_SUDO_ENCRYPTION_KEY: sudoKey,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function createMcpClient(): Promise<Client> {
  const client = new Client({ name: "toolsmith-upstream-http-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${apiToken}` } },
  });
  await client.connect(transport);
  return client;
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((item) => item.text ?? "").join("\n");
}

beforeAll(async () => {
  mockPort = await startMockServer();
  writeFileSync(
    configFile,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      "  path: /mcp",
      "  transport: http",
      "security:",
      `  api_token: ${apiToken}`,
      `  sudo_encryption_key: ${sudoKey}`,
      "logging:",
      "  level: warn",
      "",
    ].join("\n"),
  );
  mkdirSync(dataDir, { recursive: true });
  spawnServer();
});

afterAll(async () => {
  serverProcess?.kill();
  if (mockHttp) await new Promise<void>((resolve) => mockHttp!.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

describe("upstream Streamable HTTP via isolated Toolsmith", () => {
  test("test-connection lists 3 mock tools with the right token, fails with the wrong one", async () => {
    await waitForServer();
    const tested = await api("/api/upstream/mock-http/test", {
      method: "POST",
      body: JSON.stringify(mockServerConfig(mockToken)),
    });
    expect(tested.status).toBe(200);
    expect(tested.body.serverInfo?.name).toBe("mock-http");
    expect(tested.body.serverInfo?.version).toBe("1.0.0");
    expect(tested.body.tools).toHaveLength(3);
    expect(tested.body.tools.map((tool: any) => tool.name).sort()).toEqual([
      "echo_auth",
      "echo_read",
      "echo_write",
    ]);
    // Wrong token: the mock answers 401 at the HTTP layer, so the
    // test-connection must fail instead of returning 200.
    const wrong = await api("/api/upstream/mock-http/test", {
      method: "POST",
      body: JSON.stringify(mockServerConfig("token-yang-salah")),
    });
    expect(wrong.status).not.toBe(200);
    expect(wrong.status).toBe(502);
    expect(String(wrong.body.error ?? "")).toContain("401");
    // Neither attempt saved anything.
    const list = await api("/api/upstream");
    expect(list.body.servers).toEqual([]);
  }, 60000);

  test("creates the HTTP server and registers its tools without leaking the secret", async () => {
    const created = await api("/api/upstream", {
      method: "POST",
      body: JSON.stringify(mockServerConfig(mockToken)),
    });
    expect(created.status).toBe(201);
    expect(created.body.server?.status).toBe("connected");
    expect(created.body.server?.toolCount).toBe(3);
    expect(created.body.server?.transport).toBe("streamable-http");
    expect(created.body.server?.hasAuthSecret).toBe(true);
    expect("authSecret" in (created.body.server ?? {})).toBe(false);
    expect(JSON.stringify(created.body)).not.toContain(mockToken);
  }, 60000);

  test("lists 31 tools via MCP and calls the read-only tools", async () => {
    const client = await createMcpClient();
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toHaveLength(31);
      expect(names.filter((name) => name.startsWith("mock-http__"))).toHaveLength(3);
      expect(names).toContain("mock-http__echo_read");
      expect(names).toContain("mock-http__echo_auth");
      expect(names).toContain("system_info");
      const read = await client.callTool({
        name: "mock-http__echo_read",
        arguments: { text: "halo" },
      });
      expect(read.isError).not.toBe(true);
      expect(toolText(read)).toContain("read:halo");
      const authed = await client.callTool({
        name: "mock-http__echo_auth",
        arguments: { text: "halo" },
      });
      expect(authed.isError).not.toBe(true);
      expect(toolText(authed)).toContain("auth:halo");
    } finally {
      await client.close();
    }
  }, 60000);

  test("write tool defaults to require_approval, then works after always_allow", async () => {
    const detail = await api("/api/upstream/mock-http");
    expect(detail.status).toBe(200);
    expect(detail.body.tools).toHaveLength(3);
    const byName = new Map<string, any>(detail.body.tools.map((tool: any) => [tool.name, tool] as [string, any]));
    expect(byName.get("echo_write")?.permission).toBe("require_approval");
    expect(byName.get("echo_read")?.permission).toBe("always_allow");
    const allowed = await api("/api/upstream/mock-http/tools/echo_write", {
      method: "PATCH",
      body: JSON.stringify({ permission: "always_allow" }),
    });
    expect(allowed.status).toBe(200);
    const client = await createMcpClient();
    try {
      const written = await client.callTool({
        name: "mock-http__echo_write",
        arguments: { text: "halo" },
      });
      expect(written.isError).not.toBe(true);
      expect(toolText(written)).toContain("write:halo");
    } finally {
      await client.close();
    }
  }, 60000);

  test("deletes the server and its tools disappear from tools/list", async () => {
    const deleted = await api("/api/upstream/mock-http", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    const client = await createMcpClient();
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toHaveLength(28);
      expect(names.some((name) => name.startsWith("mock-http__"))).toBe(false);
    } finally {
      await client.close();
    }
  }, 60000);
});
