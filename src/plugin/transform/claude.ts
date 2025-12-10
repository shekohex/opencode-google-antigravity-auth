import { randomUUID } from "node:crypto";
import { normalizeThinkingConfig } from "../request-helpers";
import type { RequestPayload, TransformContext, TransformResult } from "./types";

const DEBUG_PREFIX = "[Claude Transform]";

/**
 * Transforms a Gemini-format request payload for Claude proxy models.
 * 
 * The Antigravity backend routes `gemini-claude-*` models to Claude's API, but
 * Claude expects tool schemas in a different format:
 * - Gemini: `functionDeclarations[].parameters` (or `parametersJsonSchema`)
 * - Claude: `functionDeclarations[].input_schema` with required `type` field
 * 
 * Key transformations:
 * 1. Copy `parametersJsonSchema` → `parameters` (AI SDK uses this field)
 * 2. Remove `$schema` from parameters (not valid for Claude)
 * 3. Ensure `type: "object"` and `properties: {}` exist (Claude requires these)
 * 
 * @see https://github.com/router-for-me/CLIProxyAPI/issues/415
 */
export function transformClaudeRequest(
  context: TransformContext,
  parsedBody: RequestPayload,
): TransformResult {
  const requestPayload: RequestPayload = { ...parsedBody };
  let toolsTransformed = false;
  let toolCount = 0;

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

  const tools = requestPayload.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const funcDecls = tool.functionDeclarations as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(funcDecls)) {
        for (const funcDecl of funcDecls) {
          toolCount++;
          
          if (funcDecl.parametersJsonSchema) {
            funcDecl.parameters = funcDecl.parametersJsonSchema;
            delete funcDecl.parametersJsonSchema;
            toolsTransformed = true;
          }
          
          if (typeof funcDecl.parameters === "object" && funcDecl.parameters !== null) {
            const params = funcDecl.parameters as Record<string, unknown>;
            delete params["$schema"];
            
            if (!params.type) {
              params.type = "object";
            }
            if (!params.properties) {
              params.properties = {};
            }
          } else if (!funcDecl.parameters) {
            funcDecl.parameters = { type: "object", properties: {} };
            toolsTransformed = true;
          }
        }
      }
    }
  }

  const contents = requestPayload.contents as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(contents)) {
    const funcCallIdQueues = new Map<string, string[]>();
    let thinkingBlocksRemoved = 0;
    
    for (const content of contents) {
      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(parts)) continue;
      
      const filteredParts: Array<Record<string, unknown>> = [];
      
      for (const part of parts) {
        if (part.thought === true) {
          const signature = part.thoughtSignature;
          if (typeof signature === "string" && signature.length > 50) {
            if (process.env.OPENCODE_ANTIGRAVITY_DEBUG === "1") {
              console.log(`${DEBUG_PREFIX} Keeping thought part with valid signature`);
            }
          } else {
            thinkingBlocksRemoved++;
            if (process.env.OPENCODE_ANTIGRAVITY_DEBUG === "1") {
              console.log(`${DEBUG_PREFIX} Stripped thought part without valid signature`);
            }
            continue;
          }
        }


        
        const functionCall = part.functionCall as Record<string, unknown> | undefined;
        if (functionCall && typeof functionCall.name === "string") {
          if (process.env.OPENCODE_ANTIGRAVITY_DEBUG === "1") {
            console.log(`${DEBUG_PREFIX} functionCall found:`, JSON.stringify(functionCall, null, 2));
          }
          if (!functionCall.id) {
            const callId = `${functionCall.name}-${randomUUID()}`;
            functionCall.id = callId;
            toolsTransformed = true;
            
            if (process.env.OPENCODE_ANTIGRAVITY_DEBUG === "1") {
              console.log(`${DEBUG_PREFIX} Added ID to functionCall: ${functionCall.name} -> ${callId}`);
            }
          }
          const queue = funcCallIdQueues.get(functionCall.name) ?? [];
          queue.push(functionCall.id as string);
          funcCallIdQueues.set(functionCall.name, queue);
        }
        
        const functionResponse = part.functionResponse as Record<string, unknown> | undefined;
        if (functionResponse && typeof functionResponse.name === "string") {
          if (process.env.OPENCODE_ANTIGRAVITY_DEBUG === "1") {
            const responsePreview = functionResponse.response ? 
              JSON.stringify(functionResponse.response).slice(0, 200) + "..." : undefined;
            console.log(`${DEBUG_PREFIX} functionResponse found:`, JSON.stringify({
              ...functionResponse,
              response: responsePreview,
            }, null, 2));
          }
          if (!functionResponse.id) {
            const queue = funcCallIdQueues.get(functionResponse.name);
            if (queue && queue.length > 0) {
              functionResponse.id = queue.shift();
              if (process.env.OPENCODE_ANTIGRAVITY_DEBUG === "1") {
                console.log(`${DEBUG_PREFIX} Assigned ID to functionResponse: ${functionResponse.name} -> ${functionResponse.id}`);
              }
            }
          }
        }
        
        filteredParts.push(part);
      }
      
      content.parts = filteredParts;
    }
    
    if (thinkingBlocksRemoved > 0 && process.env.OPENCODE_ANTIGRAVITY_DEBUG === "1") {
      console.log(`${DEBUG_PREFIX} Stripped ${thinkingBlocksRemoved} thought parts from conversation history`);
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

  if (process.env.OPENCODE_ANTIGRAVITY_DEBUG === "1") {
    console.log(`${DEBUG_PREFIX} Transformed ${toolCount} tools for Claude model: ${context.model}`);
    if (toolsTransformed) {
      console.log(`${DEBUG_PREFIX} Tool schemas converted: parametersJsonSchema → parameters`);
    }
  }

  return {
    body: JSON.stringify(wrappedBody),
    debugInfo: {
      transformer: "claude",
      toolCount,
      toolsTransformed,
    },
  };
}
