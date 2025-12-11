import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import {
  createTestContext,
  createSession,
  deleteSession,
  sendPrompt,
  extractTextFromParts,
  TEST_MODELS,
  type TestContext,
} from "./setup";

setDefaultTimeout(300000);

// Helper to skip tests in CI
const itSkipInCI = process.env.CI ? it.skip : it;

describe("Google Search Tool", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    if (process.env.CI) {
      console.log("Skipping integration tests in CI environment");
      return;
    }
    ctx = await createTestContext();
  });

  afterAll(() => {
    ctx?.server?.close();
  });

  describe("with Gemini 2.5 Flash", () => {
    let sessionId: string;

    beforeEach(async () => {
      if (process.env.CI) return;
      sessionId = await createSession(ctx);
    });

    afterEach(async () => {
      if (process.env.CI) return;
      if (sessionId) {
        try {
          await deleteSession(ctx, sessionId);
        } catch {}
      }
    });

    itSkipInCI("should enable google_search tool and return grounded results", async () => {
      const response = await sendPrompt(
        ctx,
        sessionId,
        "What is today's date and what are some current news headlines? Use google search to find real-time information.",
        {
          model: TEST_MODELS.gemini25Flash,
          tools: { google_search: true },
        }
      );

      expect(response).not.toBeNull();
      expect(response!.info.role).toBe("assistant");

      const assistantText = extractTextFromParts(response!.parts);
      expect(assistantText.length).toBeGreaterThan(0);
    });

    itSkipInCI("should work without google_search tool", async () => {
      const response = await sendPrompt(
        ctx,
        sessionId,
        "What is 2 + 2?",
        {
          model: TEST_MODELS.gemini25Flash,
        }
      );

      expect(response).not.toBeNull();
      const assistantText = extractTextFromParts(response!.parts);
      expect(assistantText).toContain("4");
    });
  });

  describe("with Gemini 3 Pro", () => {
    let sessionId: string;

    beforeEach(async () => {
      if (process.env.CI) return;
      sessionId = await createSession(ctx);
    });

    afterEach(async () => {
      if (process.env.CI) return;
      if (sessionId) {
        try {
          await deleteSession(ctx, sessionId);
        } catch {}
      }
    });

    itSkipInCI("should enable google_search tool and return grounded results", async () => {
      const response = await sendPrompt(
        ctx,
        sessionId,
        "Search the web for recent AI developments in the last week.",
        {
          model: TEST_MODELS.gemini3Pro,
          tools: { google_search: true },
        }
      );

      expect(response).not.toBeNull();
      expect(response!.info.role).toBe("assistant");

      const assistantText = extractTextFromParts(response!.parts);
      expect(assistantText.length).toBeGreaterThan(0);
    });
  });

  describe("with Claude Sonnet via Antigravity", () => {
    let sessionId: string;

    beforeEach(async () => {
      if (process.env.CI) return;
      sessionId = await createSession(ctx);
    });

    afterEach(async () => {
      if (process.env.CI) return;
      if (sessionId) {
        try {
          await deleteSession(ctx, sessionId);
        } catch {}
      }
    });

    itSkipInCI("should handle google_search tool with Claude model", async () => {
      const response = await sendPrompt(
        ctx,
        sessionId,
        "Search the web for recent developments in quantum computing.",
        {
          model: TEST_MODELS.claudeSonnet,
          tools: { google_search: true },
        }
      );

      expect(response).not.toBeNull();
      expect(response!.info.role).toBe("assistant");

      const assistantText = extractTextFromParts(response!.parts);
      expect(assistantText.length).toBeGreaterThan(0);
    });

    itSkipInCI("should work without google_search tool", async () => {
      const response = await sendPrompt(
        ctx,
        sessionId,
        "Explain what quantum entanglement is in simple terms.",
        {
          model: TEST_MODELS.claudeSonnet,
        }
      );

      expect(response).not.toBeNull();
      const assistantText = extractTextFromParts(response!.parts);
      expect(assistantText.length).toBeGreaterThan(50);
    });
  });
});
