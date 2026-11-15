/**
 * Lifecycle manager for upstream MCP connections.
 *
 * One client per server (single-flight connect), reconnect with a
 * short backoff, lazy reconnect on a failed call, and a disposeAll()
 * for graceful shutdown. A server that fails to connect never fails
 * Toolsmith startup: the failure is recorded on the server row and
 * the other servers keep working.
 */
import { logger } from "../../../lib/logger.js";
import { connectUpstream, type UpstreamConnection } from "./client.js";
import {
  getServerAuthSecret,
  getServerConfig,
  listServerConfigs,
  replaceTools,
  setServerStatus,
} from "./store.js";

const CONNECT_ATTEMPTS = 3;
const CONNECT_BACKOFF_MS = [0, 500, 1500];

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? message.slice(0, 500) + "…" : message;
}

function isConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /closed|terminated|not connected|ECONNRESET|EPIPE|EOF|aborted/i.test(message);
}

class UpstreamManager {
  private connections = new Map<string, UpstreamConnection>();
  private connecting = new Map<string, Promise<UpstreamConnection>>();

  isConnected(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  getConnection(serverId: string): UpstreamConnection | undefined {
    return this.connections.get(serverId);
  }

  listConnectedServerIds(): string[] {
    return [...this.connections.keys()];
  }

  /** Connect (single-flight). Retries a few times, then records the error. */
  connect(serverId: string): Promise<UpstreamConnection> {
    const existing = this.connections.get(serverId);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.connecting.get(serverId);
    if (inFlight) return inFlight;
    const promise = this.doConnect(serverId).finally(() => {
      this.connecting.delete(serverId);
    });
    this.connecting.set(serverId, promise);
    return promise;
  }

  private async doConnect(serverId: string): Promise<UpstreamConnection> {
    const config = getServerConfig(serverId);
    if (!config) throw new Error("Unknown upstream server '" + serverId + "'");
    if (!config.enabled) {
      setServerStatus(serverId, "disabled");
      throw new Error("Upstream server '" + serverId + "' is disabled");
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
      if (attempt > 0)
        await new Promise((resolve) => setTimeout(resolve, CONNECT_BACKOFF_MS[attempt] ?? 1500));
      try {
        const authSecret = getServerAuthSecret(serverId);
        const connection = await connectUpstream(config, { authSecret });
        replaceTools(serverId, connection.tools);
        setServerStatus(serverId, "connected", null);
        this.connections.set(serverId, connection);
        logger.info(
          { server: serverId, tools: connection.tools.length },
          "Upstream MCP server connected",
        );
        return connection;
      } catch (error) {
        lastError = error;
        logger.warn(
          { server: serverId, attempt: attempt + 1, error: shortError(error) },
          "Upstream MCP connect attempt failed",
        );
      }
    }
    setServerStatus(serverId, "error", shortError(lastError));
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Close one connection. Never throws. */
  async disconnect(serverId: string): Promise<void> {
    this.connecting.delete(serverId);
    const connection = this.connections.get(serverId);
    if (connection) {
      this.connections.delete(serverId);
      try {
        await connection.close();
      } catch (error) {
        logger.warn({ server: serverId, error: shortError(error) }, "Upstream MCP close failed");
      }
    }
    const config = getServerConfig(serverId);
    if (config?.enabled) setServerStatus(serverId, "down");
  }

  async reconnect(serverId: string): Promise<UpstreamConnection> {
    await this.disconnect(serverId);
    return this.connect(serverId);
  }

  /**
   * Call a tool on an upstream server, connecting lazily if needed.
   * On a transport failure, reconnect once and retry once.
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }> {
    let connection = this.connections.get(serverId);
    if (!connection) connection = await this.connect(serverId);
    try {
      return await connection.callTool(toolName, args, connection.config.timeoutMs);
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      logger.warn({ server: serverId, tool: toolName }, "Upstream call failed, reconnecting once");
      const retry = await this.reconnect(serverId);
      return retry.callTool(toolName, args, retry.config.timeoutMs);
    }
  }

  /** Connect every enabled server. Failures are recorded, never thrown. */
  async connectEnabled(): Promise<{ connected: string[]; failed: Array<{ id: string; error: string }> }> {
    const configs = listServerConfigs().filter((config) => config.enabled);
    const results = await Promise.allSettled(configs.map((config) => this.connect(config.id)));
    const connected: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    results.forEach((result, index) => {
      const id = configs[index]!.id;
      if (result.status === "fulfilled") connected.push(id);
      else failed.push({ id, error: shortError(result.reason) });
    });
    if (failed.length > 0)
      logger.warn({ failed }, "Some upstream MCP servers failed to connect at startup");
    return { connected, failed };
  }

  /** Close every connection. Never throws; used at shutdown. */
  async disposeAll(): Promise<void> {
    const ids = [...this.connections.keys()];
    for (const id of ids) await this.disconnect(id);
    this.connecting.clear();
  }
}

export const upstreamManager = new UpstreamManager();
