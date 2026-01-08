import { tool } from "@opencode-ai/plugin";
import type { AntigravityTokenExchangeResult } from "./antigravity/oauth";
import { authorizeAntigravity, exchangeAntigravity } from "./antigravity/oauth";
import { ANTIGRAVITY_PROVIDER_ID, MAX_ACCOUNTS } from "./constants";
import { accessTokenExpired, isOAuthAuth, parseRefreshParts, formatMultiAccountRefresh } from "./plugin/auth";
import { AccountManager, type AccountTier } from "./plugin/accounts";
import { openBrowser } from "./plugin/browser";
import { promptProjectId, promptAddAnotherAccount } from "./plugin/cli";
import { createAntigravityFetch } from "./plugin/fetch-wrapper";
import { createLogger, initLogger } from "./plugin/logger";
import { ensureProjectContext } from "./plugin/project";
import { executeSearch } from "./plugin/search";
import { startOAuthListener, type OAuthListener } from "./plugin/server";
import { loadAccounts, saveAccounts } from "./plugin/storage";
import { refreshAccessToken } from "./plugin/token";
import { createSessionRecoveryHook } from "./plugin/recovery";
import type {
  GetAuth,
  LoaderResult,
  PluginContext,
  PluginResult,
  Provider,
  RefreshParts,
} from "./plugin/types";

const log = createLogger("plugin");

async function getAuthContext(
  getAuth: GetAuth,
  client: PluginContext["client"],
): Promise<{ accessToken: string; projectId: string } | null> {
  const auth = await getAuth();
  if (!isOAuthAuth(auth)) {
    return null;
  }

  const storedAccounts = await loadAccounts();
  const accountManager = new AccountManager(auth, storedAccounts);
  const account = accountManager.getCurrentOrNextForFamily("gemini-flash");
  if (!account) {
    return null;
  }

  let authRecord = accountManager.accountToAuth(account);

  if (accessTokenExpired(authRecord)) {
    const refreshed = await refreshAccessToken(authRecord, client);
    if (!refreshed) {
      return null;
    }

    authRecord = refreshed;
    const parts = parseRefreshParts(refreshed.refresh);
    accountManager.updateAccount(account, refreshed.access!, refreshed.expires!, parts);

    try {
      await client.auth.set({
        path: { id: ANTIGRAVITY_PROVIDER_ID },
        body: accountManager.toAuthDetails(),
      });
      await accountManager.save();
    } catch {}
  }

  const accessToken = authRecord.access;
  if (!accessToken) {
    return null;
  }

  try {
    const projectContext = await ensureProjectContext(authRecord, client);
    return { accessToken, projectId: projectContext.effectiveProjectId };
  } catch {
    return null;
  }
}

function createGoogleSearchTool(getAuth: GetAuth, client: PluginContext["client"]) {
  return tool({
    description: "Search the web using Google Search and analyze URLs. Returns real-time information from the internet with source citations. Use this when you need up-to-date information about current events, recent developments, or any topic that may have changed. You can also provide specific URLs to analyze. IMPORTANT: If the user mentions or provides any URLs in their query, you MUST extract those URLs and pass them in the 'urls' parameter for direct analysis.",
    args: {
      query: tool.schema.string().describe("The search query or question to answer using web search"),
      urls: tool.schema.array(tool.schema.string()).optional().describe("List of specific URLs to fetch and analyze. IMPORTANT: Always extract and include any URLs mentioned by the user in their query here."),
      thinking: tool.schema.boolean().optional().default(true).describe("Enable deep thinking for more thorough analysis (default: true)"),
    },
    async execute(args, ctx) {
      log.debug("Google Search tool called", { query: args.query, urlCount: args.urls?.length ?? 0 });

      const authContext = await getAuthContext(getAuth, client);
      if (!authContext) {
        return "Error: Not authenticated with Antigravity. Please run `opencode auth login` to authenticate.";
      }

      return executeSearch(
        {
          query: args.query,
          urls: args.urls,
          thinking: args.thinking,
        },
        authContext.accessToken,
        authContext.projectId,
        ctx.abort,
      );
    },
  });
}

