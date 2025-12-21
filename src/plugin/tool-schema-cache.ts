
/**
 * Info about a tool parameter schema.
 */
export type SchemaInfo = {
  type: string;
  items?: SchemaInfo;
  properties?: Record<string, SchemaInfo>;
};

/**
 * Cache structure: Map<toolName, Map<paramName, SchemaInfo>>
 */
const toolSchemaCache = new Map<string, Map<string, SchemaInfo>>();

/**
 * Sanitizes tool names for Gemini API compatibility.
 * This should match the logic in gemini.ts.
 */
function sanitizeToolName(name: string): string {
  if (/^[0-9]/.test(name)) {
    return `t_${name}`;
  }
  return name;
}

/**
 * Recursively extracts schema info from a JSON schema object.
 */
function extractSchemaInfo(schema: any): SchemaInfo {
  const type = schema?.type || "unknown";
  const info: SchemaInfo = { type };

  if (type === "array" && schema.items) {
    info.items = extractSchemaInfo(schema.items);
  } else if (type === "object" && schema.properties) {
    info.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      info.properties[key] = extractSchemaInfo(value);
    }
  }

  return info;
}

/**
 * Caches tool schemas from a request payload.
 */
export function cacheToolSchemas(tools: any[] | undefined): void {
  if (!Array.isArray(tools)) return;

  for (const tool of tools) {
    const funcDecls = tool.functionDeclarations;
    if (!Array.isArray(funcDecls)) continue;

    for (const funcDecl of funcDecls) {
      const originalName = funcDecl.name;
      if (typeof originalName !== "string") continue;

      const sanitizedName = sanitizeToolName(originalName);
      const schema = (funcDecl.parametersJsonSchema ?? funcDecl.parameters) as any;
      
      if (!schema || typeof schema !== "object") continue;

      const properties = schema.properties;
      if (!properties || typeof properties !== "object") continue;

      const paramMap = new Map<string, SchemaInfo>();
      for (const [paramName, paramSchema] of Object.entries(properties)) {
        paramMap.set(paramName, extractSchemaInfo(paramSchema));
      }
      
      toolSchemaCache.set(sanitizedName, paramMap);
      // Also cache with original name to be safe
      if (sanitizedName !== originalName) {
        toolSchemaCache.set(originalName, paramMap);
      }
    }
  }
}

/**
 * Gets the expected type for a tool parameter.
 */
export function getParamType(toolName: string, paramName: string): string | undefined {
  return toolSchemaCache.get(toolName)?.get(paramName)?.type;
}

/**
 * Clears the tool schema cache.
 */
export function clearToolSchemaCache(): void {
  toolSchemaCache.clear();
}
