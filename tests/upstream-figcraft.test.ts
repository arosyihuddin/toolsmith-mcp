/**
 * Fase 1 integration test: real FigCraft 0.8.0 over stdio, proxied
 * through an isolated Toolsmith instance (own port, own DATA_DIR,
 * own config file — the running Toolsmith 0.4.0 install and its
 * production database are never touched).
 *
 * Write tools are never executed here. open_file only opens a COPY
 * of a .figcraft file inside a temp read root; no write root is
 * configured, so FigCraft itself refuses writes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const port = 3102;
const endpoint = `http://127.0.0.1:${port}/mcp`;
const apiToken = "test-upstream-token";
const sudoKey = "0123456789abcdef".repeat(4); // 64 chars, test only

const workDir = mkdtempSync(join(tmpdir(), "toolsmith-upstream-test-"));
const dataDir = join(workDir, "data");
const figDir = join(workDir, "figcraft");
const configFile = join(workDir, "config.yml");
const figCopy = join(figDir, "Test-copy.figcraft");

let serverProcess: ReturnType<typeof Bun.spawn> | undefined;

const FIGCRAFT = {
  id: "figcraft",
  name: "FigCraft",
  transport: "stdio",
  command: "/home/era/Applications/figcraft-0.8.0-linux-x86_64.AppImage",
  args: ["cli", "mcp"],
  readRoots: [figDir],
  writeRoots: [],
};

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
  const client = new Client({ name: "toolsmith-upstream-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${apiToken}` } },
  });
  await client.connect(transport);
  return client;
}

beforeAll(() => {
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
  mkdirSync(figDir, { recursive: true });
  copyFileSync("/home/era/Downloads/Test.figcraft", figCopy);
  spawnServer();
});

afterAll(() => {
  serverProcess?.kill();
  rmSync(workDir, { recursive: true, force: true });
});

describe("upstream FigCraft via isolated Toolsmith", () => {
  test("rejects an invalid upstream config", async () => {
    await waitForServer();
    const bad = await api("/api/upstream", {
      method: "POST",
      body: JSON.stringify({ ...FIGCRAFT, command: "figcraft" }),
    });
    expect(bad.status).toBe(400);
    const list = await api("/api/upstream");
    expect(list.status).toBe(200);
    expect(list.body.servers).toEqual([]);
  }, 60000);

  test("test-connection lists 18 FigCraft tools without saving", async () => {
    const tested = await api("/api/upstream/figcraft/test", {
      method: "POST",
      body: JSON.stringify(FIGCRAFT),
    });
    expect(tested.status).toBe(200);
    expect(tested.body.serverInfo?.name).toBe("figcraft");
    expect(tested.body.serverInfo?.version).toBe("0.8.0");
    expect(tested.body.tools).toHaveLength(18);
    expect(tested.body.tools.map((tool: any) => tool.name)).toContain("list_commands");
    const list = await api("/api/upstream");
    expect(list.body.servers).toEqual([]);
  }, 60000);

  test("creates FigCraft and registers its tools", async () => {
    const created = await api("/api/upstream", { method: "POST", body: JSON.stringify(FIGCRAFT) });
    expect(created.status).toBe(201);
    expect(created.body.server?.status).toBe("connected");
    expect(created.body.server?.toolCount).toBe(18);
    expect(created.body.server?.hasAuthSecret).toBe(false);
    expect("authSecret" in (created.body.server ?? {})).toBe(false);
    const detail = await api("/api/upstream/figcraft");
    expect(detail.status).toBe(200);
    expect(detail.body.tools).toHaveLength(18);
    const byName = new Map<string, any>(detail.body.tools.map((tool: any) => [tool.name, tool] as [string, any]));
    expect(byName.get("create_node")?.permission).toBe("require_approval");
    expect(byName.get("list_commands")?.permission).toBe("always_allow");
    expect(byName.get("inspect_document")?.permission).toBe("always_allow");
    const catalog = await api("/api/tools");
    const upstream = catalog.body.tools.filter((tool: any) => tool.category === "upstream");
    expect(upstream).toHaveLength(18);
    expect(upstream[0]?.group).toBe("FigCraft");
  }, 60000);

  test("lists 46 tools via MCP and calls figcraft__list_commands", async () => {
    const client = await createMcpClient();
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toHaveLength(46);
      expect(names.filter((name) => name.startsWith("figcraft__"))).toHaveLength(18);
      expect(names).toContain("figcraft__list_commands");
      expect(names).toContain("system_info");
      const result = await client.callTool({
        name: "figcraft__list_commands",
        arguments: { filter: "node" },
      });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ text?: string }>).map((item) => item.text ?? "").join("\n");
      expect(text).toContain("node.create");
    } finally {
      await client.close();
    }
  }, 60000);

  test("opens a copied .figcraft file and inspects it", async () => {
    const allowed = await api("/api/upstream/figcraft/tools/open_file", {
      method: "PATCH",
      body: JSON.stringify({ permission: "always_allow" }),
    });
    expect(allowed.status).toBe(200);
    const client = await createMcpClient();
    try {
      const opened = await client.callTool({
        name: "figcraft__open_file",
        arguments: { path: figCopy },
      });
      expect(opened.isError).not.toBe(true);
      const inspected = await client.callTool({ name: "figcraft__inspect_document", arguments: {} });
      expect(inspected.isError).not.toBe(true);
      const text = (inspected.content as Array<{ text?: string }>).map((item) => item.text ?? "").join("\n");
      expect(text).toContain("Test-copy");
    } finally {
      await client.close();
    }
  }, 60000);

  test("survives a restart and can be deleted", async () => {
    serverProcess?.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    spawnServer();
    await waitForServer();
    const client = await createMcpClient();
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("figcraft__list_commands");
      expect(names).toHaveLength(46);
    } finally {
      await client.close();
    }
    const deleted = await api("/api/upstream/figcraft", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    const after = await createMcpClient();
    try {
      const listed = await after.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toHaveLength(28);
      expect(names.some((name) => name.startsWith("figcraft__"))).toBe(false);
    } finally {
      await after.close();
    }
  }, 120000);
});
