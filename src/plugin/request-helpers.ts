import { randomUUID } from "node:crypto";
import { getParamType } from "./tool-schema-cache";

const SESSION_ID = `-${Math.floor(Math.random() * 9_000_000_000_000_000)}`;

export function getSessionId(): string {
  return SESSION_ID;
}

export function generateRequestId(): string {
  return `agent-${randomUUID()}`;
}

export const ANTIGRAVITY_BASE_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";

export function applyAntigravitySystemInstruction(payload: Record<string, unknown>, model: string): void {
  const normalizedModel = model.toLowerCase();
  const needsInjection = normalizedModel.includes("claude")
    || normalizedModel.includes("gemini-3-pro")
    || normalizedModel.includes("gemini-3-flash");
  if (!needsInjection) {
    return;
  }

  const existing = payload.systemInstruction;
  let existingParts: Array<Record<string, unknown>> = [];
  let existingRecord: Record<string, unknown> | undefined;

  if (typeof existing === "string") {
    if (existing.length > 0) {
      existingParts = [{ text: existing }];
    }
  } else if (existing && typeof existing === "object") {
    existingRecord = existing as Record<string, unknown>;
    const parts = existingRecord.parts;
    if (Array.isArray(parts)) {
      existingParts = parts.filter(
        (part): part is Record<string, unknown> => typeof part === "object" && part !== null,
      );
    }
  }

  const nextParts = [{ text: ANTIGRAVITY_BASE_SYSTEM_INSTRUCTION }, ...existingParts];

  payload.systemInstruction = existingRecord
    ? { ...existingRecord, role: "user", parts: nextParts }
    : { role: "user", parts: nextParts };
}

const GEMINI_PREVIEW_LINK = "https://goo.gle/enable-preview-features";

export interface GeminiApiError {
  code?: number;
  message?: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * Minimal representation of Gemini API responses we touch.
 */
export interface GeminiApiBody {
  response?: unknown;
  error?: GeminiApiError;
  [key: string]: unknown;
}

/**
 * Usage metadata exposed by Gemini responses. Fields are optional to reflect partial payloads.
 */
export interface GeminiUsageMetadata {
  totalTokenCount?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

/**
 * Thinking configuration accepted by Gemini.
 * - Gemini 3 models use thinkingLevel (string: 'low', 'medium', 'high')
 * - Gemini 2.5 models use thinkingBudget (number)
 */
export interface ThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: string;
  includeThoughts?: boolean;
  include_thoughts?: boolean;
}

/**
 * Normalizes thinkingConfig - passes through values as-is without mapping.
 * User should use thinkingLevel for Gemini 3 and thinkingBudget for Gemini 2.5.
 */
export function normalizeThinkingConfig(config: unknown): ThinkingConfig | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const record = config as Record<string, unknown>;
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const levelRaw = record.thinkingLevel ?? record.thinking_level;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;

  const thinkingBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : undefined;
  const thinkingLevel = typeof levelRaw === "string" && levelRaw.length > 0 ? levelRaw.toLowerCase() : undefined;
  const includeThoughts = typeof includeRaw === "boolean" ? includeRaw : undefined;

  if (thinkingBudget === undefined && thinkingLevel === undefined && includeThoughts === undefined) {
    return undefined;
  }

  const normalized: ThinkingConfig = {};
  if (thinkingBudget !== undefined) {
    normalized.thinkingBudget = thinkingBudget;
  }
  if (thinkingLevel !== undefined) {
    normalized.thinkingLevel = thinkingLevel;
  }
  if (includeThoughts !== undefined) {
    normalized.include_thoughts = includeThoughts;
  }
  return normalized;
}

/**
 * Parses a Gemini API body; handles array-wrapped responses the API sometimes returns.
 */
