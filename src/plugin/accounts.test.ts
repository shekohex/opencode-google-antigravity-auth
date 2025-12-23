import { describe, it, expect } from "bun:test";
import { AccountManager, type ModelFamily } from "./accounts";
import type { OAuthAuthDetails } from "./types";

const FAMILY: ModelFamily = "gemini-flash";

describe("AccountManager", () => {
  it("should initialize with single account", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_token_1|project_1",
      access: "access_token_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    expect(manager.getAccountCount()).toBe(1);
  });

  it("should parse multi-account refresh string", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1||refresh_2|project_2",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    expect(manager.getAccountCount()).toBe(2);
  });

  it("should return current account when not rate-limited", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1||refresh_2|project_2",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    const account = manager.getCurrentOrNextForFamily(FAMILY);

    expect(account).not.toBeNull();
    expect(account?.index).toBe(0);
  });

  it("should switch to next account when current is rate-limited", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1||refresh_2|project_2",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    const firstAccount = manager.getCurrentOrNextForFamily(FAMILY);

    manager.markRateLimited(firstAccount!, 60000, FAMILY);

    const secondAccount = manager.getCurrentOrNextForFamily(FAMILY);
    expect(secondAccount?.index).toBe(1);
  });

  it("should return null when all accounts are rate-limited", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1||refresh_2|project_2",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);

    const accounts = manager.getAccounts();
    accounts.forEach((acc) => manager.markRateLimited(acc, 60000, FAMILY));

    const next = manager.getCurrentOrNextForFamily(FAMILY);
    expect(next).toBeNull();
  });

  it("should un-rate-limit accounts after timeout expires", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    const account = manager.getCurrentOrNextForFamily(FAMILY);

    account!.rateLimitResetTimes[FAMILY] = Date.now() - 1000;

    const next = manager.getCurrentOrNextForFamily(FAMILY);
    expect(next).not.toBeNull();
    expect(next?.rateLimitResetTimes[FAMILY]).toBeUndefined();
  });

  it("should calculate minimum wait time correctly", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1||refresh_2|project_2",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    const accounts = manager.getAccounts();

    manager.markRateLimited(accounts[0]!, 30000, FAMILY);
    manager.markRateLimited(accounts[1]!, 60000, FAMILY);

    const waitTime = manager.getMinWaitTimeForFamily(FAMILY);
    expect(waitTime).toBeGreaterThanOrEqual(29000);
    expect(waitTime).toBeLessThanOrEqual(30000);
  });

  it("should track account usage", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1||refresh_2|project_2",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);

    const beforeTime = Date.now();
    const account = manager.getCurrentOrNextForFamily(FAMILY);
    const afterTime = Date.now();

    expect(account?.lastUsed).toBeGreaterThanOrEqual(beforeTime);
    expect(account?.lastUsed).toBeLessThanOrEqual(afterTime);
  });

  it("should track rate limits per model family", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "refresh_1|project_1",
      access: "access_1",
      expires: Date.now() + 3600000,
    };

    const manager = new AccountManager(auth);
    const account = manager.getCurrentOrNextForFamily("claude");

    manager.markRateLimited(account!, 60000, "claude");

    const claudeAccount = manager.getCurrentOrNextForFamily("claude");
    expect(claudeAccount).toBeNull();

    const geminiAccount = manager.getCurrentOrNextForFamily("gemini-flash");
    expect(geminiAccount).not.toBeNull();
    expect(geminiAccount?.index).toBe(0);
  });
});
