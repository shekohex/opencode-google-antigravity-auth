import type { OAuthAuthDetails, RefreshParts } from "./types";
import {
  parseMultiAccountRefresh,
  formatMultiAccountRefresh,
  parseRefreshParts,
  formatRefreshParts,
} from "./auth";
import { saveAccounts, type AccountStorage, type RateLimitState, type ModelFamily, type AccountTier } from "./storage";

export type { ModelFamily, AccountTier } from "./storage";

export interface ManagedAccount {
  index: number;
  parts: RefreshParts;
  access?: string;
  expires?: number;
  rateLimitResetTimes: RateLimitState;
  lastUsed: number;
  email?: string;
  tier?: AccountTier;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
}

function isRateLimitedForFamily(account: ManagedAccount, family: ModelFamily): boolean {
  const resetTime = account.rateLimitResetTimes[family];
  return resetTime !== undefined && Date.now() < resetTime;
}

function clearExpiredRateLimits(account: ManagedAccount): void {
  const now = Date.now();
  if (account.rateLimitResetTimes.claude !== undefined && now >= account.rateLimitResetTimes.claude) {
    delete account.rateLimitResetTimes.claude;
  }
  if (account.rateLimitResetTimes["gemini-flash"] !== undefined && now >= account.rateLimitResetTimes["gemini-flash"]) {
    delete account.rateLimitResetTimes["gemini-flash"];
  }
  if (account.rateLimitResetTimes["gemini-pro"] !== undefined && now >= account.rateLimitResetTimes["gemini-pro"]) {
    delete account.rateLimitResetTimes["gemini-pro"];
  }
}

