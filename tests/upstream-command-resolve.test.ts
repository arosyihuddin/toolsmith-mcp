/** Bare command names (bun, npx, node) resolve to absolute paths. */
import { describe, expect, test } from "bun:test";
import { accessSync, constants as fsConstants } from "node:fs";
import {
  commandSearchDirs,
  resolveCommand,
  validateUpstreamServerInput,
} from "../src/modules/mcp/upstream/types.js";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

describe("upstream command resolution", () => {
  test("resolves bare 'bun' to an absolute executable path", () => {
    const resolved = resolveCommand("bun");
    expect(resolved.startsWith("/")).toBe(true);
    expect(resolved.endsWith("/bun")).toBe(true);
    expect(isExecutable(resolved)).toBe(true);
  });

  test("keeps an absolute path as-is", () => {
    expect(resolveCommand("/bin/true")).toBe("/bin/true");
  });

  test("rejects an absolute path that does not exist", () => {
    expect(() => resolveCommand("/tidak/ada/perintah")).toThrow(/tidak ditemukan/);
  });

  test("throws a clear error for an unknown bare name", () => {
    expect(() => resolveCommand("perintah-yang-tidak-ada-xyz")).toThrow(/tidak ditemukan di PATH/);
  });

  test("rejects a relative path and an empty command", () => {
    expect(() => resolveCommand("./bun")).toThrow(/absolute path/);
    expect(() => resolveCommand("")).toThrow(/non-empty/);
  });

  test("does not search through /tmp shims", () => {
    expect(commandSearchDirs().every((dir) => !dir.startsWith("/tmp/"))).toBe(true);
  });

  test("validateUpstreamServerInput stores the resolved absolute path", () => {
    const { config } = validateUpstreamServerInput({
      name: "Bun Test",
      transport: "stdio",
      command: "bun",
      args: ["--version"],
    });
    expect(config.id).toBe("bun-test");
    expect(config.command).toBe(resolveCommand("bun"));
    expect(config.command?.startsWith("/")).toBe(true);
  });

  test("validateUpstreamServerInput rejects an unknown bare command", () => {
    expect(() =>
      validateUpstreamServerInput({
        name: "Missing",
        transport: "stdio",
        command: "perintah-yang-tidak-ada-xyz",
      }),
    ).toThrow(/tidak ditemukan di PATH/);
  });
});
