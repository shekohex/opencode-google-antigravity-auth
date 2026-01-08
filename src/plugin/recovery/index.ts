import { createLogger } from "../logger";
import type { PluginClient } from "../types";
import {
  readParts,
  findMessagesWithOrphanThinking,
  findMessageByIndexNeedingThinking,
  prependThinkingPart,
} from "./storage";
import type { MessageInfo, MessageData, RecoveryErrorType } from "./types";

const log = createLogger("session-recovery");

const RECOVERY_RESUME_TEXT = "[session recovered - continuing previous task]";

function getErrorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error.toLowerCase();

  const errorObj = error as Record<string, unknown>;
  const paths = [
    errorObj.data,
    errorObj.error,
    errorObj,
    (errorObj.data as Record<string, unknown>)?.error,
  ];

  for (const obj of paths) {
    if (obj && typeof obj === "object") {
      const msg = (obj as Record<string, unknown>).message;
      if (typeof msg === "string" && msg.length > 0) {
        return msg.toLowerCase();
      }
    }
  }

  try {
    return JSON.stringify(error).toLowerCase();
  } catch {
    return "";
  }
}

function extractMessageIndex(error: unknown): number | null {
  const message = getErrorMessage(error);
  const match = message.match(/messages\.(\d+)/);
  if (!match || !match[1]) return null;
  return parseInt(match[1], 10);
}

export function detectErrorType(error: unknown): RecoveryErrorType | null {
  const message = getErrorMessage(error);

  if (
    message.includes("thinking") &&
    (message.includes("must start with") ||
      message.includes("first block") ||
      message.includes("preceeding") ||
      message.includes("preceding") ||
      (message.includes("expected") && message.includes("found")))
  ) {
    return "thinking_block_order";
  }

  return null;
}

export function isRecoverableError(error: unknown): boolean {
  return detectErrorType(error) !== null;
}

const TOAST_TITLES: Record<string, string> = {
  thinking_block_order: "Thinking Block Recovery",
};

const TOAST_MESSAGES: Record<string, string> = {
  thinking_block_order: "Fixing message structure...",
};

function getRecoveryToastContent(errorType: RecoveryErrorType | null): {
  title: string;
  message: string;
} {
  if (!errorType) {
    return {
      title: "Session Recovery",
      message: "Attempting to recover session...",
    };
  }
  return {
    title: TOAST_TITLES[errorType] || "Session Recovery",
    message: TOAST_MESSAGES[errorType] || "Attempting to recover session...",
  };
}

async function recoverThinkingBlockOrder(
  sessionID: string,
  _failedMsg: MessageData,
  error: unknown
): Promise<boolean> {
  const targetIndex = extractMessageIndex(error);
  if (targetIndex !== null) {
    const targetMessageID = findMessageByIndexNeedingThinking(sessionID, targetIndex);
    if (targetMessageID) {
      return prependThinkingPart(sessionID, targetMessageID);
    }
  }

  const orphanMessages = findMessagesWithOrphanThinking(sessionID);

  if (orphanMessages.length === 0) {
    return false;
  }

  let anySuccess = false;
  for (const messageID of orphanMessages) {
    if (prependThinkingPart(sessionID, messageID)) {
      anySuccess = true;
    }
  }

  return anySuccess;
}

export interface SessionRecoveryHook {
  handleSessionRecovery: (info: MessageInfo) => Promise<boolean>;
  isRecoverableError: (error: unknown) => boolean;
}

export interface SessionRecoveryContext {
  client: PluginClient;
  directory: string;
}

export function createSessionRecoveryHook(
  ctx: SessionRecoveryContext
): SessionRecoveryHook | null {
  const { client, directory } = ctx;
  const processingErrors = new Set<string>();

  const handleSessionRecovery = async (info: MessageInfo): Promise<boolean> => {
    if (!info || info.role !== "assistant" || !info.error) return false;

    const errorType = detectErrorType(info.error);
    if (!errorType) return false;

    const sessionID = info.sessionID;
    if (!sessionID) return false;

    let assistantMsgID = info.id;
    let msgs: MessageData[] | undefined;

    log.debug("Recovery attempt started", {
      errorType,
      sessionID,
      providedMsgID: assistantMsgID ?? "none",
    });

    await client.session.abort({ path: { id: sessionID } }).catch(() => {});

    const messagesResp = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    });
    msgs = (messagesResp as { data?: MessageData[] }).data;

    if (!assistantMsgID && msgs && msgs.length > 0) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.info?.role === "assistant" && m.info?.id) {
          assistantMsgID = m.info.id;
          log.debug("Found assistant message ID from session messages", {
            msgID: assistantMsgID,
            msgIndex: i,
          });
          break;
        }
      }
    }

    if (!assistantMsgID) {
      log.debug("No assistant message ID found, cannot recover");
      return false;
    }
    if (processingErrors.has(assistantMsgID)) return false;
    processingErrors.add(assistantMsgID);

    try {
      const failedMsg = msgs?.find((m) => m.info?.id === assistantMsgID);
      if (!failedMsg) {
        return false;
      }

      const toastContent = getRecoveryToastContent(errorType);
      await client.tui
        .showToast({
          body: {
            title: toastContent.title,
            message: toastContent.message,
            variant: "warning",
          },
        })
        .catch(() => {});

      let success = false;

      if (errorType === "thinking_block_order") {
        success = await recoverThinkingBlockOrder(sessionID, failedMsg, info.error);
      }

      return success;
    } catch (err) {
      log.error("Recovery failed", { error: String(err) });
      return false;
    } finally {
      processingErrors.delete(assistantMsgID);
    }
  };

  return {
    handleSessionRecovery,
    isRecoverableError,
  };
}