export function parseGeminiApiBody(rawText: string): GeminiApiBody | null {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      const firstObject = parsed.find((item: unknown) => typeof item === "object" && item !== null);
      if (firstObject && typeof firstObject === "object") {
        return firstObject as GeminiApiBody;
      }
      return null;
    }

    if (parsed && typeof parsed === "object") {
      return parsed as GeminiApiBody;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts usageMetadata from a response object, guarding types.
 */
export function extractUsageMetadata(body: GeminiApiBody): GeminiUsageMetadata | null {
  const usage = (body.response && typeof body.response === "object"
    ? (body.response as { usageMetadata?: unknown }).usageMetadata
    : undefined) as GeminiUsageMetadata | undefined;

  if (!usage || typeof usage !== "object") {
    return null;
  }

  const asRecord = usage as Record<string, unknown>;
  const toNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  return {
    totalTokenCount: toNumber(asRecord.totalTokenCount),
    promptTokenCount: toNumber(asRecord.promptTokenCount),
    candidatesTokenCount: toNumber(asRecord.candidatesTokenCount),
    cachedContentTokenCount: toNumber(asRecord.cachedContentTokenCount),
  };
}

/**
 * Walks SSE lines to find a usage-bearing response chunk.
 */
export function extractUsageFromSsePayload(payload: string): GeminiUsageMetadata | null {
  const lines = payload.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const jsonText = line.slice(5).trim();
    if (!jsonText) {
      continue;
    }
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === "object") {
        const usage = extractUsageMetadata({ response: (parsed as Record<string, unknown>).response });
        if (usage) {
          return usage;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Enhances 404 errors for Gemini 3 models with a direct preview-access message.
 */
export function rewriteGeminiPreviewAccessError(
  body: GeminiApiBody,
  status: number,
  requestedModel?: string,
): GeminiApiBody | null {
  if (!needsPreviewAccessOverride(status, body, requestedModel)) {
    return null;
  }

  const error: GeminiApiError = body.error ?? {};
  const trimmedMessage = typeof error.message === "string" ? error.message.trim() : "";
  const messagePrefix = trimmedMessage.length > 0
    ? trimmedMessage
    : "Gemini 3 preview features are not enabled for this account.";
  const enhancedMessage = `${messagePrefix} Request preview access at ${GEMINI_PREVIEW_LINK} before using Gemini 3 models.`;

  return {
    ...body,
    error: {
      ...error,
      message: enhancedMessage,
    },
  };
}

function needsPreviewAccessOverride(
  status: number,
  body: GeminiApiBody,
  requestedModel?: string,
): boolean {
  if (status !== 404) {
    return false;
  }

  if (isGeminiThreeModel(requestedModel)) {
    return true;
  }

  const errorMessage = body.error && typeof body.error.message === "string" ? body.error.message : "";
  return isGeminiThreeModel(errorMessage);
}

interface ErrorDetail {
  "@type": string;
  reason?: string;
  domain?: string;
  metadata?: {
    quotaResetDelay?: string;
    quotaResetTimeStamp?: string;
    model?: string;
    [key: string]: string | undefined;
  };
  retryDelay?: string;
  [key: string]: unknown;
}

/**
 * Enhanced error handling for rate limits (429/Resource Exhausted).
 * Extracts quota reset time and formats a friendly message.
 */
export function rewriteGeminiRateLimitError(
  body: GeminiApiBody,
): GeminiApiBody | null {
  const error: GeminiApiError = body.error ?? {};
  
  // Check if it's a rate limit error (429 or RESOURCE_EXHAUSTED)
  const isRateLimit = error.code === 429 || error.status === "RESOURCE_EXHAUSTED";
  if (!isRateLimit) {
    return null;
  }

  // Use the message from the body if available, otherwise fallback
  const message = error.message ?? "You have exhausted your capacity on this model. Please try again later.";

  return {
    ...body,
    error: {
      ...error,
      message,
    },
  };
}

function isGeminiThreeModel(target?: string): boolean {
  if (!target) {
    return false;
  }

  return /gemini[\s-]?3/i.test(target);
}

export function toUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value;
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

function safeJsonParse(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function recursivelyParseJsonStrings(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => recursivelyParseJsonStrings(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, inner]) => [key, recursivelyParseJsonStrings(inner)]),
    );
  }

  if (typeof value !== "string") {
    return value;
  }

  const stripped = value.trim();

  const hasControlCharEscapes = value.includes("\\n") || value.includes("\\t");
  const hasIntentionalEscapes = value.includes('\\"') || value.includes("\\\\");

  if (hasControlCharEscapes && !hasIntentionalEscapes) {
    try {
      const unescaped = safeJsonParse(`"${value.replaceAll('"', '\\"')}"`);
      if (typeof unescaped === "string") {
        return unescaped;
      }
    } catch {
      // Fall through to other processing.
    }
  }

  if (stripped && (stripped.startsWith("{") || stripped.startsWith("["))) {
    const isWellFormed =
      (stripped.startsWith("{") && stripped.endsWith("}")) || (stripped.startsWith("[") && stripped.endsWith("]"));

    if (isWellFormed) {
      try {
        const parsed = safeJsonParse(value);
        return recursivelyParseJsonStrings(parsed);
      } catch {
        // Continue to malformed cases.
      }
    }

    if (stripped.startsWith("[") && !stripped.endsWith("]")) {
      try {
        const lastBracket = stripped.lastIndexOf("]");
        if (lastBracket > 0) {
          const cleaned = stripped.slice(0, lastBracket + 1);
          const parsed = safeJsonParse(cleaned);
          return recursivelyParseJsonStrings(parsed);
        }
      } catch {
        // Ignore.
      }
    }

    if (stripped.startsWith("{") && !stripped.endsWith("}")) {
      try {
        const lastBrace = stripped.lastIndexOf("}");
        if (lastBrace > 0) {
          const cleaned = stripped.slice(0, lastBrace + 1);
          const parsed = safeJsonParse(cleaned);
          return recursivelyParseJsonStrings(parsed);
        }
      } catch {
        // Ignore.
      }
    }
  }

  return value;
}