/**
 * Manages multiple OAuth accounts with automatic rotation and rate limit handling.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private currentIndex = 0;
  private currentAccountIndex = -1;

  constructor(auth: OAuthAuthDetails, storedAccounts?: AccountStorage | null) {
    if (storedAccounts && storedAccounts.accounts.length > 0) {
      const activeIndex =
        typeof storedAccounts.activeIndex === "number" &&
        storedAccounts.activeIndex >= 0 &&
        storedAccounts.activeIndex < storedAccounts.accounts.length
          ? storedAccounts.activeIndex
          : 0;

      this.currentAccountIndex = activeIndex;
      this.currentIndex = activeIndex;

      this.accounts = storedAccounts.accounts.map((acc, index) => ({
        index,
        parts: {
          refreshToken: acc.refreshToken,
          projectId: acc.projectId,
          managedProjectId: acc.managedProjectId,
        },
        access: index === activeIndex ? auth.access : undefined,
        expires: index === activeIndex ? auth.expires : undefined,
        rateLimitResetTimes: acc.rateLimitResetTimes ?? {},
        lastUsed: acc.lastUsed,
        email: acc.email,
        tier: acc.tier,
        lastSwitchReason: acc.lastSwitchReason,
      }));
    } else {
      const multiAccount = parseMultiAccountRefresh(auth.refresh);

      this.currentAccountIndex = 0;
      this.currentIndex = 0;

      if (multiAccount.accounts.length > 0) {
        this.accounts = multiAccount.accounts.map((parts, index) => ({
          index,
          parts,
          access: index === 0 ? auth.access : undefined,
          expires: index === 0 ? auth.expires : undefined,
          rateLimitResetTimes: {},
          lastUsed: 0,
        }));
      } else {
        this.accounts.push({
          index: 0,
          parts: parseRefreshParts(auth.refresh),
          access: auth.access,
          expires: auth.expires,
          rateLimitResetTimes: {},
          lastUsed: 0,
        });
      }
    }
  }

  async save(): Promise<void> {
    const storage: AccountStorage = {
      version: 3,
      accounts: this.accounts.map((acc) => ({
        email: acc.email,
        tier: acc.tier,
        refreshToken: acc.parts.refreshToken,
        projectId: acc.parts.projectId,
        managedProjectId: acc.parts.managedProjectId,
        addedAt: acc.lastUsed || Date.now(),
        lastUsed: acc.lastUsed,
        lastSwitchReason: acc.lastSwitchReason,
        rateLimitResetTimes: acc.rateLimitResetTimes,
      })),
      activeIndex: Math.max(0, this.currentAccountIndex),
    };

    await saveAccounts(storage);
  }

  getCurrentAccount(): ManagedAccount | null {
    if (this.currentAccountIndex >= 0 && this.currentAccountIndex < this.accounts.length) {
      return this.accounts[this.currentAccountIndex] ?? null;
    }
    return null;
  }

  markSwitched(account: ManagedAccount, reason: "rate-limit" | "initial" | "rotation"): void {
    account.lastSwitchReason = reason;
    this.currentAccountIndex = account.index;
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  getCurrentOrNextForFamily(family: ModelFamily): ManagedAccount | null {
    this.accounts.forEach(clearExpiredRateLimits);

    const current = this.getCurrentAccount();
    if (current) {
      if (!isRateLimitedForFamily(current, family)) {
        const betterTierAvailable =
          current.tier !== "paid" &&
          this.accounts.some((a) => a.tier === "paid" && !isRateLimitedForFamily(a, family));

        if (!betterTierAvailable) {
          current.lastUsed = Date.now();
          return current;
        }
      }
    }

    const next = this.getNextForFamily(family);
    if (next) {
      this.currentAccountIndex = next.index;
    }
    return next;
  }

  getNextForFamily(family: ModelFamily): ManagedAccount | null {
    const available = this.accounts.filter((a) => !isRateLimitedForFamily(a, family));

    if (available.length === 0) {
      return null;
    }

    // Prioritize paid accounts
    const paidAvailable = available.filter((a) => a.tier === "paid");
    const pool = paidAvailable.length > 0 ? paidAvailable : available;

    const account = pool[this.currentIndex % pool.length];
    if (!account) {
      return null;
    }

    this.currentIndex++;
    account.lastUsed = Date.now();
    return account;
  }

  markRateLimited(account: ManagedAccount, retryAfterMs: number, family: ModelFamily): void {
    account.rateLimitResetTimes[family] = Date.now() + retryAfterMs;
  }

  updateAccount(account: ManagedAccount, access: string, expires: number, parts?: RefreshParts): void {
    account.access = access;
    account.expires = expires;
    if (parts) {
      account.parts = parts;
    }
  }

  toAuthDetails(): OAuthAuthDetails {
    const current = this.getCurrentAccount() || this.accounts[0];
    if (!current) {
      throw new Error("No accounts available");
    }

    return {
      type: "oauth",
      refresh: formatMultiAccountRefresh({ accounts: this.accounts.map((acc) => acc.parts) }),
      access: current.access || "",
      expires: current.expires || 0,
    };
  }

  addAccount(parts: RefreshParts, access?: string, expires?: number, email?: string, tier?: AccountTier): void {
    this.accounts.push({
      index: this.accounts.length,
      parts,
      access,
      expires,
      rateLimitResetTimes: {},
      lastUsed: 0,
      email,
      tier,
    });
  }

  removeAccount(index: number): boolean {
    if (index < 0 || index >= this.accounts.length) {
      return false;
    }
    this.accounts.splice(index, 1);
    this.accounts.forEach((acc, idx) => (acc.index = idx));
    return true;
  }

  getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  accountToAuth(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access ?? "",
      expires: account.expires ?? 0,
    };
  }

  getMinWaitTimeForFamily(family: ModelFamily): number {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return !isRateLimitedForFamily(a, family);
    });
    if (available.length > 0) {
      return 0;
    }

    const waitTimes = this.accounts
      .map((a) => a.rateLimitResetTimes[family])
      .filter((t): t is number => t !== undefined)
      .map((t) => Math.max(0, t - Date.now()));

    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }
}
