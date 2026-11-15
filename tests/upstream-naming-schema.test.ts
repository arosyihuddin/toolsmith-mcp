import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { exposedToolName, parseExposedToolName, riskForTool } from "../src/modules/mcp/upstream/naming.js";
import { jsonSchemaToZodShape } from "../src/modules/mcp/upstream/schema.js";
import { slugifyId, validateUpstreamServerInput } from "../src/modules/mcp/upstream/types.js";
import { nextAvailableId } from "../src/modules/mcp/upstream/store.js";
import { decryptSecret, encryptSecret, isSecretEncryptionConfigured } from "../src/modules/mcp/upstream/crypto.js";

describe("upstream naming", () => {
  test("prefixes tools with the server id", () => {
    expect(exposedToolName("figcraft", "create_node")).toBe("figcraft__create_node");
    expect(parseExposedToolName("figcraft__create_node")).toEqual({
      serverId: "figcraft",
      toolName: "create_node",
    });
    expect(parseExposedToolName("create_node")).toBeNull();
    expect(parseExposedToolName("figcraft__")).toBeNull();
  });

  test("maps risk from readOnlyHint", () => {
    expect(riskForTool({ readOnlyHint: true })).toBe("low");
    expect(riskForTool({ readOnlyHint: false })).toBe("medium");
    expect(riskForTool(undefined)).toBe("medium");
  });
});

describe("JSON Schema to Zod conversion", () => {
  test("converts scalar, enum, array and nested object fields", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        name: { type: "string", description: "Layer name" },
        width: { type: "number" },
        count: { type: "integer", minimum: 0 },
        visible: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        kind: { type: "string", enum: ["frame", "text"] },
        props: { type: "object", properties: { fill: { type: "string" } } },
      },
      required: ["name"],
    });
    const parsed = z.looseObject(shape).parse({
      name: "Frame",
      width: 100,
      count: 3,
      visible: true,
      tags: ["a"],
      kind: "text",
      props: { fill: "#fff" },
    });
    expect(parsed.name).toBe("Frame");
    expect(parsed.count).toBe(3);
    // Optional fields may be omitted.
    expect(z.looseObject(shape).parse({ name: "Only" }).name).toBe("Only");
    // Wrong types are rejected.
    expect(() => z.looseObject(shape).parse({ name: 1 })).toThrow();
    expect(() => z.looseObject(shape).parse({ name: "x", kind: "nope" })).toThrow();
    expect(() => z.looseObject(shape).parse({ name: "x", count: 1.5 })).toThrow();
  });

  test("converts anyOf integer|string (FigCraft ids)", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        id: { anyOf: [{ type: "integer" }, { type: "string" }] },
      },
      required: ["id"],
    });
    expect(z.looseObject(shape).parse({ id: 5 }).id).toBe(5);
    expect(z.looseObject(shape).parse({ id: "abc" }).id).toBe("abc");
    expect(() => z.looseObject(shape).parse({ id: true })).toThrow();
  });

  test("falls back to unknown for unsupported constructs", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        anything: { $ref: "#/definitions/Thing" },
        mystery: {},
      },
    });
    expect(z.looseObject(shape).parse({ anything: { a: 1 }, mystery: [1, 2] })).toEqual({
      anything: { a: 1 },
      mystery: [1, 2],
    });
  });

  test("returns an empty shape for missing schemas", () => {
    expect(jsonSchemaToZodShape(undefined)).toEqual({});
    expect(jsonSchemaToZodShape({})).toEqual({});
  });
});

