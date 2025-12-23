import { describe, it, expect, beforeEach } from "bun:test";
import { AccountManager } from "./accounts";
import type { ManagedAccount } from "./accounts";

describe("AccountManager Tier Priority", () => {
  const mockAuth = {
    type: "oauth" as const,
    refresh: "1//refresh_token_1",
    access: "access_token_1",
    expires: 3600,
  };

  let manager: AccountManager;

  beforeEach(() => {
    // Start with a single account
    manager = new AccountManager(mockAuth);
  });

  it("should prioritize paid account over free account", () => {
    // Add free account (already has one from init, let's explicit update)
    const acc1 = manager.getAccounts()[0]!;
    acc1.tier = "free";
    acc1.email = "free@example.com";

    // Add paid account
    manager.addAccount(
      { refreshToken: "refresh_2", projectId: "proj_2" },
      "access_2",
      3600,
      "paid@example.com",
      "paid"
    );

    // Should pick paid account (index 1)
    const next = manager.getCurrentOrNextForFamily("gemini-pro");
    expect(next?.index).toBe(1);
    expect(next?.tier).toBe("paid");
  });

  it("should switch back to paid account when rate limit expires", () => {
    // Setup: free active, paid rate-limited
    const acc1 = manager.getAccounts()[0]!;
    acc1.tier = "free";
    acc1.email = "free@example.com";

    manager.addAccount(
      { refreshToken: "refresh_2", projectId: "proj_2" },
      "access_2",
      3600,
      "paid@example.com",
      "paid"
    );

    // Mark paid as rate-limited
    const paidAcc = manager.getAccounts()[1]!;
    manager.markRateLimited(paidAcc, 5000, "gemini-pro");

    // Should pick free account because paid is limited
    const active = manager.getCurrentOrNextForFamily("gemini-pro");
    expect(active?.index).toBe(0);
    expect(active?.tier).toBe("free");

    // Simulate time passing (reset limit)
    paidAcc.rateLimitResetTimes["gemini-pro"] = Date.now() - 1000;

    // Should switch back to paid
    const next = manager.getCurrentOrNextForFamily("gemini-pro");
    expect(next?.index).toBe(1);
    expect(next?.tier).toBe("paid");
  });

  it("should be sticky within same tier (no round-robin) unless limited", () => {
    // Setup: 2 paid accounts
    const acc1 = manager.getAccounts()[0]!;
    acc1.tier = "paid";
    acc1.email = "paid1@example.com";

    manager.addAccount(
      { refreshToken: "refresh_2", projectId: "proj_2" },
      "access_2",
      3600,
      "paid2@example.com",
      "paid"
    );

    // First call -> gets acc1 (index 0)
    let active = manager.getCurrentOrNextForFamily("gemini-pro");
    expect(active?.index).toBe(0);

    // Second call -> SHOULD still get acc1 (Stickiness)
    active = manager.getCurrentOrNextForFamily("gemini-pro");
    expect(active?.index).toBe(0);

    // Third call -> Still acc1
    active = manager.getCurrentOrNextForFamily("gemini-pro");
    expect(active?.index).toBe(0);

    // Now mark acc1 as rate limited
    manager.markRateLimited(acc1, 5000, "gemini-pro");

    // Fourth call -> Should switch to acc2 (index 1)
    active = manager.getCurrentOrNextForFamily("gemini-pro");
    expect(active?.index).toBe(1);

    // Fifth call -> Should stick to acc2
    active = manager.getCurrentOrNextForFamily("gemini-pro");
    expect(active?.index).toBe(1);
  });
});
