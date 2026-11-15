/**
 * Convert an upstream tool's JSON Schema to a Zod raw shape so it can
 * be registered with registerExposedTool() (which requires Zod).
 *
 * Unsupported constructs fall back to z.unknown() instead of failing
 * the whole server: a tool with a degraded schema is still callable,
 * and its arguments are passed through to the upstream server.
 */
import { z } from "zod";

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describe(schema: JsonSchema, zodSchema: z.ZodType): z.ZodType {
  return typeof schema.description === "string"
    ? zodSchema.describe(schema.description)
    : zodSchema;
}

function convert(schema: unknown): z.ZodType {
  if (!isRecord(schema)) return z.unknown();
  if (typeof schema.$ref === "string") return z.unknown();
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter(
      (value): value is string => typeof value === "string",
    );
    if (values.length > 0)
      return describe(schema, z.enum(values as [string, ...string[]]));
    return z.unknown();
  }
  const unionBranches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(unionBranches)) {
    const branches = unionBranches
      .map((branch) => convert(branch))
      .filter((branch) => !(branch instanceof z.ZodUnknown));
    if (branches.length === 1) return describe(schema, branches[0]!);
    if (branches.length > 1)
      return describe(schema, z.union(branches as [z.ZodType, z.ZodType, ...z.ZodType[]]));
    return z.unknown();
  }
  const types = Array.isArray(schema.type)
    ? (schema.type as unknown[]).filter((t): t is string => typeof t === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  if (types.length > 1) {
    const branches = types
      .map((type) => convert({ ...schema, type }))
      .filter((branch) => !(branch instanceof z.ZodUnknown));
    if (branches.length === 1) return describe(schema, branches[0]!);
    if (branches.length > 1)
      return describe(schema, z.union(branches as [z.ZodType, z.ZodType, ...z.ZodType[]]));
    return z.unknown();
  }
  const type = types[0];
  switch (type) {
    case "string": {
      let out = z.string();
      if (typeof schema.minLength === "number") out = out.min(schema.minLength);
      if (typeof schema.maxLength === "number") out = out.max(schema.maxLength);
      return describe(schema, out);
    }
    case "number": {
      let out = z.number();
      if (typeof schema.minimum === "number") out = out.min(schema.minimum);
      if (typeof schema.maximum === "number") out = out.max(schema.maximum);
      return describe(schema, out);
    }
    case "integer": {
      let out = z.number().int();
      if (typeof schema.minimum === "number") out = out.min(schema.minimum);
      if (typeof schema.maximum === "number") out = out.max(schema.maximum);
      return describe(schema, out);
    }
    case "boolean":
      return describe(schema, z.boolean());
    case "array": {
      const items = schema.items === undefined ? z.unknown() : convert(schema.items);
      let out = z.array(items);
      if (typeof schema.minItems === "number") out = out.min(schema.minItems);
      if (typeof schema.maxItems === "number") out = out.max(schema.maxItems);
      return describe(schema, out);
    }
    case "object": {
      if (isRecord(schema.properties)) {
        return describe(schema, z.looseObject(jsonSchemaToZodShape(schema)));
      }
      return describe(schema, z.record(z.string(), z.unknown()));
    }
    case "null":
      return describe(schema, z.null());
    default:
      if (isRecord(schema.properties))
        return describe(schema, z.looseObject(jsonSchemaToZodShape(schema)));
      return z.unknown();
  }
}

/**
 * Convert a JSON Schema object (`{type: "object", properties, required}`)
 * to a Zod raw shape: `{ field: z.string().optional(), ... }`.
 * Unknown / missing properties produce an empty shape.
 */
export function jsonSchemaToZodShape(
  inputSchema: unknown,
): Record<string, z.ZodType> {
  if (!isRecord(inputSchema)) return {};
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((item): item is string => typeof item === "string")
    : [];
  const shape: Record<string, z.ZodType> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    if (!/^[A-Za-z0-9_$-]+$/.test(key)) continue;
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    const converted = convert(propSchema);
    shape[key] = required.includes(key) ? converted : converted.optional();
  }
  return shape;
}
