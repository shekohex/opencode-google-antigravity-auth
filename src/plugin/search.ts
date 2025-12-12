import {
  CODE_ASSIST_ENDPOINT,
  CODE_ASSIST_HEADERS,
  SEARCH_MODEL,
  SEARCH_THINKING_BUDGET_DEEP,
  SEARCH_THINKING_BUDGET_FAST,
} from "../constants";
import { createLogger } from "./logger";
import { generateRequestId, getSessionId } from "./request-helpers";

const log = createLogger("search");

interface GroundingChunk {
  web?: {
    uri?: string;
    title?: string;
  };
}

interface GroundingSupport {
  segment?: {
    startIndex?: number;
    endIndex?: number;
    text?: string;
  };
  groundingChunkIndices?: number[];
}

interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
  searchEntryPoint?: {
    renderedContent?: string;
  };
}

interface UrlMetadata {
  retrieved_url?: string;
  url_retrieval_status?: string;
}

interface UrlContextMetadata {
  url_metadata?: UrlMetadata[];
}

interface SearchResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
      role?: string;
    };
    finishReason?: string;
    groundingMetadata?: GroundingMetadata;
    urlContextMetadata?: UrlContextMetadata;
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

interface AntigravitySearchResponse {
  response?: SearchResponse;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export interface SearchArgs {
  query: string;
  urls?: string[];
  thinking?: boolean;
}

export interface SearchResult {
  text: string;
  sources: Array<{ title: string; url: string }>;
  searchQueries: string[];
  urlsRetrieved: Array<{ url: string; status: string }>;
}

function formatSearchResult(result: SearchResult): string {
  const lines: string[] = [];

  lines.push("## Search Results\n");
  lines.push(result.text);
  lines.push("");

  if (result.sources.length > 0) {
    lines.push("### Sources");
    for (const source of result.sources) {
      lines.push(`- [${source.title}](${source.url})`);
    }
    lines.push("");
  }

  if (result.urlsRetrieved.length > 0) {
    lines.push("### URLs Retrieved");
    for (const url of result.urlsRetrieved) {
      const status = url.status === "URL_RETRIEVAL_STATUS_SUCCESS" ? "✓" : "✗";
      lines.push(`- ${status} ${url.url}`);
    }
    lines.push("");
  }

  if (result.searchQueries.length > 0) {
    lines.push("### Search Queries Used");
    for (const q of result.searchQueries) {
      lines.push(`- "${q}"`);
    }
  }

  return lines.join("\n");
}

function parseSearchResponse(data: AntigravitySearchResponse): SearchResult {
  const result: SearchResult = {
    text: "",
    sources: [],
    searchQueries: [],
    urlsRetrieved: [],
  };

  const response = data.response;
  if (!response || !response.candidates || response.candidates.length === 0) {
    if (data.error) {
      result.text = `Error: ${data.error.message ?? "Unknown error"}`;
    } else if (response?.error) {
      result.text = `Error: ${response.error.message ?? "Unknown error"}`;
    }
    return result;
  }

  const candidate = response.candidates[0];
  if (!candidate) {
    return result;
  }

  if (candidate.content?.parts) {
    result.text = candidate.content.parts
      .map((p: { text?: string }) => p.text ?? "")
      .filter(Boolean)
      .join("\n");
  }

  if (candidate.groundingMetadata) {
    const gm = candidate.groundingMetadata;

    if (gm.webSearchQueries) {
      result.searchQueries = gm.webSearchQueries;
    }

    if (gm.groundingChunks) {
      for (const chunk of gm.groundingChunks) {
        if (chunk.web?.uri && chunk.web?.title) {
          result.sources.push({
            title: chunk.web.title,
            url: chunk.web.uri,
          });
        }
      }
    }
  }

  if (candidate.urlContextMetadata?.url_metadata) {
    for (const meta of candidate.urlContextMetadata.url_metadata) {
      if (meta.retrieved_url) {
        result.urlsRetrieved.push({
          url: meta.retrieved_url,
          status: meta.url_retrieval_status ?? "UNKNOWN",
        });
      }
    }
  }

  return result;
}

const SEARCH_SYSTEM_INSTRUCTION = `You are an expert web search assistant with access to Google Search and URL analysis tools.

Your capabilities:
- Use google_search to find real-time information from the web
- Use url_context to fetch and analyze content from specific URLs when provided

Guidelines:
- Always provide accurate, well-sourced information
- Cite your sources when presenting facts
- If analyzing URLs, extract the most relevant information
- Be concise but comprehensive in your responses
- If information is uncertain or conflicting, acknowledge it
- Focus on answering the user's question directly`;

export async function executeSearch(
  args: SearchArgs,
  accessToken: string,
  projectId: string,
): Promise<string> {
  const { query, urls, thinking = true } = args;

  let prompt = query;
  if (urls && urls.length > 0) {
    const urlList = urls.join("\n");
    prompt = `${query}\n\nURLs to analyze:\n${urlList}`;
  }

  const tools: Array<Record<string, unknown>> = [];
  tools.push({ googleSearch: {} });
  if (urls && urls.length > 0) {
    tools.push({ urlContext: {} });
  }

  const thinkingBudget = thinking ? SEARCH_THINKING_BUDGET_DEEP : SEARCH_THINKING_BUDGET_FAST;

  const requestPayload = {
    systemInstruction: {
      parts: [{ text: SEARCH_SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    tools,
    generationConfig: {
      thinkingConfig: {
        thinkingBudget,
        includeThoughts: false,
      },
    },
  };

  const wrappedBody = {
    project: projectId,
    model: SEARCH_MODEL,
    userAgent: "antigravity",
    requestId: generateRequestId(),
    request: {
      ...requestPayload,
      sessionId: getSessionId(),
    },
  };

  const url = `${CODE_ASSIST_ENDPOINT}/v1internal:generateContent`;

  log.debug("Executing search", {
    query,
    urlCount: urls?.length ?? 0,
    thinking,
    thinkingBudget,
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...CODE_ASSIST_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(wrappedBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.debug("Search API error", { status: response.status, error: errorText });
      return `## Search Error\n\nFailed to execute search: ${response.status} ${response.statusText}\n\n${errorText}`;
    }

    const data = (await response.json()) as AntigravitySearchResponse;
    log.debug("Search response received", { hasResponse: !!data.response });

    const result = parseSearchResponse(data);
    return formatSearchResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.debug("Search execution error", { error: message });
    return `## Search Error\n\nFailed to execute search: ${message}`;
  }
}
