/**
 * Persistence for upstream servers and their cached tool lists.
 * Secrets (authSecret, env values) are stored encrypted with the same
 * AES-256-GCM mechanism as root-command passwords; the public view
 * never includes secret values, only whether one is stored.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "../../../control-plane/db/index.js";
import {
  upstreamServers,
  upstreamTools,
  type UpstreamServer,
} from "../../../control-plane/db/schema.js";
import { decryptSecret, encryptSecret, isSecretEncryptionConfigured } from "./crypto.js";
import {
  validateUpstreamServerInput,
  type UpstreamServerConfig,
  type UpstreamServerPublic,
  type UpstreamServerStatus,
  type UpstreamToolInfo,
} from "./types.js";

function now(): string {
  return new Date().toISOString();
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function encryptEnv(env: Record<string, string>): string | null {
  if (Object.keys(env).length === 0) return null;
  return encryptSecret(JSON.stringify(env));
}

function decryptEnv(blob: string | null): Record<string, string> {
  if (!blob) return {};
  const parsed = parseJsonObject(decryptSecret(blob));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Decode a DB row into a config. Secrets stay encrypted unless requested. */
function rowToConfig(row: UpstreamServer, decrypt: boolean): UpstreamServerConfig {
  const args = parseJsonArray(row.args);
  const headers = parseJsonObject(row.headers);
  const headerStrings: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") headerStrings[key] = value;
  }
  return {
    id: row.id,
    name: row.name,
    transport: row.transport === "streamable-http" ? "streamable-http" : "stdio",
    command: row.command ?? undefined,
    args,
    env: decrypt ? decryptEnv(row.env) : {},
    cwd: row.cwd ?? undefined,
    url: row.url ?? undefined,
    authType:
      row.authType === "bearer" || row.authType === "api-key" ? row.authType : "none",
    headers: headerStrings,
    readRoots: parseJsonArray(row.readRoots),
    writeRoots: parseJsonArray(row.writeRoots),
    timeoutMs: row.timeoutMs,
    enabled: row.enabled,
  };
}

export function getServerRow(id: string): UpstreamServer | undefined {
  return db.select().from(upstreamServers).where(eq(upstreamServers.id, id)).get();
}

export function listServerRows(): UpstreamServer[] {
  return db.select().from(upstreamServers).orderBy(asc(upstreamServers.id)).all();
}

/** Config with secrets decrypted (internal use only — never send to the API). */
export function getServerConfig(id: string): UpstreamServerConfig | undefined {
  const row = getServerRow(id);
  return row ? rowToConfig(row, true) : undefined;
}

export function getServerAuthSecret(id: string): string | undefined {
  const row = getServerRow(id);
  if (!row?.authSecret) return undefined;
  return decryptSecret(row.authSecret);
}

export function listServerConfigs(): UpstreamServerConfig[] {
  return listServerRows().map((row) => rowToConfig(row, true));
}

export function toPublic(row: UpstreamServer, toolCount: number): UpstreamServerPublic {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport === "streamable-http" ? "streamable-http" : "stdio",
    command: row.command ?? undefined,
    args: parseJsonArray(row.args),
    cwd: row.cwd ?? undefined,
    url: row.url ?? undefined,
    authType:
      row.authType === "bearer" || row.authType === "api-key" ? row.authType : "none",
    hasAuthSecret: !!row.authSecret,
    hasEnvSecrets: !!row.env,
    readRoots: parseJsonArray(row.readRoots),
    writeRoots: parseJsonArray(row.writeRoots),
    timeoutMs: row.timeoutMs,
    enabled: row.enabled,
    status: (row.status as UpstreamServerStatus) ?? "down",
    lastError: row.lastError,
    toolCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listServersPublic(): UpstreamServerPublic[] {
  const rows = listServerRows();
  const tools = db.select().from(upstreamTools).all();
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.serverId, (counts.get(tool.serverId) ?? 0) + 1);
  return rows.map((row) => toPublic(row, counts.get(row.id) ?? 0));
}

export function getServerPublic(id: string): UpstreamServerPublic | undefined {
  const row = getServerRow(id);
  if (!row) return undefined;
  const count = db
    .select()
    .from(upstreamTools)
    .where(eq(upstreamTools.serverId, id))
    .all().length;
  return toPublic(row, count);
}

/**
 * First free id for a slug base: `figcraft`, then `figcraft-2`,
 * `figcraft-3`, ... `exists` is injected so the suffix logic is
 * unit-testable without a database.
 */
