import { cacheSignature } from "../cache";
import { createLogger } from "../logger";
import { normalizeThinkingConfig } from "../request-helpers";
import type { RequestPayload, TransformContext, TransformResult } from "./types";

const log = createLogger("transform.gemini");

const THOUGHT_SIGNATURE_BYPASS = "skip_thought_signature_validator";

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

  const contents = requestPayload.contents as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(contents)) {
    for (const content of contents) {
      if (content.role !== "model") continue;
      
      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (part.thought === true || part.thoughtSignature || part.functionCall) {
            const existingSig = part.thoughtSignature as string | undefined;
            
            if (existingSig && existingSig !== THOUGHT_SIGNATURE_BYPASS && existingSig.length > 50) {
              if (typeof part.text === "string" && context.sessionId) {
                cacheSignature(context.sessionId, part.text, existingSig);
                log.debug("Cached original signature before bypass", { textLen: part.text.length });
              }
            }
            
            part.thoughtSignature = THOUGHT_SIGNATURE_BYPASS;
            log.debug("Applied signature bypass");
          }
        }
      }
    }
  }

  requestPayload.sessionId = context.sessionId;

  const wrappedBody = {
    project: context.projectId,
    model: context.model,
    userAgent: "antigravity",
    requestId: context.requestId,
    request: requestPayload,
  };

  return {
    body: JSON.stringify(wrappedBody),
    debugInfo: {
      transformer: "gemini",
      toolCount: countTools(requestPayload),
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