async function authenticateSingleAccount(
  client: PluginContext["client"],
  isHeadless: boolean,
): Promise<{ refresh: string; access: string; expires: number; projectId: string; email?: string; tier?: AccountTier } | null> {
  let listener: OAuthListener | null = null;
  if (!isHeadless) {
    try {
      listener = await startOAuthListener();
    } catch (error) {
      await client.tui.showToast({
        body: {
          message: "Couldn't start callback listener. Falling back to manual copy/paste.",
          variant: "warning",
        },
      });
    }
  }

  const projectId = await promptProjectId();
  const authorization = await authorizeAntigravity(projectId);

  if (!isHeadless) {
    try {
      await openBrowser(authorization.url);
    } catch {
      await client.tui.showToast({
        body: {
          message: "Could not open browser automatically. Please copy/paste the URL.",
          variant: "warning",
        },
      });
    }
  }

  let result: AntigravityTokenExchangeResult;

  if (listener) {
    await client.tui.showToast({
      body: {
        message: "Waiting for browser authentication...",
        variant: "info",
      },
    });
    try {
      const callbackUrl = await listener.waitForCallback();
      const code = callbackUrl.searchParams.get("code");
      const state = callbackUrl.searchParams.get("state");

      if (!code || !state) {
        await client.tui.showToast({
          body: {
            message: "Missing code or state in callback URL",
            variant: "error",
          },
        });
        return null;
      }

      result = await exchangeAntigravity(code, state);
    } catch (error) {
      await client.tui.showToast({
        body: {
          message: `Authentication failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          variant: "error",
        },
      });
      return null;
    } finally {
      try {
        await listener.close();
      } catch {}
    }
  } else {
    console.log("\n=== Antigravity OAuth Setup ===");
    console.log(`Open this URL in your browser: ${authorization.url}\n`);
    const { createInterface } = await import("node:readline/promises");
    const { stdin, stdout } = await import("node:process");
    const rl = createInterface({ input: stdin, output: stdout });

    try {
      const callbackUrlStr = await rl.question("Paste the full redirect URL here: ");
      const callbackUrl = new URL(callbackUrlStr);
      const code = callbackUrl.searchParams.get("code");
      const state = callbackUrl.searchParams.get("state");

      if (!code || !state) {
        await client.tui.showToast({
          body: {
            message: "Missing code or state in callback URL",
            variant: "error",
          },
        });
        return null;
      }

      result = await exchangeAntigravity(code, state);
    } catch (error) {
      await client.tui.showToast({
        body: {
          message: `Authentication failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          variant: "error",
        },
      });
      return null;
    } finally {
      rl.close();
    }
  }

  if (result.type === "failed") {
    await client.tui.showToast({
      body: {
        message: `Authentication failed: ${result.error}`,
        variant: "error",
      },
    });
    return null;
  }

  return {
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    projectId: result.projectId,
    email: result.email,
    tier: result.tier as AccountTier,
  };
}

