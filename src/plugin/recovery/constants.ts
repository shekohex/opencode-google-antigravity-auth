import { join } from "node:path";
import { homedir } from "node:os";

function getXdgData(): string {
  const platform = process.platform;

  if (platform === "win32") {
    return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  }

  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

export const OPENCODE_STORAGE = join(getXdgData(), "opencode", "storage");
export const MESSAGE_STORAGE = join(OPENCODE_STORAGE, "message");
export const PART_STORAGE = join(OPENCODE_STORAGE, "part");

export const THINKING_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"]);
export const META_TYPES = new Set(["step-start", "step-finish"]);
export const CONTENT_TYPES = new Set(["text", "tool", "tool_use", "tool_result"]);
