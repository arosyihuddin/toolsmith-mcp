/** Types and boundary validation for upstream (external) MCP servers.
 *
 * An upstream server is an MCP server that Toolsmith connects to as a
 * client and whose tools it re-exposes through its own MCP endpoint.
 * Fase 1 supports stdio (FigCraft) and Streamable HTTP transports.
 */

import { accessSync, constants as fsConstants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

export type UpstreamTransport = "stdio" | "streamable-http";
export type UpstreamAuthType = "none" | "bearer" | "api-key";
export type UpstreamServerStatus = "connected" | "down" | "disabled" | "error";

export interface UpstreamServerConfig {
  id: string;
  name: string;
  transport: UpstreamTransport;
  /** stdio: absolute path of the executable (bare names are resolved at validation time). */
  command?: string;
  /** stdio: argv passed to the executable (no shell). */
  args: string[];
  /** stdio: extra environment variables (values may be secrets). */
  env: Record<string, string>;
  cwd?: string;
  /** streamable-http: server URL. */
  url?: string;
  authType: UpstreamAuthType;
  /** streamable-http: extra headers (values may be secrets). */
  headers: Record<string, string>;
  /** FigCraft: folders the agent may read from. */
  readRoots: string[];
  /** FigCraft: folders the agent may write to. Empty = writes denied. */
  writeRoots: string[];
  timeoutMs: number;
  enabled: boolean;
}

export interface UpstreamToolInfo {
  name: string;
  description?: string;
  /** Raw JSON Schema object as reported by the upstream server. */
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface UpstreamServerPublic {
  id: string;
  name: string;
  transport: UpstreamTransport;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  authType: UpstreamAuthType;
  /** Secret values are never returned: only whether one is stored. */
  hasAuthSecret: boolean;
  hasEnvSecrets: boolean;
  readRoots: string[];
  writeRoots: string[];
  timeoutMs: number;
  enabled: boolean;
  status: UpstreamServerStatus;
  lastError?: string | null;
  toolCount: number;
  createdAt: string;
  updatedAt: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Derive a server id from a display name: lowercase, non-alphanumeric
 * runs become one dash, leading/trailing dashes are dropped, max 64
 * characters. Empty result falls back to "server". Mirrored by the
 * Console form preview (UpstreamForm.svelte `slugify`).
 */
export function slugifyId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "server";
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Directories searched for a bare command name, in order. process PATH
 * comes first, then the usual homes of runtimes on this machine — the
 * Toolsmith server process does not always inherit an interactive
 * shell's PATH (e.g. ~/.bun/bin is often missing), so those are added
 * explicitly. Directories under /tmp are skipped: Bun exposes a
 * throwaway `node` shim there (/tmp/bun-node-.../node) that must never
 * be picked up.
 */
export function commandSearchDirs(): string[] {
  const home = homedir();
  const dirs = [
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    join(home, ".toolsmith", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  try {
    const nvmDir = join(home, ".nvm", "versions", "node");
    for (const entry of readdirSync(nvmDir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(nvmDir, entry.name, "bin"));
    }
  } catch {
    // No nvm installs — fine.
  }
  return [...new Set(dirs.filter((dir) => !dir.startsWith("/tmp/")))];
}

/**
 * Resolve a stdio command to the absolute path that will be spawned.
 * A bare name (`bun`, `npx`, `node`) is looked up in PATH plus the
 * common runtime locations above; an absolute path is used as-is after
 * checking it exists and is executable; a relative path is resolved
 * against the server's working directory. Throws with a plain message
 * when nothing usable is found. The resolved absolute path is what
 * gets stored, so spawning stays deterministic across restarts.
 */
export function resolveCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0)
    throw new Error("command must be a non-empty string for stdio transport");
  if (trimmed.startsWith("/")) {
    if (!isExecutableFile(trimmed))
      throw new Error(
        `command '${trimmed}' tidak ditemukan atau bukan executable — periksa path absolutnya`,
      );
    return trimmed;
  }
  if (trimmed.includes("/")) {
    const abs = resolvePath(process.cwd(), trimmed);
    if (!isExecutableFile(abs))
      throw new Error("command must be an absolute path for stdio transport");
    return abs;
  }
  for (const dir of commandSearchDirs()) {
    const candidate = join(dir, trimmed);
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new Error(
    `command '${trimmed}' tidak ditemukan di PATH — install dulu atau isi path absolut`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(field + " must be an array of strings");
  return [...value];
}

function asStringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value))
    throw new Error(field + " must be an object of string values");
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string")
      throw new Error(field + " must be an object of string values");
    out[key] = item;
  }
  return out;
}

function asAbsolutePaths(value: unknown, field: string): string[] {
  const paths = asStringArray(value, field);
  for (const path of paths) {
    if (!path.startsWith("/"))
      throw new Error(field + " must contain absolute paths only: " + path);
  }
  return paths;
}

/**
 * Validate an untrusted upstream-server payload (dashboard API input)
 * and return a normalized config. Throws with a plain message on
 * invalid input. `authSecret` / `env` values are returned as-is here;
 * the store encrypts them before persisting.
 */
export function validateUpstreamServerInput(input: unknown): {
  config: UpstreamServerConfig;
  authSecret?: string;
} {
  if (!isRecord(input)) throw new Error("Upstream server must be an object");
  const name = input.name;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 120)
    throw new Error("name must be a non-empty string up to 120 characters");
  // `id` is optional: when omitted or empty it is derived from `name`.
  // A manually supplied id (older API clients) still follows the old pattern.
  const rawId = input.id;
  const id =
    rawId === undefined ||
    rawId === null ||
    (typeof rawId === "string" && rawId.trim() === "")
      ? slugifyId(name)
      : rawId;
  if (typeof id !== "string" || !ID_PATTERN.test(id))
    throw new Error(
      "id must be lowercase letters, digits and dashes, starting with a letter or digit",
    );
  const transport = input.transport;
  if (transport !== "stdio" && transport !== "streamable-http")
    throw new Error("transport must be 'stdio' or 'streamable-http'");
  const timeoutMs =
    input.timeoutMs === undefined ? 30000 : input.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000)
    throw new Error("timeoutMs must be an integer between 1000 and 120000");
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean")
    throw new Error("enabled must be a boolean");

  const base: UpstreamServerConfig = {
    id,
    name: name.trim(),
    transport,
    args: [],
    env: {},
    headers: {},
    readRoots: [],
    writeRoots: [],
    timeoutMs,
    enabled,
    authType: "none",
  };
  let authSecret: string | undefined;
  if (transport === "stdio") {
    const command = input.command;
    if (typeof command !== "string")
      throw new Error("command must be a string for stdio transport");
    base.command = resolveCommand(command);
    base.args = asStringArray(input.args, "args");
    base.env = asStringRecord(input.env, "env");
    if (input.cwd !== undefined) {
      if (typeof input.cwd !== "string" || !input.cwd.startsWith("/"))
        throw new Error("cwd must be an absolute path");
      base.cwd = input.cwd;
    }
    base.readRoots = asAbsolutePaths(input.readRoots, "readRoots");
    base.writeRoots = asAbsolutePaths(input.writeRoots, "writeRoots");
  } else {
    const url = input.url;
    if (typeof url !== "string")
      throw new Error("url must be a string for streamable-http transport");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("url must be a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("url must use http:// or https://");
    base.url = url;
    const authType = input.authType === undefined ? "none" : input.authType;
    if (authType !== "none" && authType !== "bearer" && authType !== "api-key")
      throw new Error("authType must be 'none', 'bearer' or 'api-key'");
    base.authType = authType;
    base.headers = asStringRecord(input.headers, "headers");
    if (input.authSecret !== undefined) {
      if (typeof input.authSecret !== "string" || input.authSecret.length === 0)
        throw new Error("authSecret must be a non-empty string");
      authSecret = input.authSecret;
    }
  }
  return { config: base, authSecret };
}
