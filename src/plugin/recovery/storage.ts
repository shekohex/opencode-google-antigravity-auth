import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MESSAGE_STORAGE, PART_STORAGE } from "./constants";
import type { StoredMessageMeta, StoredPart } from "./types";

export function generatePartId(): string {
  const timestamp = Date.now().toString(16);
  const random = Math.random().toString(36).substring(2, 10);
  return `prt_${timestamp}${random}`;
}

export function getMessageDir(sessionID: string): string {
  if (!existsSync(MESSAGE_STORAGE)) return "";

  const directPath = join(MESSAGE_STORAGE, sessionID);
  if (existsSync(directPath)) {
    return directPath;
  }

  try {
    for (const dir of readdirSync(MESSAGE_STORAGE)) {
      const sessionPath = join(MESSAGE_STORAGE, dir, sessionID);
      if (existsSync(sessionPath)) {
        return sessionPath;
      }
    }
  } catch {
    // Ignore read errors
  }

  return "";
}

export function readMessages(sessionID: string): StoredMessageMeta[] {
  const messageDir = getMessageDir(sessionID);
  if (!messageDir || !existsSync(messageDir)) return [];

  const messages: StoredMessageMeta[] = [];
  try {
    for (const file of readdirSync(messageDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = readFileSync(join(messageDir, file), "utf-8");
        messages.push(JSON.parse(content));
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }

  return messages.sort((a, b) => {
    const aTime = a.time?.created ?? 0;
    const bTime = b.time?.created ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    return a.id.localeCompare(b.id);
  });
}

export function readParts(messageID: string): StoredPart[] {
  const partDir = join(PART_STORAGE, messageID);
  if (!existsSync(partDir)) return [];

  const parts: StoredPart[] = [];
  try {
    for (const file of readdirSync(partDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = readFileSync(join(partDir, file), "utf-8");
        parts.push(JSON.parse(content));
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }

  return parts.sort((a, b) => a.id.localeCompare(b.id));
}

export function findMessageByIndexNeedingThinking(
  sessionID: string,
  targetIndex: number
): string | null {
  const messages = readMessages(sessionID);
  const assistantMessages = messages.filter((m) => m.role === "assistant");

  if (targetIndex >= 0 && targetIndex < assistantMessages.length) {
    return assistantMessages[targetIndex]?.id ?? null;
  }

  return null;
}

export function findMessagesWithOrphanThinking(sessionID: string): string[] {
  const messageDir = getMessageDir(sessionID);
  if (!messageDir) return [];

  const orphanMessages: string[] = [];

  try {
    for (const file of readdirSync(messageDir)) {
      if (!file.endsWith(".json")) continue;

      try {
        const content = readFileSync(join(messageDir, file), "utf-8");
        const meta = JSON.parse(content) as StoredMessageMeta;

        if (meta.role !== "assistant") continue;

        const parts = readParts(meta.id);
        const hasThinkingPart = parts.some(
          (p) => p.type === "thinking" || p.type === "redacted_thinking"
        );
        const hasReasoningPart = parts.some((p) => p.type === "reasoning");

        if ((hasThinkingPart || hasReasoningPart) && !hasLeadingThinking(parts)) {
          orphanMessages.push(meta.id);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }

  return orphanMessages;
}

function hasLeadingThinking(parts: StoredPart[]): boolean {
  if (parts.length === 0) return false;
  const firstPart = parts[0];
  if (!firstPart) return false;
  return (
    firstPart.type === "thinking" ||
    firstPart.type === "redacted_thinking" ||
    firstPart.type === "reasoning"
  );
}

export function findMessagesWithThinkingBlocks(sessionID: string): string[] {
  const messageDir = getMessageDir(sessionID);
  if (!messageDir) return [];

  const messagesWithThinking: string[] = [];

  try {
    for (const file of readdirSync(messageDir)) {
      if (!file.endsWith(".json")) continue;

      try {
        const content = readFileSync(join(messageDir, file), "utf-8");
        const meta = JSON.parse(content) as StoredMessageMeta;

        const parts = readParts(meta.id);
        const hasThinking = parts.some(
          (p) => p.type === "thinking" || p.type === "redacted_thinking" || p.type === "reasoning"
        );

        if (hasThinking) {
          messagesWithThinking.push(meta.id);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }

  return messagesWithThinking;
}

export function prependThinkingPart(sessionID: string, messageID: string): boolean {
  const partDir = join(PART_STORAGE, messageID);
  if (!existsSync(partDir)) {
    try {
      mkdirSync(partDir, { recursive: true });
    } catch {
      return false;
    }
  }

  const parts = readParts(messageID);
  const alreadyHasThinking = parts.some(
    (p) => p.type === "thinking" || p.type === "redacted_thinking" || p.type === "reasoning"
  );

  if (alreadyHasThinking) {
    return true;
  }

  const thinkingPart: StoredPart = {
    id: generatePartId(),
    sessionID,
    messageID,
    type: "thinking",
    text: "",
  };

  try {
    writeFileSync(join(partDir, `${thinkingPart.id}.json`), JSON.stringify(thinkingPart));
    return true;
  } catch {
    return false;
  }
}

export function stripThinkingParts(messageID: string): boolean {
  const partDir = join(PART_STORAGE, messageID);
  if (!existsSync(partDir)) return false;

  let removed = false;

  try {
    for (const file of readdirSync(partDir)) {
      if (!file.endsWith(".json")) continue;

      try {
        const partPath = join(partDir, file);
        const content = readFileSync(partPath, "utf-8");
        const part = JSON.parse(content) as StoredPart;

        if (
          part.type === "thinking" ||
          part.type === "redacted_thinking" ||
          part.type === "reasoning"
        ) {
          unlinkSync(partPath);
          removed = true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }

  return removed;
}
