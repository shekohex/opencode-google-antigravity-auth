import { CODE_ASSIST_ENDPOINT, CODE_ASSIST_HEADERS } from "../constants";
import { cacheSignature, type ModelFamily } from "./cache";
import { logAntigravityDebugResponse, type AntigravityDebugContext } from "./debug";
import { createLogger, printAntigravityConsole } from "./logger";
import {
  extractUsageFromSsePayload,
  extractUsageMetadata,
  generateRequestId,
  getSessionId,
  parseGeminiApiBody,
  normalizeToolCallArgs,
  recursivelyParseJsonStrings,
  rewriteGeminiPreviewAccessError,
  rewriteGeminiRateLimitError,
  type GeminiApiBody
} from "./request-helpers";
import {
  transformClaudeRequest,
  transformGeminiRequest,
  type TransformContext,
} from "./transform";
import type { PluginClient } from "./types";

const log = createLogger("request");

const STREAM_ACTION = "streamGenerateContent";

const MODEL_ALIASES: Record<string, string> = {
  "gemini-2.5-computer-use-preview-10-2025": "rev19-uic3-1p",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  "gemini-3-pro-preview": "gemini-3-pro-high",
  "gemini-claude-sonnet-4-5": "claude-sonnet-4-5",
  "gemini-claude-sonnet-4-5-thinking": "claude-sonnet-4-5-thinking",
  "gemini-claude-opus-4-5-thinking": "claude-opus-4-5-thinking",
};

const MODEL_FALLBACKS: Record<string, string> = {
  "gemini-2.5-flash-image": "gemini-2.5-flash",
};

function getModelFamily(model: string): ModelFamily {
  return model.includes("claude") 
    ? "claude" 
    : model.includes("flash") 
      ? "gemini-flash" 
      : "gemini-pro";
}

export function isGenerativeLanguageRequest(input: RequestInfo): boolean {
  if (typeof input === "string") {
    return input.includes("generativelanguage.googleapis.com");
  }
  if (input instanceof Request) {
    return input.url.includes("generativelanguage.googleapis.com");
  }
  // Fallback for object-like RequestInfo that might not be instanceof Request (e.g. node-fetch polyfills)
  if (typeof input === "object" && input !== null && "url" in input) {
    return (input as { url: string }).url.includes("generativelanguage.googleapis.com");
  }
  return false;
}

function transformStreamingPayload(payload: string, onError?: (body: GeminiApiBody) => GeminiApiBody | null): string {
  return payload
    .split("\n")
    .map((line) => transformSseLine(line, onError))
    .join("\n");
}

