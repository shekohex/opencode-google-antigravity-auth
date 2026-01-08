import { getCachedSignature } from "../cache";
import { createLogger } from "../logger";
import { applyAntigravitySystemInstruction, normalizeThinkingConfig } from "../request-helpers";
import { cacheToolSchemas } from "../tool-schema-cache";
import type { RequestPayload, TransformContext, TransformResult } from "./types";

const log = createLogger("transform.gemini");

const THOUGHT_SIGNATURE_BYPASS = "skip_thought_signature_validator";

const GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION = `<CRITICAL_TOOL_USAGE_INSTRUCTIONS>
You are operating in a CUSTOM ENVIRONMENT where tool definitions COMPLETELY DIFFER from your training data.
VIOLATION OF THESE RULES WILL CAUSE IMMEDIATE SYSTEM FAILURE.

## ABSOLUTE RULES - NO EXCEPTIONS

1. **SCHEMA IS LAW**: The JSON schema in each tool definition is the ONLY source of truth.
   - Your pre-trained knowledge about tools like 'read_file', 'apply_diff', 'write_to_file', 'bash', etc. is INVALID here.
   - Every tool has been REDEFINED with different parameters than what you learned during training.

2. **PARAMETER NAMES ARE EXACT**: Use ONLY the parameter names from the schema.
   - WRONG: 'suggested_answers', 'file_path', 'files_to_read', 'command_to_run'
   - RIGHT: Check the 'properties' field in the schema for the exact names
   - The schema's 'required' array tells you which parameters are mandatory

3. **ARRAY PARAMETERS**: When a parameter has "type": "array", check the 'items' field:
   - If items.type is "object", you MUST provide an array of objects with the EXACT properties listed
   - If items.type is "string", you MUST provide an array of strings
   - NEVER provide a single object when an array is expected
   - NEVER provide an array when a single value is expected

4. **NESTED OBJECTS**: When items.type is "object":
   - Check items.properties for the EXACT field names required
   - Check items.required for which nested fields are mandatory
   - Include ALL required nested fields in EVERY array element

5. **STRICT PARAMETERS HINT**: Tool descriptions contain "STRICT PARAMETERS: ..." which lists:
   - Parameter name, type, and whether REQUIRED
   - For arrays of objects: the nested structure in brackets like [field: type REQUIRED, ...]
   - USE THIS as your quick reference, but the JSON schema is authoritative

6. **BEFORE EVERY TOOL CALL**:
   a. Read the tool's 'parametersJsonSchema' or 'parameters' field completely
   b. Identify ALL required parameters
   c. Verify your parameter names match EXACTLY (case-sensitive)
   d. For arrays, verify you're providing the correct item structure
   e. Do NOT add parameters that don't exist in the schema

## COMMON FAILURE PATTERNS TO AVOID

- Using 'path' when schema says 'filePath' (or vice versa)
- Using 'content' when schema says 'text' (or vice versa)  
- Providing {"file": "..."} when schema wants [{"path": "...", "line_ranges": [...]}]
- Omitting required nested fields in array items
- Adding 'additionalProperties' that the schema doesn't define
- Guessing parameter names from similar tools you know from training

## REMEMBER
Your training data about function calling is OUTDATED for this environment.
The tool names may look familiar, but the schemas are DIFFERENT.
When in doubt, RE-READ THE SCHEMA before making the call.
</CRITICAL_TOOL_USAGE_INSTRUCTIONS>

## GEMINI 3 RESPONSE RULES
- Default to a direct, concise answer; add detail only when asked or required for correctness.
- For multi-part tasks, use a short numbered list or labeled sections.
- For long provided context, answer only from that context and avoid assumptions.
- For multimodal inputs, explicitly reference each modality used and synthesize across them; do not invent details from absent modalities.
- For complex tasks, outline a short plan and verify constraints before acting.
`;

function hasFunctionTools(payload: RequestPayload): boolean {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => Array.isArray(tool.functionDeclarations));
}

