export const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_CLIENT_SECRET = "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";
export const ANTIGRAVITY_CALLBACK_PORT = 36742;
export const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_CALLBACK_PORT}/oauth-callback`;

export const ANTIGRAVITY_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const ANTIGRAVITY_USER_AGENT = "antigravity/1.11.5 windows/amd64";
export const ANTIGRAVITY_API_CLIENT = "google-cloud-sdk vscode_cloudshelleditor/0.1";
export const ANTIGRAVITY_CLIENT_METADATA = '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}';

/**
 * Root endpoints for the Antigravity API (in fallback order).
 */
export const CODE_ASSIST_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const CODE_ASSIST_ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com";
export const CODE_ASSIST_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

/**
 * Endpoint fallback order (daily → autopush → prod).
 */
export const CODE_ASSIST_ENDPOINT_FALLBACKS = [
  CODE_ASSIST_ENDPOINT_DAILY,
  CODE_ASSIST_ENDPOINT_AUTOPUSH,
  CODE_ASSIST_ENDPOINT_PROD,
] as const;

/**
 * Primary endpoint to use (daily sandbox - same as CLIProxy/Vibeproxy).
 */
export const CODE_ASSIST_ENDPOINT = CODE_ASSIST_ENDPOINT_DAILY;
export const CODE_ASSIST_API_VERSION = "v1internal";

export const CODE_ASSIST_HEADERS = {
  "User-Agent": ANTIGRAVITY_USER_AGENT,
  "X-Goog-Api-Client": ANTIGRAVITY_API_CLIENT,
  "Client-Metadata": ANTIGRAVITY_CLIENT_METADATA,
} as const;

export const ANTIGRAVITY_PROVIDER_ID = "google";

export const SEARCH_MODEL = "gemini-2.5-flash";
export const SEARCH_THINKING_BUDGET_FAST = 4096;
export const SEARCH_THINKING_BUDGET_DEEP = 16384;
export const SEARCH_TIMEOUT_MS = 60 * 1000;

export const MAX_ACCOUNTS = 10;
