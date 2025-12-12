import { tool } from "@opencode-ai/plugin";
import type { AntigravityTokenExchangeResult } from "./antigravity/oauth";
import { authorizeAntigravity, exchangeAntigravity } from "./antigravity/oauth";
import { ANTIGRAVITY_PROVIDER_ID, ANTIGRAVITY_REDIRECT_URI } from "./constants";
import { accessTokenExpired, isOAuthAuth } from "./plugin/auth";
import { promptProjectId } from "./plugin/cli";
import { startAntigravityDebugRequest } from "./plugin/debug";
import { createLogger, initLogger } from "./plugin/logger";
import { ensureProjectContext } from "./plugin/project";
import {
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from "./plugin/request";
import { getSessionId, toUrlString } from "./plugin/request-helpers";
import { executeSearch } from "./plugin/search";
import { startOAuthListener, type OAuthListener } from "./plugin/server";
import { refreshAccessToken } from "./plugin/token";
import type {
  GetAuth,
  LoaderResult,
  PluginContext,
  PluginResult,
  ProjectContextResult,
  Provider,
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

  let authRecord = auth;
  if (accessTokenExpired(authRecord)) {
    const refreshed = await refreshAccessToken(authRecord, client);
    if (!refreshed) {
      return null;
    }
    authRecord = refreshed;
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
    async execute(args, _ctx) {
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
      );
    },
  });
}

/**
 * Registers the Antigravity OAuth provider for Opencode, handling auth, request rewriting,
 * debug logging, and response normalization for Antigravity Code Assist endpoints.
 */
export const AntigravityOAuthPlugin = async (
  { client }: PluginContext,
): Promise<PluginResult> => {
  initLogger(client);

  let cachedGetAuth: GetAuth | null = null;

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

        return {
          apiKey: "",
          async fetch(input, init) {
            if (!isGenerativeLanguageRequest(input)) {
              return fetch(input, init);
            }

            const latestAuth = await getAuth();
            if (!isOAuthAuth(latestAuth)) {
              return fetch(input, init);
            }

            let authRecord = latestAuth;
            if (accessTokenExpired(authRecord)) {
              const refreshed = await refreshAccessToken(authRecord, client);
              if (!refreshed) {
                return fetch(input, init);
              }
              authRecord = refreshed;
            }

            const accessToken = authRecord.access;
            if (!accessToken) {
              return fetch(input, init);
            }

            /**
             * Ensures we have a usable project context for the current auth snapshot.
             */
            async function resolveProjectContext(): Promise<ProjectContextResult> {
              try {
                return await ensureProjectContext(authRecord, client);
              } catch (error) {
                if (error instanceof Error) {
                  console.error(error.message);
                }
                throw error;
              }
            }

            const projectContext = await resolveProjectContext();

            const {
              request,
              init: transformedInit,
              streaming,
              requestedModel,
            } = await prepareAntigravityRequest(
              input,
              init,
              accessToken,
              projectContext.effectiveProjectId,
            );

            const originalUrl = toUrlString(input);
            const resolvedUrl = toUrlString(request);
            const debugContext = startAntigravityDebugRequest({
              originalUrl,
              resolvedUrl,
              method: transformedInit.method,
              headers: transformedInit.headers,
              body: transformedInit.body,
              streaming,
              projectId: projectContext.effectiveProjectId,
              sessionId: getSessionId(),
            });

            const response = await fetch(request, transformedInit);
            return transformAntigravityResponse(response, streaming, client, debugContext, requestedModel, getSessionId());
          },
        };
      },
      methods: [
        {
          label: "OAuth with Antigravity",
          type: "oauth",
          authorize: async () => {
            console.log("\n=== Antigravity OAuth Setup ===");

            const isHeadless = !!(
              process.env.SSH_CONNECTION ||
              process.env.SSH_CLIENT ||
              process.env.SSH_TTY ||
              process.env.OPENCODE_HEADLESS
            );

            let listener: OAuthListener | null = null;
            if (!isHeadless) {
              try {
                listener = await startOAuthListener();
                const { host } = new URL(ANTIGRAVITY_REDIRECT_URI);
                console.log("1. You'll be asked to sign in to your Google account and grant permission.");
                console.log(
                  `2. We'll automatically capture the browser redirect on http://${host}. No need to paste anything back here.`,
                );
                console.log("3. Once you see the 'Authentication complete' page in your browser, return to this terminal.");
              } catch (error) {
                console.log("1. You'll be asked to sign in to your Google account and grant permission.");
                console.log("2. After you approve, the browser will try to redirect to a 'localhost' page.");
                console.log(
                  "3. This page will show an error like 'This site can't be reached'. This is perfectly normal and means it worked!",
                );
                console.log(
                  "4. Once you see that error, copy the entire URL from the address bar, paste it back here, and press Enter.",
                );
                if (error instanceof Error) {
                  console.log(`\nWarning: Couldn't start the local callback listener (${error.message}). Falling back to manual copy/paste.`);
                } else {
                  console.log("\nWarning: Couldn't start the local callback listener. Falling back to manual copy/paste.");
                }
              }
            } else {
              console.log("Headless environment detected. Using manual OAuth flow.");
              console.log("1. You'll be asked to sign in to your Google account and grant permission.");
              console.log("2. After you approve, the browser will redirect to a 'localhost' URL.");
              console.log(
                "3. Copy the ENTIRE URL from your browser's address bar (it will look like: http://localhost:51121/oauth-callback?code=...&state=...)",
              );
              console.log("4. Paste the URL back here and press Enter.");
            }
            console.log("\n");

            const projectId = await promptProjectId();
            const authorization = await authorizeAntigravity(projectId);

            if (listener) {
              return {
                url: authorization.url,
                instructions:
                  "Complete the sign-in flow in your browser. We'll automatically detect the redirect back to localhost.",
                method: "auto",
                callback: async (): Promise<AntigravityTokenExchangeResult> => {
                  try {
                    const callbackUrl = await listener.waitForCallback();
                    const code = callbackUrl.searchParams.get("code");
                    const state = callbackUrl.searchParams.get("state");

                    if (!code || !state) {
                      return {
                        type: "failed",
                        error: "Missing code or state in callback URL",
                      };
                    }

                    return await exchangeAntigravity(code, state);
                  } catch (error) {
                    return {
                      type: "failed",
                      error: error instanceof Error ? error.message : "Unknown error",
                    };
                  } finally {
                    try {
                      await listener?.close();
                    } catch {
                    }
                  }
                },
              };
            }

            return {
              url: authorization.url,
              instructions:
                "Visit the URL above, complete OAuth, ignore the localhost connection error, and paste the full redirected URL (e.g., http://localhost:51121/oauth-callback?code=...&state=...): ",
              method: "code",
              callback: async (callbackUrl: string): Promise<AntigravityTokenExchangeResult> => {
                try {
                  const url = new URL(callbackUrl);
                  const code = url.searchParams.get("code");
                  const state = url.searchParams.get("state");

                  if (!code || !state) {
                    return {
                      type: "failed",
                      error: "Missing code or state in callback URL",
                    };
                  }

                  return exchangeAntigravity(code, state);
                } catch (error) {
                  return {
                    type: "failed",
                    error: error instanceof Error ? error.message : "Unknown error",
                  };
                }
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
              message: 'Enter your Google API Key',
              key: 'apiKey',
            }
          ]
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
  };
};

