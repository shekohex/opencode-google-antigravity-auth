import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./logger";

const log = createLogger("storage");

export interface AccountMetadata {
  email?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  isRateLimited?: boolean;
  rateLimitResetTime?: number;
}

export interface AccountStorage {
  version: 1;
  accounts: AccountMetadata[];
  activeIndex: number;
}

/**
 * Get the path to the OpenCode data directory.
 * Uses XDG Base Directory spec on Unix (~/.local/share), AppData on Windows.
 * This follows the same convention as auth.json storage.
 */
function getDataDir(): string {
  const platform = process.platform;
  
  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  
  // Unix-like systems (Linux, macOS)
  // Use XDG_DATA_HOME (~/.local/share) to store alongside auth.json
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdgData, "opencode");
}

/**
 * Get the full path to the antigravity accounts storage file.
 */
export function getStoragePath(): string {
  return join(getDataDir(), "antigravity-accounts.json");
}

/**
 * Load account metadata from storage.
 * Returns null if file doesn't exist or is invalid.
 */
export async function loadAccounts(): Promise<AccountStorage | null> {
  try {
    const path = getStoragePath();
    const content = await fs.readFile(path, "utf-8");
    const data = JSON.parse(content) as AccountStorage;
    
    // Validate structure
    if (data.version !== 1 || !Array.isArray(data.accounts)) {
      log.warn("Invalid storage format, ignoring");
      return null;
    }
    
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist yet, this is normal on first run
      return null;
    }
    log.error("Failed to load account storage", { error: String(error) });
    return null;
  }
}

/**
 * Save account metadata to storage.
 */
export async function saveAccounts(storage: AccountStorage): Promise<void> {
  try {
    const path = getStoragePath();
    
    // Ensure directory exists
    await fs.mkdir(dirname(path), { recursive: true });
    
    // Write with pretty formatting for debugging
    const content = JSON.stringify(storage, null, 2);
    await fs.writeFile(path, content, "utf-8");
  } catch (error) {
    log.error("Failed to save account storage", { error: String(error) });
    throw error;
  }
}

/**
 * Migrate from multi-account refresh string to storage format.
 * This is used when storage doesn't exist but auth.json has multi-account data.
 */
export function migrateFromRefreshString(
  accountsData: Array<{ refreshToken: string; projectId?: string; managedProjectId?: string }>,
  emails?: Array<string | undefined>
): AccountStorage {
  const now = Date.now();
  
  return {
    version: 1,
    accounts: accountsData.map((acc, index) => ({
      email: emails?.[index],
      refreshToken: acc.refreshToken,
      projectId: acc.projectId,
      managedProjectId: acc.managedProjectId,
      addedAt: now,
      lastUsed: index === 0 ? now : 0,
    })),
    activeIndex: 0,
  };
}
