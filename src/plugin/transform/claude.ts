import { randomUUID } from "node:crypto";
import { debugLog } from "../debug";
import { getCachedSignature } from "../cache";
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
  
  let normalizedThinking = normalizeThinkingConfig(rawGenerationConfig?.thinkingConfig);
  const isThinkingModel = context.model.includes("-thinking");

  if (isThinkingModel) {
    if (!normalizedThinking) {
      normalizedThinking = {
        thinkingBudget: 16384, // Default to 16k for thinking models
        include_thoughts: true,
      };
    } else {
      // If include_thoughts (snake_case) is missing, enable it
      if (normalizedThinking.include_thoughts === undefined) {
        normalizedThinking.include_thoughts = true;
      }
      
      // Ensure budget is set for thinking models
      if (normalizedThinking.thinkingBudget === undefined || normalizedThinking.thinkingBudget === 0) {
        normalizedThinking.thinkingBudget = 16384; // Default to 16k for thinking models
      }
    }

    if (normalizedThinking) {
      // Create a clean config object with verified keys
      // Force snake_case for Antigravity backend to ensure it propagates correctly
      const finalThinkingConfig: Record<string, unknown> = {
        include_thoughts: normalizedThinking.include_thoughts ?? true,
      };

      if (normalizedThinking.thinkingBudget) {
        finalThinkingConfig.thinking_budget = normalizedThinking.thinkingBudget;
        
        // Ensure maxOutputTokens is set and sufficient for the thinking budget.
        // Claude requires max_tokens > thinking.budget_tokens.
        // If maxOutputTokens is missing or too low, we bump it to a safe value (64k).
        const currentMaxOutputTokens = (rawGenerationConfig?.maxOutputTokens ?? rawGenerationConfig?.max_output_tokens) as number | undefined;
        if (!currentMaxOutputTokens || currentMaxOutputTokens <= normalizedThinking.thinkingBudget) {
            if (!rawGenerationConfig) {
                 // We'll handle this when creating the config object below
            }
        }
      }

      if (rawGenerationConfig) {
        rawGenerationConfig.thinkingConfig = finalThinkingConfig;
        
        // Apply the maxOutputTokens fix
        const currentMax = (rawGenerationConfig.maxOutputTokens ?? rawGenerationConfig.max_output_tokens) as number | undefined;
        const budget = normalizedThinking.thinkingBudget;
        
        if (budget && (!currentMax || currentMax <= budget)) {
            // We use 64k as a safe default for thinking models which usually have higher limits
            const newMax = 64000;
            // Prefer camelCase for Gemini API compatibility
            rawGenerationConfig.maxOutputTokens = newMax;
            
            // If snake_case existed, update it too to be safe, or just leave it. 
            // Gemini usually expects camelCase.
            if (rawGenerationConfig.max_output_tokens !== undefined) {
                delete rawGenerationConfig.max_output_tokens;
            }
            
            debugLog(`${DEBUG_PREFIX} Bumped maxOutputTokens to ${newMax} to satisfy thinking budget (${budget})`);
        }

        requestPayload.generationConfig = rawGenerationConfig;
      } else {
        const genConfig: Record<string, unknown> = { thinkingConfig: finalThinkingConfig };
        
        // Apply the maxOutputTokens fix
        const budget = normalizedThinking.thinkingBudget;
        if (budget) {
            genConfig.maxOutputTokens = 64000;
            debugLog(`${DEBUG_PREFIX} Set maxOutputTokens to 64000 to satisfy thinking budget (${budget})`);
        }
        
        requestPayload.generationConfig = genConfig;
      }
    } else if (rawGenerationConfig?.thinkingConfig) {
      delete rawGenerationConfig.thinkingConfig;
      requestPayload.generationConfig = rawGenerationConfig;
    }
  } else {
    // Non-thinking models
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
          let signature = part.thoughtSignature;

          if (!signature || (typeof signature === "string" && signature.length < 50)) {
            // Try cache
            if (typeof part.text === "string") {
              const cached = getCachedSignature(context.sessionId, part.text);
              if (cached) {
                signature = cached;
                part.thoughtSignature = cached;
                debugLog(`${DEBUG_PREFIX} Restored thought signature from cache`);
              }
            }
          }

          if (typeof signature === "string" && signature.length > 50) {
            debugLog(`${DEBUG_PREFIX} Keeping thought part with valid signature`);
          } else {
            debugLog(`${DEBUG_PREFIX} Warning: Thought part has invalid/missing signature (len=${typeof signature === 'string' ? signature.length : 0}), but keeping it to satisfy Claude requirements.`);
            // thinkingBlocksRemoved++;
            // continue;
          }
        }


        
        const functionCall = part.functionCall as Record<string, unknown> | undefined;
        if (functionCall && typeof functionCall.name === "string") {
          debugLog(`${DEBUG_PREFIX} functionCall found:`, JSON.stringify(functionCall, null, 2));
          if (!functionCall.id) {
            const callId = `${functionCall.name}-${randomUUID()}`;
            functionCall.id = callId;
            toolsTransformed = true;
            
            debugLog(`${DEBUG_PREFIX} Added ID to functionCall: ${functionCall.name} -> ${callId}`);
          }
          const queue = funcCallIdQueues.get(functionCall.name) ?? [];
          queue.push(functionCall.id as string);
          funcCallIdQueues.set(functionCall.name, queue);
        }
        
        const functionResponse = part.functionResponse as Record<string, unknown> | undefined;
        if (functionResponse && typeof functionResponse.name === "string") {
          const responsePreview = functionResponse.response ? 
            JSON.stringify(functionResponse.response).slice(0, 200) + "..." : undefined;
          debugLog(`${DEBUG_PREFIX} functionResponse found:`, JSON.stringify({
            ...functionResponse,
            response: responsePreview,
          }, null, 2));

          if (!functionResponse.id) {
            const queue = funcCallIdQueues.get(functionResponse.name);
            if (queue && queue.length > 0) {
              functionResponse.id = queue.shift();
              debugLog(`${DEBUG_PREFIX} Assigned ID to functionResponse: ${functionResponse.name} -> ${functionResponse.id}`);
            }
          }
        }
        
        filteredParts.push(part);
      }
      
      content.parts = filteredParts;
    }
    
    if (thinkingBlocksRemoved > 0) {
      debugLog(`${DEBUG_PREFIX} Removed ${thinkingBlocksRemoved} invalid thinking blocks from history`);
    }

    debugLog(`${DEBUG_PREFIX} Final transformed contents:`, JSON.stringify(contents, null, 2));
    debugLog(`${DEBUG_PREFIX} Final generationConfig:`, JSON.stringify(requestPayload.generationConfig, null, 2));
  }


  requestPayload.sessionId = context.sessionId;

  const wrappedBody = {
    project: context.projectId,
    model: context.model,
    userAgent: "antigravity",
    requestId: context.requestId,
    request: requestPayload,
  };

  debugLog(`${DEBUG_PREFIX} Transforming Claude request for project: ${context.projectId}`);
  debugLog(`${DEBUG_PREFIX} Model: ${context.model}, Streaming: ${context.streaming}`);
  debugLog(`${DEBUG_PREFIX} Transformed ${toolCount} tools for Claude model: ${context.model}`);
  if (toolsTransformed) {
    debugLog(`${DEBUG_PREFIX} Tool schemas converted: parametersJsonSchema → parameters`);
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
