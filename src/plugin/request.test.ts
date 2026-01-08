import { expect, test, describe } from "bun:test";
import { prepareAntigravityRequest, isGenerativeLanguageRequest } from "./request";
import { overrideEndpointForRequest } from "./fetch-wrapper";
import { CODE_ASSIST_ENDPOINT, CODE_ASSIST_ENDPOINT_FALLBACKS } from "../constants";

describe("Interleaved Thinking Headers", () => {
  test("adds interleaved thinking header for claude thinking models", async () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-claude-sonnet-4-5-thinking:streamGenerateContent";
    
    const result = await prepareAntigravityRequest(
      url,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    const headers = result.init.headers as Headers;
    expect(headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
  });

  test("does NOT add header for non-thinking claude models", async () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-claude-sonnet-4-5:streamGenerateContent";
    
    const result = await prepareAntigravityRequest(
      url,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    const headers = result.init.headers as Headers;
    expect(headers.has("anthropic-beta")).toBe(false);
  });

  test("merges with existing anthropic-beta header", async () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-claude-sonnet-4-5-thinking:streamGenerateContent";
    const existingHeaders = { "anthropic-beta": "prompt-caching-2024-07-31" };
    
    const result = await prepareAntigravityRequest(
      url,
      { method: "POST", headers: existingHeaders, body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    const headers = result.init.headers as Headers;
    expect(headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31,interleaved-thinking-2025-05-14");
  });

  test("does not duplicate header if already present", async () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-claude-sonnet-4-5-thinking:streamGenerateContent";
    const existingHeaders = { "anthropic-beta": "interleaved-thinking-2025-05-14" };
    
    const result = await prepareAntigravityRequest(
      url,
      { method: "POST", headers: existingHeaders, body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    const headers = result.init.headers as Headers;
    expect(headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
  });
});

describe("URL Transformation", () => {
  test("isGenerativeLanguageRequest detects Gemini API URLs", () => {
    expect(isGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent")).toBe(true);
    expect(isGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent")).toBe(true);
    expect(isGenerativeLanguageRequest("https://example.com/api")).toBe(false);
    expect(isGenerativeLanguageRequest("https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent")).toBe(false);
  });

  test("transforms Gemini API URL to CODE_ASSIST_ENDPOINT", async () => {
    const originalUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent";
    
    const result = await prepareAntigravityRequest(
      originalUrl,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    expect(result.request).toBe(`${CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`);
  });

  test("transforms non-streaming URL correctly", async () => {
    const originalUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
    
    const result = await prepareAntigravityRequest(
      originalUrl,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    expect(result.request).toBe(`${CODE_ASSIST_ENDPOINT}/v1internal:generateContent`);
    expect(result.streaming).toBe(false);
  });

  test("sets streaming flag for streamGenerateContent action", async () => {
    const streamingUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent";
    const nonStreamingUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
    
    const streamingResult = await prepareAntigravityRequest(
      streamingUrl,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    const nonStreamingResult = await prepareAntigravityRequest(
      nonStreamingUrl,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    expect(streamingResult.streaming).toBe(true);
    expect(nonStreamingResult.streaming).toBe(false);
  });

  test("extracts and returns requested model from URL", async () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent";
    
    const result = await prepareAntigravityRequest(
      url,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );
    
    expect(result.requestedModel).toBe("gemini-3-flash");
  });

  test("aliases gemini-3-flash-preview to gemini-3-flash", async () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";

    const result = await prepareAntigravityRequest(
      url,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      "dummy-token",
      "dummy-project"
    );

    const body = JSON.parse(result.init.body as string);
    expect(body.model).toBe("gemini-3-flash");
  });
});

describe("Endpoint Fallback Override", () => {
  test("overrideEndpointForRequest replaces base URL with string input", () => {
    const preparedUrl = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse";
    const autopushEndpoint = CODE_ASSIST_ENDPOINT_FALLBACKS[1];
    
    const result = overrideEndpointForRequest(preparedUrl, autopushEndpoint!);
    
    expect(result).toBe("https://autopush-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  });

  test("overrideEndpointForRequest replaces base URL with URL input", () => {
    const preparedUrl = new URL("https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    const prodEndpoint = CODE_ASSIST_ENDPOINT_FALLBACKS[2];
    
    const result = overrideEndpointForRequest(preparedUrl, prodEndpoint!);
    
    expect(result).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  });

  test("overrideEndpointForRequest works with Request object", () => {
    const preparedUrl = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse";
    const request = new Request(preparedUrl, { method: "POST" });
    const autopushEndpoint = CODE_ASSIST_ENDPOINT_FALLBACKS[1];
    
    const result = overrideEndpointForRequest(request, autopushEndpoint!) as Request;
    
    expect(result.url).toBe("https://autopush-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  });

  test("fallback endpoints are in correct order", () => {
    expect(CODE_ASSIST_ENDPOINT_FALLBACKS[0]).toContain("daily");
    expect(CODE_ASSIST_ENDPOINT_FALLBACKS[1]).toContain("autopush");
    expect(CODE_ASSIST_ENDPOINT_FALLBACKS[2]).toBe("https://cloudcode-pa.googleapis.com");
  });
});