function extractSystemInstructionText(systemInstruction: unknown): string {
  if (typeof systemInstruction === "string") {
    return systemInstruction;
  }
  if (!systemInstruction || typeof systemInstruction !== "object") {
    return "";
  }

  const parts = (systemInstruction as Record<string, unknown>).parts as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function getToolCallingMode(payload: RequestPayload): string | undefined {
  const toolConfig = payload.toolConfig;
  if (!toolConfig || typeof toolConfig !== "object") return undefined;

  const functionCallingConfig = (toolConfig as Record<string, unknown>).functionCallingConfig;
  if (!functionCallingConfig || typeof functionCallingConfig !== "object") return undefined;

  const mode = (functionCallingConfig as Record<string, unknown>).mode;
  return typeof mode === "string" ? mode : undefined;
}

function getFunctionToolNames(payload: RequestPayload): string[] {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return [];

  const names: string[] = [];
  for (const tool of tools) {
    const funcDecls = tool.functionDeclarations as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(funcDecls)) continue;

    for (const funcDecl of funcDecls) {
      const name = funcDecl.name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

function hasInjectedToolSchemaInstruction(payload: RequestPayload): boolean {
  const existingText = extractSystemInstructionText(payload.systemInstruction);
  return existingText.includes("<CRITICAL_TOOL_USAGE_INSTRUCTIONS>");
}

type ScrubResult = { cleaned: string; removedLines: number; removedBlocks: number };

function scrubToolTranscriptArtifacts(text: string): ScrubResult {
  const lines = text.split("\n");
  const output: string[] = [];

  let removedLines = 0;
  let removedBlocks = 0;

  let inFence = false;
  let fenceStart = "";
  let fenceLines: string[] = [];

  const isMarkerLine = (line: string): boolean => {
    return /^\s*Tool:\s*\w+/i.test(line) || /^\s*(?:thought|think)\s*:/i.test(line);
  };

  for (const line of lines) {
    const isFence = line.trim().startsWith("```");

    if (isFence) {
      if (!inFence) {
        inFence = true;
        fenceStart = line;
        fenceLines = [];
        continue;
      }

      const hadMarker = fenceLines.some(isMarkerLine);
      const cleanedFenceLines: string[] = [];
      for (const fenceLine of fenceLines) {
        if (isMarkerLine(fenceLine)) {
          removedLines += 1;
        } else {
          cleanedFenceLines.push(fenceLine);
        }
      }

      const hasNonWhitespace = cleanedFenceLines.some((l) => l.trim().length > 0);
      if (hadMarker && !hasNonWhitespace) {
        removedBlocks += 1;
      } else {
        output.push(fenceStart);
        output.push(...cleanedFenceLines);
        output.push(line);
      }

      inFence = false;
      fenceStart = "";
      fenceLines = [];
      continue;
    }

    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    if (isMarkerLine(line)) {
      removedLines += 1;
      continue;
    }

    output.push(line);
  }

  if (inFence) {
    output.push(fenceStart);
    output.push(...fenceLines);
  }

  const cleaned = output.join("\n").replace(/\n{4,}/g, "\n\n\n");
  return { cleaned, removedLines, removedBlocks };
}

function scrubConversationArtifactsFromModelHistory(payload: RequestPayload): void {
  const contents = payload.contents as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(contents)) return;

  let scrubbedParts = 0;
  let removedLines = 0;
  let removedBlocks = 0;

  for (const content of contents) {
    if (content.role !== "model") continue;

    const parts = content.parts as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (typeof part.text !== "string") continue;

      const scrubbed = scrubToolTranscriptArtifacts(part.text);
      if (scrubbed.removedLines > 0 || scrubbed.removedBlocks > 0) {
        part.text = scrubbed.cleaned;
        scrubbedParts += 1;
        removedLines += scrubbed.removedLines;
        removedBlocks += scrubbed.removedBlocks;
      }
    }
  }

  if (scrubbedParts > 0) {
    log.debug("Scrubbed tool transcript artifacts from model history", {
      scrubbedParts,
      removedLines,
      removedBlocks,
    });
  }
}

function injectSystemInstructionIfNeeded(payload: RequestPayload): void {
  if (!hasFunctionTools(payload)) return;

  const existingText = extractSystemInstructionText(payload.systemInstruction);
  if (existingText.includes("<CRITICAL_TOOL_USAGE_INSTRUCTIONS>")) {
    return;
  }

  const existing = payload.systemInstruction;
  if (!existing || typeof existing === "string") {
    const suffix = typeof existing === "string" && existing.trim().length > 0 ? `\n\n${existing}` : "";
    payload.systemInstruction = { parts: [{ text: `${GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION}${suffix}` }] };
    log.debug("Injected tool-schema systemInstruction", { existingType: typeof existing });
    return;
  }

  const asRecord = existing as Record<string, unknown>;
  const parts = asRecord.parts;
  if (Array.isArray(parts)) {
    asRecord.parts = [{ text: GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION }, ...parts];
    payload.systemInstruction = asRecord;
    log.debug("Injected tool-schema systemInstruction", { existingType: "object(parts[])" });
    return;
  }

  payload.systemInstruction = {
    ...asRecord,
    parts: [{ text: GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION }],
  };
  log.debug("Injected tool-schema systemInstruction", { existingType: "object" });
}

function normalizeSchemaType(typeValue: unknown): string | undefined {
  if (typeof typeValue === "string") {
    return typeValue;
  }
  if (Array.isArray(typeValue)) {
    const nonNull = typeValue.filter((t) => t !== "null");
    const first = nonNull[0] ?? typeValue[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function summarizeSchema(schema: unknown, depth: number): string {
  if (!schema || typeof schema !== "object") {
    return "unknown";
  }

  const record = schema as Record<string, unknown>;
  const normalizedType = normalizeSchemaType(record.type);
  const enumValues = Array.isArray(record.enum) ? record.enum : undefined;

  if (normalizedType === "array") {
    const items = record.items;
    const itemSummary = depth > 0 ? summarizeSchema(items, depth - 1) : "unknown";
    return `array[${itemSummary}]`;
  }

  if (normalizedType === "object") {
    const props = record.properties as Record<string, unknown> | undefined;
    const required = Array.isArray(record.required) ? (record.required as unknown[]).filter((v): v is string => typeof v === "string") : [];

    if (!props || depth <= 0) {
      return "object";
    }

    const keys = Object.keys(props);
    const requiredKeys = keys.filter((k) => required.includes(k));
    const optionalKeys = keys.filter((k) => !required.includes(k));
    const orderedKeys = [...requiredKeys.sort(), ...optionalKeys.sort()];

    const maxPropsToShow = 8;
    const shownKeys = orderedKeys.slice(0, maxPropsToShow);

    const inner = shownKeys
      .map((key) => {
        const propSchema = props[key];
        const propType = summarizeSchema(propSchema, depth - 1);
        const requiredSuffix = required.includes(key) ? " REQUIRED" : "";
        return `${key}: ${propType}${requiredSuffix}`;
      })
      .join(", ");

    const extraCount = orderedKeys.length - shownKeys.length;
    const extra = extraCount > 0 ? `, …+${extraCount}` : "";

    return `{${inner}${extra}}`;
  }

  if (enumValues && enumValues.length > 0) {
    const preview = enumValues.slice(0, 6).map(String).join("|");
    const suffix = enumValues.length > 6 ? "|…" : "";
    return `${normalizedType ?? "unknown"} enum(${preview}${suffix})`;
  }

  return normalizedType ?? "unknown";
}

function buildStrictParamsSummary(parametersSchema: Record<string, unknown>): string {
  const schemaType = normalizeSchemaType(parametersSchema.type);
  const properties = parametersSchema.properties as Record<string, unknown> | undefined;
  const required = Array.isArray(parametersSchema.required)
    ? (parametersSchema.required as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  if (schemaType !== "object" || !properties) {
    return "(schema missing top-level object properties)";
  }

  const keys = Object.keys(properties);
  const requiredKeys = keys.filter((k) => required.includes(k));
  const optionalKeys = keys.filter((k) => !required.includes(k));
  const orderedKeys = [...requiredKeys.sort(), ...optionalKeys.sort()];

  const parts = orderedKeys.map((key) => {
    const propSchema = properties[key];
    const typeSummary = summarizeSchema(propSchema, 2);
    const requiredSuffix = required.includes(key) ? " REQUIRED" : "";
    return `${key}: ${typeSummary}${requiredSuffix}`;
  });

  const summary = parts.join(", ");
  const maxLen = 900;
  return summary.length > maxLen ? `${summary.slice(0, maxLen)}…` : summary;
}

function augmentToolDescriptionsWithStrictParams(payload: RequestPayload): void {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return;

  let augmented = 0;
  const toolNames: string[] = [];

  for (const tool of tools) {
    const funcDecls = tool.functionDeclarations as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(funcDecls)) continue;

    for (const funcDecl of funcDecls) {
      const schema = (funcDecl.parametersJsonSchema ?? funcDecl.parameters) as Record<string, unknown> | undefined;
      if (!schema || typeof schema !== "object") continue;

      const currentDescription = typeof funcDecl.description === "string" ? funcDecl.description : "";
      if (currentDescription.includes("STRICT PARAMETERS:")) continue;

      const summary = buildStrictParamsSummary(schema);
      const nextDescription = currentDescription.trim().length > 0
        ? `${currentDescription.trim()}\n\nSTRICT PARAMETERS: ${summary}`
        : `STRICT PARAMETERS: ${summary}`;

      funcDecl.description = nextDescription;
      augmented += 1;
      if (typeof funcDecl.name === "string") {
        toolNames.push(funcDecl.name);
      }
    }
  }

  if (augmented > 0) {
    log.debug("Augmented tool descriptions with STRICT PARAMETERS", {
      count: augmented,
      toolNamesPreview: toolNames.slice(0, 8),
    });
  }
}

/**
 * Sanitizes tool names for Gemini API compatibility.
 * Gemini requires tool names to match: ^[a-zA-Z_][a-zA-Z0-9_-]*$
 * This means names cannot start with numbers.
 * 
 * @param name - The original tool name
 * @returns A sanitized tool name that starts with a letter or underscore
 */
function sanitizeToolNameForGemini(name: string): string {
  // If the name starts with a number, prepend 't_' (for 'tool_')
  if (/^[0-9]/.test(name)) {
    return `t_${name}`;
  }
  return name;
}

/**
 * Recursively sanitizes all tool names in the request payload.
 * 
 * @param payload - The request payload containing tools
 */
function sanitizeToolNames(payload: RequestPayload): void {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return;

  for (const tool of tools) {
    const funcDecls = tool.functionDeclarations as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(funcDecls)) continue;

    for (const func of funcDecls) {
      if (typeof func.name === "string") {
        const originalName = func.name;
        func.name = sanitizeToolNameForGemini(originalName);
        if (originalName !== func.name) {
          log.debug(`Sanitized tool name: ${originalName} → ${func.name}`);
        }
      }
    }
  }
}

/**
 * Transforms a request payload for native Gemini models.
 * 
 * Handles common transformations:
 * - Removes `safetySettings` (Antigravity manages these)
 * - Sets `toolConfig.functionCallingConfig.mode` to "VALIDATED"
 * - Normalizes `thinkingConfig` for Gemini 2.5/3 models
 * - Extracts and normalizes `cachedContent` from various locations
 * - Wraps payload with Antigravity metadata (project, userAgent, requestId, sessionId)
 */
export function transformGeminiRequest(
  context: TransformContext,
  parsedBody: RequestPayload,
): TransformResult {
  const requestPayload: RequestPayload = { ...parsedBody };

  delete requestPayload.safetySettings;

  if (!requestPayload.toolConfig) {
    requestPayload.toolConfig = {};
  }
  if (typeof requestPayload.toolConfig === "object") {
    const toolConfig = requestPayload.toolConfig as Record<string, unknown>;
    if (!toolConfig.functionCallingConfig) {
      toolConfig.functionCallingConfig = {};
    }
    if (typeof toolConfig.functionCallingConfig === "object") {
      (toolConfig.functionCallingConfig as Record<string, unknown>).mode = "VALIDATED";
    }
  }

  const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined;
  const normalizedThinking = normalizeThinkingConfig(rawGenerationConfig?.thinkingConfig);
  if (normalizedThinking) {
    if (rawGenerationConfig) {
      rawGenerationConfig.thinkingConfig = normalizedThinking;
      requestPayload.generationConfig = rawGenerationConfig;
    } else {
      requestPayload.generationConfig = { thinkingConfig: normalizedThinking };
    }
  } else if (rawGenerationConfig?.thinkingConfig) {
    delete rawGenerationConfig.thinkingConfig;
    requestPayload.generationConfig = rawGenerationConfig;
  }

  if ("system_instruction" in requestPayload) {
    requestPayload.systemInstruction = requestPayload.system_instruction;
    delete requestPayload.system_instruction;
  }

  const cachedContentFromExtra =
    typeof requestPayload.extra_body === "object" && requestPayload.extra_body
      ? (requestPayload.extra_body as Record<string, unknown>).cached_content ??
      (requestPayload.extra_body as Record<string, unknown>).cachedContent
      : undefined;
  const cachedContent =
    (requestPayload.cached_content as string | undefined) ??
    (requestPayload.cachedContent as string | undefined) ??
    (cachedContentFromExtra as string | undefined);
  if (cachedContent) {
    requestPayload.cachedContent = cachedContent;
  }

  delete requestPayload.cached_content;
  delete requestPayload.cachedContent;
  if (requestPayload.extra_body && typeof requestPayload.extra_body === "object") {
    delete (requestPayload.extra_body as Record<string, unknown>).cached_content;
    delete (requestPayload.extra_body as Record<string, unknown>).cachedContent;
    if (Object.keys(requestPayload.extra_body as Record<string, unknown>).length === 0) {
      delete requestPayload.extra_body;
    }
  }

  if ("model" in requestPayload) {
    delete requestPayload.model;
  }

  // Sanitize tool names to ensure Gemini API compatibility
  sanitizeToolNames(requestPayload);

  // Cache tool schemas for response normalization
  cacheToolSchemas(requestPayload.tools as any[]);

  augmentToolDescriptionsWithStrictParams(requestPayload);
  injectSystemInstructionIfNeeded(requestPayload);
  scrubConversationArtifactsFromModelHistory(requestPayload);
  applyAntigravitySystemInstruction(requestPayload, context.model);

  const contents = requestPayload.contents as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(contents)) {
    for (let contentIndex = 0; contentIndex < contents.length; contentIndex++) {
      const content = contents[contentIndex];
      if (!content) continue;
      if (content.role !== "model") continue;

      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(parts)) continue;

      const filteredParts: Array<Record<string, unknown>> = [];
      let thinkingBlocksRemoved = 0;
      let removedThoughtSignatures = 0;
      let addedFunctionCallThoughtSignatures = 0;
      let currentThoughtSignature: string | undefined;

      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];
        if (!part) continue;

        if (part.thought === true) {
          const thoughtText = part.text as string | undefined;

          if (thoughtText && context.sessionId) {
            const cachedSig = getCachedSignature(context.family, context.sessionId, thoughtText);

            if (cachedSig) {
              part.thoughtSignature = cachedSig;
              currentThoughtSignature = cachedSig;
              filteredParts.push(part);
              log.debug("Restored thought from own cache", {
                family: context.family,
                sessionId: context.sessionId,
                contentIndex,
                partIndex,
                textLen: thoughtText.length,
              });
              continue;
            }
          }

          thinkingBlocksRemoved += 1;
          log.debug("Removed thinking block (not in own cache)", {
            family: context.family,
            sessionId: context.sessionId,
            contentIndex,
            partIndex,
            textLen: typeof part.text === "string" ? part.text.length : undefined,
          });
          continue;
        }

        if (part.functionCall) {
          const functionCall = (part.functionCall ?? {}) as Record<string, unknown>;
          const callName = typeof functionCall.name === "string" ? functionCall.name : "<unknown>";

          const existingSig = part.thoughtSignature;
          if (typeof existingSig !== "string" || existingSig.length === 0) {
            const source = currentThoughtSignature ? "current_thought" : "bypass";
            const nextSig = currentThoughtSignature ?? THOUGHT_SIGNATURE_BYPASS;
            part.thoughtSignature = nextSig;
            addedFunctionCallThoughtSignatures += 1;

            log.debug("Added thoughtSignature to functionCall part", {
              family: context.family,
              sessionId: context.sessionId,
              contentIndex,
              partIndex,
              callName,
              signatureSource: source,
              signatureLen: nextSig.length,
            });
          }

          filteredParts.push(part);
          continue;
        }

        if (part.thoughtSignature !== undefined) {
          delete part.thoughtSignature;
          removedThoughtSignatures += 1;
        }

        filteredParts.push(part);
      }

      content.parts = filteredParts;

      if (thinkingBlocksRemoved > 0) {
        log.debug("Removed foreign thinking blocks", { count: thinkingBlocksRemoved, contentIndex });
      }
      if (removedThoughtSignatures > 0) {
        log.debug("Removed thoughtSignature from non-thought non-tool model parts", { count: removedThoughtSignatures, contentIndex });
      }
      if (addedFunctionCallThoughtSignatures > 0) {
        log.debug("Added thoughtSignature to functionCall parts", { count: addedFunctionCallThoughtSignatures, contentIndex });
      }
    }
  }

  requestPayload.sessionId = context.sessionId;

  const wrappedBody = {
    project: context.projectId,
    model: context.model,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: context.requestId,
    request: requestPayload,
  };

  const toolCount = countTools(requestPayload);
  const toolCallingMode = getToolCallingMode(requestPayload);
  const systemInstructionHasMarker = hasInjectedToolSchemaInstruction(requestPayload);
  const functionToolNames = getFunctionToolNames(requestPayload);
  const contentsCount = Array.isArray(requestPayload.contents) ? requestPayload.contents.length : 0;

  log.debug("Gemini request transformed", {
    model: context.model,
    streaming: context.streaming,
    sessionId: context.sessionId,
    toolCount,
    toolCallingMode,
    systemInstructionHasMarker,
    functionToolNamesPreview: functionToolNames.slice(0, 8),
    contentsCount,
  });

  const body = JSON.stringify(wrappedBody);

  return {
    body,
    debugInfo: {
      transformer: "gemini",
      toolCount,
    },
  };
}

function countTools(payload: RequestPayload): number {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return 0;
  let count = 0;
  for (const tool of tools) {
    const funcDecls = tool.functionDeclarations as Array<unknown> | undefined;
    if (Array.isArray(funcDecls)) {
      count += funcDecls.length;
    }
    if (tool.googleSearch) {
      count += 1;
    }
    if (tool.urlContext) {
      count += 1;
    }
  }
  return count;
}