/**
 * Processes a value by only unescaping control characters (like \n, \t).
 * It does NOT attempt to parse JSON objects from strings.
 */
export function processEscapeSequencesOnly(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const hasControlCharEscapes = value.includes("\\n") || value.includes("\\t");
  const hasIntentionalEscapes = value.includes('\\"') || value.includes("\\\\");

  if (hasControlCharEscapes && !hasIntentionalEscapes) {
    try {
      // Use JSON.parse to correctly handle unescaping control characters
      const unescaped = JSON.parse(`"${value.replaceAll('"', '\\"')}"`);
      if (typeof unescaped === "string") {
        return unescaped;
      }
    } catch {
      // Fall back to original
    }
  }

  return value;
}

/**
 * Normalizes tool call arguments based on their schema.
 * - If schema says string: only unescape control characters, don't parse as JSON.
 * - If schema says array/object: attempt to parse string as JSON.
 * - If no schema: fallback to processEscapeSequencesOnly.
 */
export function normalizeToolCallArgs(args: unknown, toolName: string): unknown {
  if (!args || typeof args !== "object") {
    return args;
  }

  const record = args as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    const expectedType = getParamType(toolName, key);

    if (expectedType === "string") {
      result[key] = processEscapeSequencesOnly(value);
    } else if (typeof value === "string" && (expectedType === "array" || expectedType === "object")) {
      // If we expect an array/object but got a string, try to parse it
      try {
        const parsed = JSON.parse(value);
        result[key] = parsed;
      } catch {
        result[key] = processEscapeSequencesOnly(value);
      }
    } else if (expectedType === undefined) {
      // No schema info: be conservative and only unescape control characters
      result[key] = processEscapeSequencesOnly(value);
    } else {
      // For other types, or if it's already an object, just process escapes
      result[key] = processEscapeSequencesOnly(value);
    }
  }

  return result;
}
