import { Type, type Schema } from '@google/genai';

/**
 * Convert a JSON Schema object (as returned by MCP's `listTools()`) into the
 * Gemini `Schema` shape used by `FunctionDeclaration.parameters`.
 *
 * MCP tools advertise their inputs as plain JSON Schema. Gemini wants its own
 * `Type` enum and a slightly narrower schema object. This function bridges the
 * two so an MCP tool drops straight into the existing tool registry — no
 * hand-written declarations, no hardcoding.
 *
 * We support the subset of JSON Schema our HR tools use (object/string/number/
 * boolean/array/enum). That's intentional: keep it small and readable for the
 * article rather than implementing the entire JSON Schema spec.
 */

type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  [key: string]: unknown;
};

const TYPE_MAP: Record<string, Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  object: Type.OBJECT,
  array: Type.ARRAY,
};

/**
 * Convert the top-level input schema of an MCP tool into Gemini parameters.
 * Returns undefined for tools that take no arguments (empty object schema),
 * which Gemini accepts.
 */
export function mcpInputSchemaToGemini(
  schema: unknown,
): Schema | undefined {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }

  const converted = convert(schema as JsonSchema);

  // A no-arg tool shows up as an object with no properties — represent that as
  // an empty OBJECT schema so Gemini knows the tool takes nothing.
  if (
    converted.type === Type.OBJECT &&
    (!converted.properties || Object.keys(converted.properties).length === 0)
  ) {
    return { type: Type.OBJECT, properties: {} };
  }

  return converted;
}

function convert(node: JsonSchema): Schema {
  const out: Schema = {};

  const jsonType = Array.isArray(node.type) ? node.type[0] : node.type;
  if (jsonType && TYPE_MAP[jsonType]) {
    out.type = TYPE_MAP[jsonType];
  }

  if (typeof node.description === 'string') {
    out.description = node.description;
  }

  // Enums (Gemini expects string values under a STRING type).
  if (Array.isArray(node.enum)) {
    out.type = Type.STRING;
    out.enum = node.enum.map((v) => String(v));
  }

  if (node.properties) {
    out.type = Type.OBJECT;
    out.properties = {};
    for (const [key, child] of Object.entries(node.properties)) {
      out.properties[key] = convert(child);
    }
  }

  if (Array.isArray(node.required) && node.required.length > 0) {
    out.required = node.required;
  }

  if (node.items) {
    out.type = Type.ARRAY;
    out.items = convert(node.items);
  }

  return out;
}