function transformSseLine(line: string, onError?: (body: GeminiApiBody) => GeminiApiBody | null, onParsed?: (body: GeminiApiBody) => void): string {
  if (!line.startsWith("data:")) {
    return line;
  }
  const json = line.slice(5).trim();
  if (!json) {
    return line;
  }
  try {
    let parsed = JSON.parse(json) as unknown;

    // Handle array-wrapped responses
    if (Array.isArray(parsed)) {
      parsed = parsed.find((item) => typeof item === "object" && item !== null);
    }

    if (!parsed || typeof parsed !== "object") {
      return line;
    }

    const body = parsed as GeminiApiBody;

    if (onParsed) {
      onParsed(body);
    }

    if (body.error) {
      const rewritten = onError?.(body);
      if (rewritten) {
        return `data: ${JSON.stringify(rewritten)}`;
      }
    }

    if (body.response !== undefined) {
      const responseObj = body.response as Record<string, unknown>;
      normalizeToolArgsInResponse(body.response);

      const candidates = (responseObj as any).candidates as unknown;
        if (Array.isArray(candidates)) {
          candidates.forEach((candidate: any, candidateIndex: number) => {
            const parts = candidate?.content?.parts as unknown;
            if (!Array.isArray(parts)) return;

            const finishReason = candidate?.finishReason;

            const functionCallNames: string[] = [];
            const functionResponseNames: string[] = [];
            let combinedText = "";

            const summarizeArgs = (args: unknown): Record<string, unknown> => {
              if (args === null) return { type: "null" };
              if (args === undefined) return { type: "undefined" };
              if (typeof args === "string") return { type: "string", length: args.length };
              if (typeof args === "number" || typeof args === "boolean") return { type: typeof args };
              if (Array.isArray(args)) return { type: "array", length: args.length };
              if (typeof args === "object") {
                const keys = Object.keys(args as Record<string, unknown>);
                return { type: "object", keysPreview: keys.slice(0, 12), keyCount: keys.length };
              }
              return { type: typeof args };
            };

            let loggedToolParts = 0;

            for (let partIndex = 0; partIndex < (parts as any[]).length; partIndex++) {
              const part = (parts as any[])[partIndex];

              const call = part?.functionCall;
              const callName = call?.name;
              if (typeof callName === "string") {
                functionCallNames.push(callName);

                if (loggedToolParts < 6) {
                  loggedToolParts += 1;
                  log.debug("SSE functionCall part", {
                    candidateIndex,
                    partIndex,
                    finishReason,
                    callName,
                    hasThoughtSignature: typeof part?.thoughtSignature === "string",
                    isThought: part?.thought === true,
                    argsSummary: summarizeArgs(call?.args),
                  });
                }
              }

              const response = part?.functionResponse;
              const responseName = response?.name;
              if (typeof responseName === "string") {
                functionResponseNames.push(responseName);

                if (loggedToolParts < 6) {
                  loggedToolParts += 1;
                  log.debug("SSE functionResponse part", {
                    candidateIndex,
                    partIndex,
                    finishReason,
                    responseName,
                    hasThoughtSignature: typeof part?.thoughtSignature === "string",
                    isThought: part?.thought === true,
                    responseSummary: summarizeArgs(response?.response),
                  });
                }
              }

              const text = part?.text;
              if (typeof text === "string") combinedText += `${text}\n`;
            }

            if (functionCallNames.length > 0 || functionResponseNames.length > 0) {
              log.debug("SSE tool parts observed", {
                candidateIndex,
                finishReason,
                partCount: (parts as any[]).length,
                functionCallNames: functionCallNames.slice(0, 8),
                functionResponseNames: functionResponseNames.slice(0, 8),
              });
            }

            const hasToolMarkerText = /(^|\n)\s*Tool:\s*\w+/i.test(combinedText) ||
              (combinedText.includes("```") && combinedText.includes("Tool:"));
            const hasThoughtPrefix = /(^|\n)\s*(?:thought|think)\s*:/i.test(combinedText);

            if ((hasToolMarkerText || hasThoughtPrefix) && functionCallNames.length === 0) {
              const preview = combinedText.length > 350 ? `${combinedText.slice(0, 350)}…` : combinedText;
              log.debug("SSE possible tool-hallucination text (no functionCall)", {
                candidateIndex,
                finishReason,
                hasToolMarkerText,
                hasThoughtPrefix,
                textPreview: preview,
              });
            }
          });
        }


      const responseStr = JSON.stringify(body.response);
      if (responseStr.includes('"thought"') || responseStr.includes('"thinking"')) {
        log.debug("Found thinking content in response", { preview: responseStr.slice(0, 500) });
      }

      if (responseObj.usageMetadata) {
        const usage = responseObj.usageMetadata as Record<string, unknown>;
        if (typeof usage.cachedContentTokenCount === "number" && usage.cachedContentTokenCount > 0) {
          log.debug("SSE Cache HIT", { cachedTokens: usage.cachedContentTokenCount });
        }
      }
      return `data: ${JSON.stringify(body.response)}`;
    }
  } catch (_) { }
  return line;
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
    // Unclosed fence: keep content as-is.
    output.push(fenceStart);
    output.push(...fenceLines);
  }

  const cleaned = output.join("\n").replace(/\n{4,}/g, "\n\n\n");
  return { cleaned, removedLines, removedBlocks };
}

function normalizeToolArgsInResponse(response: unknown): void {
  if (!response || typeof response !== "object") return;

  const candidates = (response as Record<string, unknown>).candidates as unknown;
  if (!Array.isArray(candidates)) return;

  let scrubbedParts = 0;
  let removedLines = 0;
  let removedBlocks = 0;

  for (const candidate of candidates) {
    const parts = (candidate as any)?.content?.parts as unknown;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      const text = (part as any)?.text;
      if (typeof text === "string") {
        const scrubbed = scrubToolTranscriptArtifacts(text);
        if (scrubbed.removedLines > 0 || scrubbed.removedBlocks > 0) {
          (part as any).text = scrubbed.cleaned;
          scrubbedParts += 1;
          removedLines += scrubbed.removedLines;
          removedBlocks += scrubbed.removedBlocks;
        }
      }

      const functionCall = (part as any)?.functionCall;
      if (functionCall && "args" in functionCall) {
        const beforeArgs = functionCall.args;
        const afterArgs = normalizeToolCallArgs(beforeArgs, functionCall.name);
        functionCall.args = afterArgs;

        if (typeof beforeArgs === "string" && beforeArgs !== afterArgs) {
          log.debug("Parsed functionCall.args JSON string", { name: functionCall.name });
        }
      }

      const functionResponse = (part as any)?.functionResponse;
      if (functionResponse && "response" in functionResponse) {
        const beforeResponse = functionResponse.response;
        const afterResponse = recursivelyParseJsonStrings(beforeResponse);
        functionResponse.response = afterResponse;

        if (typeof beforeResponse === "string" && beforeResponse !== afterResponse) {
          log.debug("Parsed functionResponse.response JSON string", { name: functionResponse.name });
        }
      }
    }
  }

  if (scrubbedParts > 0) {
    log.debug("Scrubbed tool transcript artifacts from response text", {
      scrubbedParts,
      removedLines,
      removedBlocks,
    });
  }
}

