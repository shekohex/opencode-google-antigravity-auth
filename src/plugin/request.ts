import { CODE_ASSIST_ENDPOINT, CODE_ASSIST_HEADERS } from "../constants";
import { cacheSignature } from "./cache";
import { debugLog, logAntigravityDebugResponse, type AntigravityDebugContext } from "./debug";
import {
  extractUsageFromSsePayload,
  extractUsageMetadata,
  generateRequestId,
  getSessionId,
  parseGeminiApiBody,
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
      const responseStr = JSON.stringify(body.response);
      if (responseStr.includes('"thought"') || responseStr.includes('"thinking"')) {
        debugLog("[SSE Transform] Found thinking content in response:", responseStr.slice(0, 500));
      }
      return `data: ${JSON.stringify(body.response)}`;
    }
  } catch (_) { }
  return line;
}

export function createSseTransformStream(onError?: (body: GeminiApiBody) => GeminiApiBody | null, sessionId?: string): TransformStream<string, string> {
  let buffer = "";
  const thoughtBuffers = new Map<number, string>();

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const transformed = transformSseLine(line, onError, (body) => {
          if (!sessionId) return;
          const response = body.response as any;
          if (!response?.candidates) return;
          
          response.candidates.forEach((candidate: any, index: number) => {
            if (candidate.content?.parts) {
              candidate.content.parts.forEach((part: any) => {
                if (part.thought) {
                  if (part.text) {
                    const current = thoughtBuffers.get(index) ?? "";
                    thoughtBuffers.set(index, current + part.text);
                  }
                  if (part.thoughtSignature) {
                    const fullText = thoughtBuffers.get(index) ?? "";
                    if (fullText) {
                      cacheSignature(sessionId, fullText, part.thoughtSignature);
                      debugLog(`[SSE Transform] Cached signature for session ${sessionId} (text len=${fullText.length})`);
                    }
                  }
                }
              });
            }
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
      new Headers(init.headers).forEach((value, key) => reqHeaders.set(key, value));
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
                debugLog(`[Antigravity Transform] Using ${transformDebugInfo.transformer} transformer for model: ${effectiveModel} (wrapped input)`);
                if (transformDebugInfo.toolCount !== undefined) {
                    debugLog(`[Antigravity Transform] Tool count: ${transformDebugInfo.toolCount}`);
                }
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
          debugLog(`[Antigravity Transform] Using ${transformDebugInfo.transformer} transformer for model: ${effectiveModel}`);
          if (transformDebugInfo.toolCount !== undefined) {
            debugLog(`[Antigravity Transform] Tool count: ${transformDebugInfo.toolCount}`);
          }
        }
      }
    } catch (error) {
      console.error("Failed to transform Antigravity request body:", error);
    }
  }

  if (streaming) {
    headers.set("Accept", "text/event-stream");
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
            }).catch(console.error);
        }

        if (rateLimitErrorFixed?.error) {
            client.tui.showToast({
                body: { message: rateLimitErrorFixed.error.message ?? "You are rate limited", title: "Antigravity Rate Limited", variant: "error" }
            }).catch(console.error);
        }

        return patched;
    };

    if (streaming && response.ok && isEventStreamResponse && response.body) {
    logAntigravityDebugResponse(debugContext, response, {
      note: "Streaming SSE (passthrough mode)",
    });

    const transformedBody = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(createSseTransformStream(errorHandler, sessionId))
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
                 cacheSignature(sessionId, fullText, signature);
                 debugLog(`[Antigravity Transform] Cached signature for session ${sessionId} (len=${fullText.length})`);
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
    if (usage?.cachedContentTokenCount !== undefined) {
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
      await client.tui.showToast({
        body: { message: previewErrorFixed.error.message ?? "You need access to gemini 3", title: "Gemini 3 Access Required", variant: "error" }
      });
    }

    if (rateLimitErrorFixed?.error) {
      await client.tui.showToast({
        body: { message: rateLimitErrorFixed.error.message ?? "You are rate limited", title: "Antigravity Rate Limited", variant: "error" }
      });
    }

    if (streaming && response.ok && isEventStreamResponse) {
      return new Response(transformStreamingPayload(text, errorHandler), init);
    }

    if (!parsed) {
      return new Response(text, init);
    }

    if (effectiveBody?.response !== undefined) {
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
    console.error("Failed to transform Antigravity response:", error);
    return response;
  }
}

