/** Naming and risk mapping for tools re-exposed from upstream servers. */

/** Exposed name of an upstream tool: `<server>__<tool>`. */
export function exposedToolName(serverId: string, toolName: string): string {
  return serverId + "__" + toolName;
}

/** Split an exposed name back into server id and upstream tool name. */
export function parseExposedToolName(exposedName: string):
  | { serverId: string; toolName: string }
  | null {
  const index = exposedName.indexOf("__");
  if (index <= 0 || index === exposedName.length - 2) return null;
  return {
    serverId: exposedName.slice(0, index),
    toolName: exposedName.slice(index + 2),
  };
}

export type UpstreamToolRisk = "low" | "medium";

/**
 * Risk of an upstream tool, derived from its MCP annotations.
 * Read-only tools are low risk (section read_only, always_allow by
 * default); anything else is medium (section edit_delete,
 * require_approval by default). Upstream tools are never mapped to
 * high: that level is reserved for local bash / sudo_exec.
 */
export function riskForTool(annotations?: {
  readOnlyHint?: boolean;
}): UpstreamToolRisk {
  return annotations?.readOnlyHint === true ? "low" : "medium";
}