export function createSseTransformStream(onError?: (body: GeminiApiBody) => GeminiApiBody | null, sessionId?: string, family?: ModelFamily): TransformStream<string, string> {
  let buffer = "";
  const thoughtBuffers = new Map<number, string>();
  let sseEventSeq = 0;

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const eventSeq = sseEventSeq++;

        const transformed = transformSseLine(line, onError, (body) => {
          if (!sessionId || !family) return;
          const response = body.response as any;
          if (!response?.candidates) return;

          response.candidates.forEach((candidate: any, candidateIndex: number) => {
            if (candidate.groundingMetadata) {
              log.debug("SSE Grounding metadata found", {
                eventSeq,
                candidateIndex,
                groundingMetadata: candidate.groundingMetadata,
              });
            }

            if (!candidate.content?.parts) return;

            let loggedToolParts = 0;

            candidate.content.parts.forEach((part: any, partIndex: number) => {
              if (part.thought) {
                if (part.text) {
                  const current = thoughtBuffers.get(candidateIndex) ?? "";
                  thoughtBuffers.set(candidateIndex, current + part.text);
                }

                if (part.thoughtSignature) {
                  const fullText = thoughtBuffers.get(candidateIndex) ?? "";
                  if (fullText) {
                    cacheSignature(family, sessionId, fullText, part.thoughtSignature);
                    log.debug("Cached signature from thought part", {
                      eventSeq,
                      candidateIndex,
                      partIndex,
                      family,
                      textLen: fullText.length,
                      signatureLen: String(part.thoughtSignature).length,
                    });
                  }
                }

                return;
              }

              if (part?.functionCall && loggedToolParts < 6) {
                loggedToolParts += 1;
                log.debug("SSE observed functionCall (stream)", {
                  eventSeq,
                  candidateIndex,
                  partIndex,
                  name: part.functionCall?.name,
                  hasThoughtSignature: typeof part.thoughtSignature === "string",
                });
              }

              if (part?.thoughtSignature && !part.thought) {
                const fullText = thoughtBuffers.get(candidateIndex) ?? "";
                if (fullText) {
                  cacheSignature(family, sessionId, fullText, part.thoughtSignature);
                  log.debug("Cached signature from separate part", {
                    eventSeq,
                    candidateIndex,
                    partIndex,
                    family,
                    textLen: fullText.length,
                    signatureLen: String(part.thoughtSignature).length,
                    hasFunctionCall: Boolean(part?.functionCall),
                  });
                }
              }
            });
          });
        });

        controller.enqueue(transformed + "\n");
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        const transformed = transformSseLine(buffer, onError);
        controller.enqueue(transformed);
      }
    },
  });
}


function resolveModelName(rawModel: string): string {
  const aliased = MODEL_ALIASES[rawModel];
  if (aliased) {
    return aliased;
  }
  return MODEL_FALLBACKS[rawModel] ?? rawModel;
}