describe("upstream server validation", () => {
  const figcraft = {
    id: "figcraft",
    name: "FigCraft",
    transport: "stdio",
    command: "/home/era/Applications/figcraft-0.8.0-linux-x86_64.AppImage",
    args: ["cli", "mcp"],
    readRoots: ["/tmp"],
    writeRoots: [],
  };

  test("accepts a valid stdio config with defaults", () => {
    const { config, authSecret } = validateUpstreamServerInput(figcraft);
    expect(config.timeoutMs).toBe(30000);
    expect(config.enabled).toBe(true);
    expect(config.authType).toBe("none");
    expect(authSecret).toBeUndefined();
  });

  test("accepts a valid streamable-http config", () => {
    const { config } = validateUpstreamServerInput({
      id: "figma",
      name: "Figma",
      transport: "streamable-http",
      url: "https://mcp.figma.com/mcp",
      authType: "bearer",
      authSecret: "secret-token",
    });
    expect(config.url).toBe("https://mcp.figma.com/mcp");
  });

  test("rejects bad ids, relative commands and bad urls", () => {
    expect(() => validateUpstreamServerInput({ ...figcraft, id: "FigCraft" })).toThrow(/id must be/);
    expect(() => validateUpstreamServerInput({ ...figcraft, id: "fig craft" })).toThrow(/id must be/);
    expect(() => validateUpstreamServerInput({ ...figcraft, command: "figcraft" })).toThrow(/tidak ditemukan/);
    expect(() => validateUpstreamServerInput({ ...figcraft, command: "./figcraft" })).toThrow(/absolute path/);
    expect(() => validateUpstreamServerInput({ ...figcraft, readRoots: ["relative/path"] })).toThrow(/absolute paths/);
    expect(() =>
      validateUpstreamServerInput({
        id: "x",
        name: "X",
        transport: "streamable-http",
        url: "ftp://example.com/mcp",
      }),
    ).toThrow(/http/);
    expect(() => validateUpstreamServerInput({ ...figcraft, timeoutMs: 10 })).toThrow(/timeoutMs/);
    expect(() => validateUpstreamServerInput({ ...figcraft, transport: "sse" })).toThrow(/transport/);
  });
});

describe("upstream secret encryption", () => {
  test("round-trips with the sudo encryption key", () => {
    process.env.TOOLSMITH_SUDO_ENCRYPTION_KEY = "a".repeat(64);
    expect(isSecretEncryptionConfigured()).toBe(true);
    const encrypted = encryptSecret("super-secret-token");
    expect(encrypted).not.toContain("super-secret-token");
    expect(decryptSecret(encrypted)).toBe("super-secret-token");
    expect(() => decryptSecret("not-an-encrypted-value")).toThrow();
  });
});

describe("upstream server id", () => {
  test("slugifyId derives an id from the name", () => {
    expect(slugifyId("FigCraft")).toBe("figcraft");
    expect(slugifyId("My MCP Server!")).toBe("my-mcp-server");
    expect(slugifyId("  FigCraft Desktop  ")).toBe("figcraft-desktop");
    expect(slugifyId("!!!")).toBe("server");
    expect(slugifyId("")).toBe("server");
    expect(slugifyId("a".repeat(100))).toBe("a".repeat(64));
  });

  test("validateUpstreamServerInput auto-creates the id from the name", () => {
    const { config } = validateUpstreamServerInput({
      name: "FigCraft",
      transport: "stdio",
      command: "/home/era/Applications/figcraft-0.8.0-linux-x86_64.AppImage",
      args: ["cli", "mcp"],
    });
    expect(config.id).toBe("figcraft");
    expect(config.name).toBe("FigCraft");
  });

  test("validateUpstreamServerInput keeps a manually supplied id", () => {
    const { config } = validateUpstreamServerInput({
      id: "my-server",
      name: "My Server",
      transport: "stdio",
      command: "/bin/true",
    });
    expect(config.id).toBe("my-server");
  });

  test("validateUpstreamServerInput rejects an invalid manual id", () => {
    expect(() =>
      validateUpstreamServerInput({
        id: "Bad_ID",
        name: "Bad",
        transport: "stdio",
        command: "/bin/true",
      }),
    ).toThrow(/id must be/);
  });

  test("nextAvailableId adds a numeric suffix on duplicates", () => {
    const taken = new Set(["figcraft", "figcraft-2"]);
    const exists = (candidate: string) => taken.has(candidate);
    expect(nextAvailableId("figcraft", exists)).toBe("figcraft-3");
    expect(nextAvailableId("other", exists)).toBe("other");
  });
});