export function nextAvailableId(base: string, exists: (id: string) => boolean): string {
  if (!exists(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = "-" + n;
    const stem =
      base.length + suffix.length > 64
        ? base.slice(0, 64 - suffix.length).replace(/-+$/, "")
        : base;
    const candidate = stem + suffix;
    if (!exists(candidate)) return candidate;
  }
  throw new Error("No free upstream server id available for '" + base + "'");
}

export function createServer(input: unknown): UpstreamServerPublic {
  const { config, authSecret } = validateUpstreamServerInput(input);
  const id = nextAvailableId(config.id, (candidate) => getServerRow(candidate) !== undefined);
  if ((authSecret !== undefined || Object.keys(config.env).length > 0) && !isSecretEncryptionConfigured())
    throw new Error(
      "TOOLSMITH_SUDO_ENCRYPTION_KEY harus diatur (minimal 32 karakter) sebelum menyimpan secret upstream.",
    );
  const timestamp = now();
  db.insert(upstreamServers)
    .values({
      id,
      name: config.name,
      transport: config.transport,
      command: config.command ?? null,
      args: JSON.stringify(config.args),
      env: encryptEnv(config.env),
      cwd: config.cwd ?? null,
      url: config.url ?? null,
      authType: config.authType,
      authSecret: authSecret !== undefined ? encryptSecret(authSecret) : null,
      headers: JSON.stringify(config.headers),
      readRoots: JSON.stringify(config.readRoots),
      writeRoots: JSON.stringify(config.writeRoots),
      timeoutMs: config.timeoutMs,
      enabled: config.enabled,
      status: config.enabled ? "down" : "disabled",
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  const row = getServerRow(id);
  if (!row) throw new Error("Failed to create upstream server '" + id + "'");
  return toPublic(row, 0);
}

/**
 * Patch a server. `patch` may contain any validated config field.
 * `authSecret: null` clears the stored secret; omitted keeps it.
 */
export function updateServer(id: string, patch: Record<string, unknown>): UpstreamServerPublic {
  const row = getServerRow(id);
  if (!row) throw new Error("Unknown upstream server '" + id + "'");
  const current = rowToConfig(row, true);
  const merged: Record<string, unknown> = {
    id: current.id,
    name: current.name,
    transport: current.transport,
    command: current.command,
    args: current.args,
    env: current.env,
    cwd: current.cwd,
    url: current.url,
    authType: current.authType,
    headers: current.headers,
    readRoots: current.readRoots,
    writeRoots: current.writeRoots,
    timeoutMs: current.timeoutMs,
    enabled: current.enabled,
  };
  for (const key of Object.keys(merged)) {
    if (patch[key] !== undefined) merged[key] = patch[key];
  }
  const { config, authSecret } = validateUpstreamServerInput(merged);
  const clearSecret = patch.authSecret === null;
  if (
    ((authSecret !== undefined && !clearSecret) || Object.keys(config.env).length > 0) &&
    !isSecretEncryptionConfigured()
  )
    throw new Error(
      "TOOLSMITH_SUDO_ENCRYPTION_KEY harus diatur (minimal 32 karakter) sebelum menyimpan secret upstream.",
    );
  db.update(upstreamServers)
    .set({
      name: config.name,
      transport: config.transport,
      command: config.command ?? null,
      args: JSON.stringify(config.args),
      env: encryptEnv(config.env),
      cwd: config.cwd ?? null,
      url: config.url ?? null,
      authType: config.authType,
      authSecret: clearSecret
        ? null
        : authSecret !== undefined
          ? encryptSecret(authSecret)
          : row.authSecret,
      headers: JSON.stringify(config.headers),
      readRoots: JSON.stringify(config.readRoots),
      writeRoots: JSON.stringify(config.writeRoots),
      timeoutMs: config.timeoutMs,
      enabled: config.enabled,
      status: config.enabled ? (row.status === "disabled" ? "down" : row.status) : "disabled",
      updatedAt: now(),
    })
    .where(eq(upstreamServers.id, id))
    .run();
  const updated = getServerRow(id);
  if (!updated) throw new Error("Failed to update upstream server '" + id + "'");
  const count = db.select().from(upstreamTools).where(eq(upstreamTools.serverId, id)).all().length;
  return toPublic(updated, count);
}

export function deleteServer(id: string): boolean {
  const row = getServerRow(id);
  if (!row) return false;
  db.delete(upstreamTools).where(eq(upstreamTools.serverId, id)).run();
  db.delete(upstreamServers).where(eq(upstreamServers.id, id)).run();
  return true;
}

export function setServerStatus(id: string, status: UpstreamServerStatus, lastError?: string | null): void {
  db.update(upstreamServers)
    .set({
      status,
      ...(lastError !== undefined ? { lastError } : {}),
      updatedAt: now(),
    })
    .where(eq(upstreamServers.id, id))
    .run();
}

export function replaceTools(serverId: string, tools: UpstreamToolInfo[]): void {
  const timestamp = now();
  db.transaction((tx) => {
    tx.delete(upstreamTools).where(eq(upstreamTools.serverId, serverId)).run();
    for (const tool of tools) {
      tx.insert(upstreamTools)
        .values({
          serverId,
          name: tool.name,
          exposedName: serverId + "__" + tool.name,
          description: tool.description ?? null,
          inputSchema: JSON.stringify(tool.inputSchema),
          annotations: tool.annotations ? JSON.stringify(tool.annotations) : null,
          exposed: true,
          updatedAt: timestamp,
        })
        .run();
    }
  });
}

export function listCachedTools(serverId: string): UpstreamToolInfo[] {
  const rows = db
    .select()
    .from(upstreamTools)
    .where(eq(upstreamTools.serverId, serverId))
    .orderBy(asc(upstreamTools.name))
    .all();
  return rows.map((row) => ({
    name: row.name,
    description: row.description ?? undefined,
    inputSchema: parseJsonObject(row.inputSchema),
    annotations: row.annotations
      ? (parseJsonObject(row.annotations) as UpstreamToolInfo["annotations"])
      : undefined,
  }));
}