export async function prepareAntigravityRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
): Promise<{ request: RequestInfo; init: RequestInit; streaming: boolean; requestedModel?: string }> {
  let urlString = "";
  let requestInit: RequestInit = { ...init };
  let originalBody: BodyInit | null = init?.body ?? null;

  if (typeof input === "string") {
    urlString = input;
  } else {
    urlString = input.url;
    // Merge headers from Request object
    const reqHeaders = new Headers(input.headers);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        reqHeaders.set(key, value);
      });
    }
    requestInit.headers = reqHeaders;

    // If body isn't in init, try to get it from request
    if (!originalBody && input.body) {
      // We need to clone to avoid consuming the original request if possible, 
      // but standard Request cloning is sync. 
      // We'll try to read text if we can.
      try {
        // Note: If input is a Request object that has been used, this might fail.
        // But usually in this context it's fresh.
        const cloned = input.clone();
        originalBody = await cloned.text();
      } catch (e) {
        // If clone fails (e.g. body used), we might be in trouble or it's empty.
      }
    }
  }

  const baseInit: RequestInit = { ...requestInit, body: originalBody };
  const headers = new Headers(baseInit.headers ?? {});

  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    };
  }

  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");

  const match = urlString.match(/\/models\/([^:]+):(\w+)/);
  if (!match) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    };
  }

  const [, rawModel = "", rawAction = ""] = match;
  const effectiveModel = resolveModelName(rawModel);
  const streaming = rawAction === STREAM_ACTION;
  const transformedUrl = `${CODE_ASSIST_ENDPOINT}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""
    }`;

  let body = baseInit.body;
  let transformDebugInfo: { transformer: string; toolCount?: number; toolsTransformed?: boolean } | undefined;

  if (typeof baseInit.body === "string" && baseInit.body) {
    try {
      const parsedBody = JSON.parse(baseInit.body) as Record<string, unknown>;
      const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody;
      const isClaudeModel = effectiveModel.includes("claude");

      if (isWrapped) {
        if (isClaudeModel) {
          const context: TransformContext = {
            model: effectiveModel,
            family: getModelFamily(effectiveModel),
            projectId: (parsedBody.project as string) || projectId,
            streaming,
            requestId: generateRequestId(),
            sessionId: getSessionId(),
          };
          const innerRequest = parsedBody.request as Record<string, unknown>;
          const result = transformClaudeRequest(context, innerRequest);
          body = result.body;
          transformDebugInfo = result.debugInfo;

          if (transformDebugInfo) {
            log.debug("Using transformer (wrapped)", { transformer: transformDebugInfo.transformer, model: effectiveModel, family: context.family, toolCount: transformDebugInfo.toolCount });
          }
        } else {
          const wrappedBody = {
            ...parsedBody,
            model: effectiveModel,
            userAgent: "antigravity",
            requestId: generateRequestId(),
          } as Record<string, unknown>;
          if (wrappedBody.request && typeof wrappedBody.request === "object") {
            (wrappedBody.request as Record<string, unknown>).sessionId = getSessionId();
          }
          body = JSON.stringify(wrappedBody);
        }
      } else {
        const context: TransformContext = {
          model: effectiveModel,
          family: getModelFamily(effectiveModel),
          projectId,
          streaming,
          requestId: generateRequestId(),
          sessionId: getSessionId(),
        };

        const result = isClaudeModel
          ? transformClaudeRequest(context, parsedBody)
          : transformGeminiRequest(context, parsedBody);

        body = result.body;
        transformDebugInfo = result.debugInfo;

        if (transformDebugInfo) {
          log.debug("Using transformer", { transformer: transformDebugInfo.transformer, model: effectiveModel, family: context.family, toolCount: transformDebugInfo.toolCount });
        }
      }
    } catch (error) {
      printAntigravityConsole("error", "Failed to transform Antigravity request body", error);
    }
  }

  headers.set("Content-Type", "application/json");
  headers.set("Accept", streaming ? "text/event-stream" : "application/json");

  // Add interleaved thinking header for Claude thinking models
  if (effectiveModel.includes("claude") && effectiveModel.includes("thinking")) {
    const existing = headers.get("anthropic-beta");
    const interleavedHeader = "interleaved-thinking-2025-05-14";

    if (existing) {
      if (!existing.includes(interleavedHeader)) {
        headers.set("anthropic-beta", `${existing},${interleavedHeader}`);
      }
    } else {
      headers.set("anthropic-beta", interleavedHeader);
    }
    log.debug("Added interleaved thinking header");
  }

  headers.set("User-Agent", CODE_ASSIST_HEADERS["User-Agent"]);
  headers.set("X-Goog-Api-Client", CODE_ASSIST_HEADERS["X-Goog-Api-Client"]);
  headers.set("Client-Metadata", CODE_ASSIST_HEADERS["Client-Metadata"]);

  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body,
    },
    streaming,
    requestedModel: rawModel,
  };
}

/**
 * Normalizes Gemini responses: applies retry headers, extracts cache usage into headers,
 * rewrites preview errors, flattens streaming payloads, and logs debug metadata.
 */
