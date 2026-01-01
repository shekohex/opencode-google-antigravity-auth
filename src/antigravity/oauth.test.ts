import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { fetchAccountInfo } from "./oauth";

const mockFetch = mock(() => Promise.resolve(new Response()));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mockFetch.mockClear();
});

describe("fetchAccountInfo tier detection", () => {
  it("should preserve detected paid tier when projectId is missing (issue #17)", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            allowedTiers: [{ id: "free-tier", isDefault: true }],
            paidTier: { id: "g1-pro-tier" },
          }),
          { status: 200 }
        )
      )
    );

    const result = await fetchAccountInfo("test-token");

    expect(result.tier).toBe("paid");
    expect(result.projectId).toBe("");
  });

  it("should detect paid tier from allowedTiers when not legacy-tier", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            cloudaicompanionProject: "test-project-123",
            allowedTiers: [{ id: "premium-tier", isDefault: true }],
          }),
          { status: 200 }
        )
      )
    );

    const result = await fetchAccountInfo("test-token");

    expect(result.tier).toBe("paid");
    expect(result.projectId).toBe("test-project-123");
  });

  it("should default to free tier when no paid indicators present", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            cloudaicompanionProject: "test-project-123",
            allowedTiers: [{ id: "legacy-tier", isDefault: true }],
          }),
          { status: 200 }
        )
      )
    );

    const result = await fetchAccountInfo("test-token");

    expect(result.tier).toBe("free");
    expect(result.projectId).toBe("test-project-123");
  });

  it("should accumulate tier across multiple endpoint attempts", async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              paidTier: { id: "g1-pro-tier" },
            }),
            { status: 200 }
          )
        );
      }
      if (callCount === 2) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              cloudaicompanionProject: "found-project",
              allowedTiers: [{ id: "legacy-tier", isDefault: true }],
            }),
            { status: 200 }
          )
        );
      }
      return Promise.resolve(new Response("", { status: 500 }));
    });

    const result = await fetchAccountInfo("test-token");

    expect(result.tier).toBe("paid");
    expect(result.projectId).toBe("found-project");
  });

  it("should detect tiers independently for multiple accounts", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            cloudaicompanionProject: "paid-project",
            paidTier: { id: "g1-pro-tier" },
          }),
          { status: 200 }
        )
      )
    );

    const paidResult = await fetchAccountInfo("paid-account-token");
    expect(paidResult.tier).toBe("paid");

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            cloudaicompanionProject: "free-project",
            allowedTiers: [{ id: "legacy-tier", isDefault: true }],
          }),
          { status: 200 }
        )
      )
    );

    const freeResult = await fetchAccountInfo("free-account-token");
    expect(freeResult.tier).toBe("free");

    expect(paidResult.tier).toBe("paid");
    expect(freeResult.tier).toBe("free");
  });
});
