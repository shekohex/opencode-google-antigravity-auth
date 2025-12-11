import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface TestContext {
  client: OpencodeClient;
  server: { url: string; close(): void };
}

export const TEST_MODELS = {
  gemini25Flash: { providerID: "google", modelID: "gemini-2.5-flash" },
  gemini3Pro: { providerID: "google", modelID: "gemini-3-pro-preview" },
  claudeSonnet: { providerID: "google", modelID: "gemini-claude-sonnet-4-5-thinking-medium" },
} as const;

export async function createTestContext(): Promise<TestContext> {
  const { client, server } = await createOpencode({
    port: 0,
    timeout: 120000,
  });
  return { client, server };
}

export function dumpServerLogs(): void {
  try {
    const logDir = join(homedir(), ".local", "share", "opencode", "log");
    const files = readdirSync(logDir).filter(f => f.endsWith(".log")).sort().reverse();
    const latestFile = files[0];
    if (latestFile) {
      const latestLog = join(logDir, latestFile);
      const content = readFileSync(latestLog, "utf-8");
      const lines = content.split("\n").slice(-100);
      console.error("\n=== Server Log (last 100 lines) ===");
      console.error(lines.join("\n"));
      console.error("=== End Server Log ===\n");
    }
  } catch (err) {
    console.error("Failed to read server logs:", err);
  }
}

export async function createSession(
  ctx: TestContext,
  _options?: { model?: { providerID: string; modelID: string } }
): Promise<string> {
  const result = await ctx.client.session.create({
    body: {},
  });
  if (result.error) {
    throw new Error(`Failed to create session: ${JSON.stringify(result.error)}`);
  }
  return result.data.id;
}

export async function deleteSession(ctx: TestContext, sessionId: string): Promise<void> {
  await ctx.client.session.delete({ path: { id: sessionId } });
}

export async function sendPrompt(
  ctx: TestContext,
  sessionId: string,
  prompt: string,
  options?: { model?: { providerID: string; modelID: string }; tools?: Record<string, boolean> }
): Promise<{ info: { role: string }; parts: unknown[] } | null> {
  const result = await ctx.client.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text: prompt }],
      model: options?.model,
      tools: options?.tools,
    },
  });
  if (result.error) {
    console.error("Prompt error:", JSON.stringify(result.error, null, 2));
    dumpServerLogs();
    return null;
  }
  if (!result.data || !("info" in result.data)) {
    console.error("Unexpected response structure:", JSON.stringify(result, null, 2));
    dumpServerLogs();
    return null;
  }
  return result.data as unknown as { info: { role: string }; parts: unknown[] };
}

export async function getMessages(
  ctx: TestContext,
  sessionId: string
): Promise<Array<{ info: { role: string }; parts: unknown[] }>> {
  const result = await ctx.client.session.messages({
    path: { id: sessionId },
  });
  if (result.error) {
    throw new Error(`Failed to get messages: ${JSON.stringify(result.error)}`);
  }
  return result.data as unknown as Array<{ info: { role: string }; parts: unknown[] }>;
}

export async function waitForIdle(
  ctx: TestContext,
  sessionId: string,
  timeoutMs: number = 120000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await ctx.client.session.status({});
    if (result.error || !result.data || Object.keys(result.data).length === 0) {
      return;
    }
    const sessionStatus = result.data[sessionId];
    if (!sessionStatus || sessionStatus.type === "idle") {
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Session did not become idle within ${timeoutMs}ms`);
}

export function extractTextFromMessages(messages: Array<{ info: { role: string }; parts: unknown[] }>): string {
  let text = "";
  for (const msg of messages) {
    if (msg.info.role === "assistant" && msg.parts) {
      text += extractTextFromParts(msg.parts);
    }
  }
  return text;
}

export function extractTextFromParts(parts: unknown[]): string {
  let text = "";
  for (const part of parts) {
    if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
      text += (part as { text: string }).text + "\n";
    }
  }
  return text;
}