export async function transformAntigravityResponse(
  response: Response,
  streaming: boolean,
  client: PluginClient,
  debugContext?: AntigravityDebugContext | null,
  requestedModel?: string,
  sessionId?: string,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");
  const family: ModelFamily = requestedModel ? getModelFamily(requestedModel) : "gemini-flash";

  if (!isJsonResponse && !isEventStreamResponse) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)",
    });
    return response;
  }

  const errorHandler = (body: GeminiApiBody): GeminiApiBody | null => {
    const previewErrorFixed = rewriteGeminiPreviewAccessError(body, response.status, requestedModel);
    const rateLimitErrorFixed = rewriteGeminiRateLimitError(body);

    const patched = previewErrorFixed ?? rateLimitErrorFixed;

    if (previewErrorFixed?.error) {
      client.tui.showToast({
        body: { message: previewErrorFixed.error.message ?? "You need access to gemini 3", title: "Gemini 3 Access Required", variant: "error" }
      }).catch(() => { });
    }

    return patched;
  };

  if (streaming && response.ok && isEventStreamResponse && response.body) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Streaming SSE (passthrough mode)",
    });

    const transformedBody = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(createSseTransformStream(errorHandler, sessionId, family))
      .pipeThrough(new TextEncoderStream());

    return new Response(transformedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  try {
    const text = await response.text();
    const headers = new Headers(response.headers);

    // Apply retry headers logic (omitted complex retry logic for brevity, relying on standard headers)

    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    const usageFromSse = streaming && isEventStreamResponse ? extractUsageFromSsePayload(text) : null;
    const parsed: GeminiApiBody | null = parseGeminiApiBody(text);

    if (sessionId && parsed) {
      const responseBody = parsed.response as any;
      if (responseBody?.candidates) {
        responseBody.candidates.forEach((candidate: any) => {
          if (candidate.groundingMetadata) {
            log.debug("Grounding metadata found", { groundingMetadata: candidate.groundingMetadata });
          }
          let fullText = "";
          let signature = "";
          if (candidate.content?.parts) {
            candidate.content.parts.forEach((part: any) => {
              if (part.thought) {
                if (part.text) fullText += part.text;
                if (part.thoughtSignature) signature = part.thoughtSignature;
              }
            });
          }
          if (fullText && signature) {
            cacheSignature(family, sessionId, fullText, signature);
            log.debug("Cached signature", { family, sessionId, textLen: fullText.length });
          }
        });
      }
    }

    // Apply error rewrites
    const previewErrorFixed = parsed ? rewriteGeminiPreviewAccessError(parsed, response.status, requestedModel) : null;
    const rateLimitErrorFixed = parsed && !previewErrorFixed ? rewriteGeminiRateLimitError(parsed) : null;

    const patched = previewErrorFixed ?? rateLimitErrorFixed;
    const effectiveBody = patched ?? parsed ?? undefined;

    const usage = usageFromSse ?? (effectiveBody ? extractUsageMetadata(effectiveBody) : null);
    if (usage) {
      log.debug("Usage metadata", {
        cachedContentTokenCount: usage.cachedContentTokenCount,
        promptTokenCount: usage.promptTokenCount,
        candidatesTokenCount: usage.candidatesTokenCount,
        totalTokenCount: usage.totalTokenCount,
        cacheHit: (usage.cachedContentTokenCount ?? 0) > 0,
      });
    }
    if (usage?.cachedContentTokenCount !== undefined) {
      log.debug("Cache HIT", { cachedTokens: usage.cachedContentTokenCount });
      headers.set("x-gemini-cached-content-token-count", String(usage.cachedContentTokenCount));
      if (usage.totalTokenCount !== undefined) {
        headers.set("x-gemini-total-token-count", String(usage.totalTokenCount));
      }
      if (usage.promptTokenCount !== undefined) {
        headers.set("x-gemini-prompt-token-count", String(usage.promptTokenCount));
      }
      if (usage.candidatesTokenCount !== undefined) {
        headers.set("x-gemini-candidates-token-count", String(usage.candidatesTokenCount));
      }
    }

    logAntigravityDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (fallback)" : undefined,
      headersOverride: headers,
    });

    if (previewErrorFixed?.error) {
      try {
        await client.tui.showToast({
          body: {
            message: previewErrorFixed.error.message ?? "You need access to gemini 3",
            title: "Gemini 3 Access Required",
            variant: "error",
          },
        });
      } catch { }
    }

    if (streaming && response.ok && isEventStreamResponse) {
      return new Response(transformStreamingPayload(text, errorHandler), init);
    }

    if (!parsed) {
      return new Response(text, init);
    }

    if (effectiveBody?.response !== undefined) {
      normalizeToolArgsInResponse(effectiveBody.response);
      return new Response(JSON.stringify(effectiveBody.response), init);
    }

    if (patched) {
      return new Response(JSON.stringify(patched), init);
    }

    return new Response(text, init);
  } catch (error) {
    logAntigravityDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Antigravity response",
    });
    printAntigravityConsole("error", "Failed to transform Antigravity response", error);
    return response;
  }
}

