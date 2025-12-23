export type ModelFamily = "claude" | "gemini-flash" | "gemini-pro";

/**
 * Context passed to request transformers containing model info and session metadata.
 */
export interface TransformContext {
  model: string;
  family: ModelFamily;
  projectId: string;
  streaming: boolean;
  requestId: string;
  sessionId: string;
}

/**
 * Result from a request transformer, containing the transformed body and debug info.
 */
export interface TransformResult {
  body: string;
  debugInfo?: {
    transformer: "gemini" | "claude";
    toolCount?: number;
    toolsTransformed?: boolean;
  };
}

export type RequestPayload = Record<string, unknown>;

/**
 * Tool declaration structure in Antigravity/Gemini format.
 * Claude models require `input_schema` instead of `parameters`.
 */
export type ToolDeclaration = {
  functionDeclarations?: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    parametersJsonSchema?: Record<string, unknown>;
  }>;
  googleSearch?: Record<string, unknown>;
  google_search?: Record<string, unknown>;
  urlContext?: Record<string, unknown>;
  url_context?: Record<string, unknown>;
};
