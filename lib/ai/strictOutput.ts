import { asSchema } from "ai";

/**
 * Anthropic's limits on one request's strict schemas. On a user's own Anthropic key, `generateObject` goes through
 * `@ai-sdk/anthropic` as native strict output (`output_format`), which refuses a request over either one. The app's AI
 * Gateway key sends the schema as a JSON tool instead, so a schema over the limit still works there.
 */
export const ANTHROPIC_MAX_OPTIONAL = 24;
export const ANTHROPIC_MAX_UNIONS = 16;

/** The JSON schema `generateObject` sends: the AI SDK's own conversion (`asSchema`, zod 4 at `io: "input"`). */
export function sentSchema(schema: Parameters<typeof asSchema>[0]): unknown {
  return asSchema(schema).jsonSchema;
}

/** Every property a JSON schema leaves out of its object's `required`, counting each nested copy. */
export function optionalCount(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, n) => sum + optionalCount(n), 0);
  if (!node || typeof node !== "object") return 0;
  const o = node as Record<string, unknown>;
  const required = new Set(Array.isArray(o.required) ? o.required : []);
  const own = o.properties && typeof o.properties === "object" ? Object.keys(o.properties).filter((k) => !required.has(k)).length : 0;
  return own + Object.values(o).reduce((sum: number, v) => sum + optionalCount(v), 0);
}

/** Every place in a JSON schema whose type is a union: `anyOf`, `oneOf` or a `type` array, counting each nested copy. */
export function unionCount(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum: number, n) => sum + unionCount(n), 0);
  if (!node || typeof node !== "object") return 0;
  const o = node as Record<string, unknown>;
  const own = "anyOf" in o || "oneOf" in o || Array.isArray(o.type) ? 1 : 0;
  return own + Object.values(o).reduce((sum: number, v) => sum + unionCount(v), 0);
}
