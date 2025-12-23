import { describe, it, expect, mock, beforeEach } from "bun:test";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { loadAccounts, saveAccounts, getStoragePath, type AccountStorageV1, type AccountStorageV2, type AccountStorage } from "./storage";

// Mock filesystem
const mockFs = {
  readFile: mock(async (path: any): Promise<string> => { throw new Error("ENOENT"); }),
  writeFile: mock(async (path: any, data: any): Promise<void> => {}),
  mkdir: mock(async (path: any, options: any): Promise<void> => {}),
};

// Mock the fs module
mock.module("node:fs", () => ({
  promises: mockFs,
}));

// Mock logger to avoid console spam
mock.module("./logger", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

describe("storage migration", () => {
  beforeEach(() => {
    mockFs.readFile.mockReset();
    mockFs.writeFile.mockReset();
    mockFs.mkdir.mockReset();
  });

  it("should migrate v1 storage to v3", async () => {
    const now = Date.now();
    const futureTime = now + 60000;

    const v1Data: AccountStorageV1 = {
      version: 1,
      activeIndex: 0,
      accounts: [
        {
          email: "test@example.com",
          refreshToken: "token1",
          projectId: "project1",
          addedAt: now,
          lastUsed: now,
          isRateLimited: true,
          rateLimitResetTime: futureTime,
        },
        {
          email: "test2@example.com",
          refreshToken: "token2",
          projectId: "project2",
          addedAt: now,
          lastUsed: now,
          isRateLimited: false,
        },
      ],
    };

    mockFs.readFile.mockImplementation(async () => JSON.stringify(v1Data));

    const storage = await loadAccounts();

    expect(storage).not.toBeNull();
    expect(storage?.version).toBe(3);
    expect(storage?.accounts[0]?.rateLimitResetTimes).toEqual({
      claude: futureTime,
      "gemini-flash": futureTime,
      "gemini-pro": futureTime,
    });
    expect(storage?.accounts[1]?.rateLimitResetTimes).toBeUndefined();

    // Verify it saved the migrated data
    expect(mockFs.writeFile).toHaveBeenCalled();
    const savedContent = JSON.parse(mockFs.writeFile.mock.calls[0]?.[1] as string);
    expect(savedContent.version).toBe(3);
  });

  it("should preserve expired rate limits during v1 migration", async () => {
    const pastTime = Date.now() - 60000;

    const v1Data: AccountStorageV1 = {
      version: 1,
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "token1",
          addedAt: pastTime,
          lastUsed: pastTime,
          isRateLimited: true,
          rateLimitResetTime: pastTime,
        },
      ],
    };

    mockFs.readFile.mockImplementation(async () => JSON.stringify(v1Data));

    const storage = await loadAccounts();

    expect(storage).not.toBeNull();
    expect(storage?.version).toBe(3);
    expect(storage?.accounts[0]?.rateLimitResetTimes).toEqual({
      claude: pastTime,
      "gemini-flash": pastTime,
      "gemini-pro": pastTime,
    });
  });

  it("should migrate v2 storage to v3", async () => {
    const futureTime = Date.now() + 60000;
    const v2Data: AccountStorageV2 = {
      version: 2,
      activeIndex: 1,
      accounts: [
        {
          refreshToken: "token1",
          addedAt: Date.now(),
          lastUsed: Date.now(),
          rateLimitResetTimes: { claude: futureTime, gemini: futureTime },
        },
        {
          refreshToken: "token2",
          addedAt: Date.now(),
          lastUsed: Date.now(),
        },
      ],
    };

    mockFs.readFile.mockImplementation(async () => JSON.stringify(v2Data));

    const storage = await loadAccounts();

    expect(storage).not.toBeNull();
    expect(storage?.version).toBe(3);
    expect(storage?.accounts[0]?.rateLimitResetTimes).toEqual({
      claude: futureTime,
      "gemini-flash": futureTime,
      "gemini-pro": futureTime,
    });
    expect(storage?.accounts[1]?.rateLimitResetTimes).toBeUndefined();

    // Verify it saved the migrated data
    expect(mockFs.writeFile).toHaveBeenCalled();
    const savedContent = JSON.parse(mockFs.writeFile.mock.calls[0]?.[1] as string);
    expect(savedContent.version).toBe(3);
  });

  it("should preserve expired rate limits during v2 migration", async () => {
    const pastTime = Date.now() - 60000;
    const v2Data: AccountStorageV2 = {
      version: 2,
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "token1",
          addedAt: pastTime,
          lastUsed: pastTime,
          rateLimitResetTimes: { gemini: pastTime },
        },
      ],
    };

    mockFs.readFile.mockImplementation(async () => JSON.stringify(v2Data));

    const storage = await loadAccounts();

    expect(storage).not.toBeNull();
    expect(storage?.version).toBe(3);
    expect(storage?.accounts[0]?.rateLimitResetTimes).toEqual({
      "gemini-flash": pastTime,
      "gemini-pro": pastTime,
    });
  });

  it("should load v3 storage directly", async () => {
    const futureTime = Date.now() + 60000;
    const v3Data: AccountStorage = {
      version: 3,
      activeIndex: 1,
      accounts: [
        {
          refreshToken: "token1",
          addedAt: Date.now(),
          lastUsed: Date.now(),
          rateLimitResetTimes: { claude: futureTime, "gemini-flash": futureTime },
        },
        {
          refreshToken: "token2",
          addedAt: Date.now(),
          lastUsed: Date.now(),
        },
      ],
    };

    mockFs.readFile.mockImplementation(async () => JSON.stringify(v3Data));

    const storage = await loadAccounts();

    expect(storage).toEqual(v3Data);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("should preserve tier field in v3 storage", async () => {
    const now = Date.now();
    const v3Data: AccountStorage = {
      version: 3,
      activeIndex: 0,
      accounts: [
        {
          email: "paid@example.com",
          tier: "paid",
          refreshToken: "token1",
          addedAt: now,
          lastUsed: now,
        },
        {
          email: "free@example.com",
          tier: "free",
          refreshToken: "token2",
          addedAt: now,
          lastUsed: now,
        },
        {
          email: "unknown@example.com",
          refreshToken: "token3",
          addedAt: now,
          lastUsed: now,
        },
      ],
    };

    mockFs.readFile.mockImplementation(async () => JSON.stringify(v3Data));

    const storage = await loadAccounts();

    expect(storage).not.toBeNull();
    expect(storage?.accounts[0]?.tier).toBe("paid");
    expect(storage?.accounts[1]?.tier).toBe("free");
    expect(storage?.accounts[2]?.tier).toBeUndefined();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("should handle missing file (ENOENT)", async () => {
    mockFs.readFile.mockImplementation(async () => {
      const error: any = new Error("ENOENT");
      error.code = "ENOENT";
      throw error;
    });

    const storage = await loadAccounts();
    expect(storage).toBeNull();
  });

  it("should handle invalid JSON", async () => {
    mockFs.readFile.mockImplementation(async () => "invalid json");

    const storage = await loadAccounts();
    expect(storage).toBeNull();
  });

  it("should ignore unknown version", async () => {
    const unknownVersionData = {
      version: 999,
      activeIndex: 0,
      accounts: [],
    };

    mockFs.readFile.mockImplementation(async () => JSON.stringify(unknownVersionData));

    const storage = await loadAccounts();
    expect(storage).toBeNull();
  });

  it("should ignore missing version (undefined)", async () => {
    const noVersionData = {
      activeIndex: 0,
      accounts: [],
    };

    mockFs.readFile.mockImplementation(async () => JSON.stringify(noVersionData));

    const storage = await loadAccounts();
    expect(storage).toBeNull();
  });
});