export const AntigravityOAuthPlugin = async ({ client, directory }: PluginContext): Promise<PluginResult> => {
  initLogger(client);

  let cachedGetAuth: GetAuth | null = null;

  const recoveryEnabled = process.env.ANTIGRAVITY_SESSION_RECOVERY !== '0';
  const sessionRecovery = recoveryEnabled ? createSessionRecoveryHook({ client, directory }) : null;

  return {
    auth: {
      provider: ANTIGRAVITY_PROVIDER_ID,
      loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | Record<string, unknown>> => {
        cachedGetAuth = getAuth;
        const auth = await getAuth();
        if (!isOAuthAuth(auth)) {
          return {};
        }

        if (provider.models) {
          for (const model of Object.values(provider.models)) {
            if (model) {
              model.cost = { input: 0, output: 0 };
            }
          }
        }

        const antigravityFetch = createAntigravityFetch(getAuth, client);

        return {
          apiKey: "",
          fetch: antigravityFetch,
        };
      },
      methods: [
        {
          label: "OAuth with Google (Antigravity)",
          type: "oauth",
          authorize: async () => {
            const isHeadless = !!(
              process.env.SSH_CONNECTION ||
              process.env.SSH_CLIENT ||
              process.env.SSH_TTY ||
              process.env.OPENCODE_HEADLESS
            );

            const accounts: Array<{
              refresh: string;
              access: string;
              expires: number;
              projectId: string;
              email?: string;
              tier?: AccountTier;
            }> = [];

            const firstAccount = await authenticateSingleAccount(client, isHeadless);
            if (!firstAccount) {
              return {
                url: "",
                instructions: "Authentication cancelled",
                method: "auto",
                callback: async () => ({ type: "failed" as const, error: "Authentication cancelled" }),
              };
            }

            accounts.push(firstAccount);
            await client.tui.showToast({
              body: {
                message: `Account 1 authenticated${firstAccount.email ? ` (${firstAccount.email})` : ""}`,
                variant: "success",
              },
            });

            while (accounts.length < MAX_ACCOUNTS) {
              const addAnother = await promptAddAnotherAccount(accounts.length);
              if (!addAnother) {
                break;
              }

              const nextAccount = await authenticateSingleAccount(client, isHeadless);

              if (!nextAccount) {
                await client.tui.showToast({
                  body: {
                    message: "Skipping this account...",
                    variant: "warning",
                  },
                });
                continue;
              }

              accounts.push(nextAccount);
              await client.tui.showToast({
                body: {
                  message: `Account ${accounts.length} authenticated${nextAccount.email ? ` (${nextAccount.email})` : ""}`,
                  variant: "success",
                },
              });
            }

            const refreshParts: RefreshParts[] = accounts.map((acc) => ({
              refreshToken: acc.refresh,
              projectId: acc.projectId,
              managedProjectId: undefined,
            }));

            const combinedRefresh = formatMultiAccountRefresh({ accounts: refreshParts });

            try {
              await saveAccounts({
                version: 3,
                accounts: accounts.map((acc, index) => ({
                  email: acc.email,
                  refreshToken: acc.refresh,
                  projectId: acc.projectId,
                  tier: acc.tier,
                  managedProjectId: undefined,
                  addedAt: Date.now(),
                  lastUsed: index === 0 ? Date.now() : 0,
                })),
                activeIndex: 0,
              });
            } catch (error) {
              console.error("[antigravity-auth] Failed to save account metadata:", error);
            }

            const firstAcc = accounts[0]!;
            return {
              url: "",
              instructions: "Multi-account setup complete!",
              method: "auto",
              callback: async (): Promise<AntigravityTokenExchangeResult> => {
                return {
                  type: "success",
                  refresh: combinedRefresh,
                  access: firstAcc.access,
                  expires: firstAcc.expires,
                  email: firstAcc.email,
                  projectId: firstAcc.projectId,
                  tier: firstAcc.tier,
                };
              },
            };
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
          prompts: [
            {
              type: "text",
              message: "Enter your Google API Key",
              key: "apiKey",
            },
          ],
        },
      ],
    },
    tool: {
      google_search: createGoogleSearchTool(() => {
        if (!cachedGetAuth) {
          throw new Error("Auth not initialized");
        }
        return cachedGetAuth();
      }, client),
    },
    event: async (input: { event: { type: string; properties?: unknown } }) => {
      if (sessionRecovery && input.event.type === "session.error") {
        const props = input.event.properties as Record<string, unknown> | undefined;
        const sessionID = props?.sessionID as string | undefined;
        const messageID = props?.messageID as string | undefined;
        const error = props?.error;

        if (sessionRecovery.isRecoverableError(error)) {
          const messageInfo = {
            id: messageID,
            role: "assistant" as const,
            sessionID,
            error,
          };

          const recovered = await sessionRecovery.handleSessionRecovery(messageInfo);

          if (recovered && sessionID) {
            await client.session.prompt({
              path: { id: sessionID },
              body: { parts: [{ type: "text", text: "continue" }] },
              query: { directory },
            }).catch(() => {});

            await client.tui.showToast({
              body: {
                title: "Session Recovered",
                message: "Continuing where you left off...",
                variant: "success",
              },
            }).catch(() => {});
          }
        }
      }
    },
  };
};
