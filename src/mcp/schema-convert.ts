import { Type, type Schema } from '@google/genai';

/**
 * Convert the JSON Schema that MCP's `listTools()` returns into the Gemini
 * `Schema` shape used by `FunctionDeclaration.parameters`. This bridge is what
 * lets an MCP tool drop into the existing tool registry with no hand-written
 * declarations.
 *
 * Only the subset of JSON Schema our HR tools use is handled (object/string/
 * number/boolean/array/enum) — intentionally small and readable.
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

export function mcpInputSchemaToGemini(schema: unknown): Schema | undefined {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }

  const converted = convert(schema as JsonSchema);

  // A no-arg tool is an object with no properties — give Gemini an empty OBJECT.
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

  // Gemini expects enum values as strings under a STRING type.
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

  // Only keep required names that actually survived conversion, and copy the
  // array so we never alias the caller's input schema.
  if (Array.isArray(node.required) && node.required.length > 0) {
    const known = out.properties ?? {};
    const required = node.required.filter((name) => name in known);
    if (required.length > 0) {
      out.required = [...required];
    }
  }

  if (node.items) {
    out.type = Type.ARRAY;
    out.items = convert(node.items);
  }

  return out;
}
