# Antigravity OAuth Plugin for Opencode

Authenticate the Opencode CLI with your Antigravity (Cloud Code) account so you can use the Antigravity-backed Gemini models with your existing quota.

## Features

- **Multi-Account Load Balancing** - Automatically rotates between multiple Google accounts when hitting rate limits
- **Endpoint Fallback** - Tries 3 endpoints (daily → autopush → prod) for maximum reliability
- **Google Search Tool** - Built-in web search with URL analysis and source citations
- **Cross-Model Conversations** - Seamlessly switch between Gemini and Claude with thinking block preservation
- **Automatic Token Refresh** - Handles auth transparently with no manual intervention

## Setup

1. Add the plugin to your [Opencode config](https://opencode.ai/docs/config/):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-google-antigravity-auth"]
   }
   ```

2. Run `opencode auth login`.
3. Choose the Google provider and select **OAuth with Google (Antigravity)**.
4. Authenticate with your first Google account in the browser.
5. **Optional:** Add more accounts for load balancing when prompted.

The plugin spins up a local callback listener on `http://localhost:51121/oauth-callback`, so after approving in the browser you'll land on an "Authentication complete" page with no URL copy/paste required. If that port is already taken or you're headless, the CLI automatically falls back to the copy/paste flow and explains what to do.

## Multi-Account Load Balancing

The plugin supports **automatic rotation across multiple Google accounts** to work around rate limits.

### How It Works

- **Sticky Account Selection**: Uses the same account for all requests until it hits an error
- **Automatic Rotation**: When rate-limited (429) or server errors (5xx), switches to next account
- **Smart Recovery**: Automatically re-enables accounts after rate limit timeout expires
- **Email Tracking**: Shows which account is in use for easy debugging

### Setup Multiple Accounts

During `opencode auth login`, you'll be prompted to add additional accounts:

```
✓ Account 1 authenticated (user@gmail.com)
You have 1 account(s) configured. Add another? (y/n): y
```

You can add up to 10 accounts. The plugin stores account metadata in `$XDG_DATA_HOME/opencode/antigravity-accounts.json` (for example `~/.local/share/opencode/antigravity-accounts.json`).

### When To Use Multi-Account

- **High Volume Usage**: If you frequently hit Antigravity rate limits
- **Production Workflows**: Need maximum uptime for automated tasks
- **Team Environments**: Share quota across multiple Google accounts

### Monitoring

The plugin logs account switches:
```
[INFO] Using account 1/3 (user@gmail.com)
[INFO] Account 1/3 rate-limited, switching...
[INFO] Using account 2/3 (user2@gmail.com)
```

Toast notifications also appear when switching accounts.

## Google Search Tool

The plugin exposes a `google_search` tool that allows models to fetch real-time information from the web using Google Search and URL context analysis.

### How It Works

Due to Gemini API limitations, native search tools (`googleSearch`, `urlContext`) cannot be combined with function declarations (custom tools like `bash`, `read`, `write`) in the same request. The plugin solves this by implementing `google_search` as a **wrapper tool** that makes separate API calls to Gemini with only native search tools enabled.

```
Agent (with custom tools: bash, read, write, etc.)
    │
    └── Calls google_search tool
            │
            └── Makes SEPARATE API call to Gemini with:
                - Model: gemini-2.5-flash
                - Tools: [{ googleSearch: {} }, { urlContext: {} }]
                - Returns formatted markdown with sources
```

### Features

- **Web Search**: Query Google Search for real-time information
- **URL Analysis**: Fetch and analyze specific URLs when provided
- **Source Citations**: Returns grounded responses with source links
- **Thinking Mode**: Optional deep analysis with configurable thinking budget

### Usage

The tool is automatically available to models that support tool use. Simply ask questions that require current information:

```
"What are the latest news about AI?"
"Summarize this article: https://example.com/article"
"What's the current stock price of AAPL?"
```

When you provide URLs in your query, the model will automatically extract and analyze them.

### Supported Models

All models can use the `google_search` tool since it makes independent API calls:
- **Gemini models** (2.5 Flash, 3 Pro, etc.)
- **Claude models** (via Antigravity proxy)

## Updating

> [!WARNING]
> Opencode does NOT auto-update plugins.

To get the latest version, clear the cached plugin and let Opencode reinstall it:

```bash
rm -rf ~/.cache/opencode/node_modules/opencode-google-antigravity-auth
opencode
```

Alternatively, remove the dependency from `~/.cache/opencode/package.json` if the above doesn't work.

## Thinking Configuration

Antigravity forwards Gemini model options, including `thinkingConfig`:

* `thinkingLevel` for Gemini 3 models (`"low" | "medium" | "high"`).
* `thinkingBudget` for Gemini 2.5 models (number).

### Examples

```json
{
  "provider": {
    "antigravity": {
      "models": {
        "gemini-3-pro-preview": {
          "options": {
            "thinkingConfig": {
              "thinkingLevel": "high",
              "includeThoughts": true
            }
          }
        },
        "gemini-2.5-flash": {
          "options": {
            "thinkingConfig": {
              "thinkingBudget": 8192,
              "includeThoughts": true
            }
          }
        },
        "gemini-claude-opus-4-5-thinking": {
          "options": {
            "thinkingConfig": {
              "thinkingBudget": 32000,
              "includeThoughts": true
            }
          }
        }
      }
    }
  }
}
```

## Claude Proxy Models

Antigravity provides access to Claude models via `gemini-claude-*` model names. The plugin automatically transforms tool schemas for Claude compatibility.

### Available Claude Models
- `gemini-claude-sonnet-4-5` - Claude Sonnet 4.5
- `gemini-claude-sonnet-4-5-thinking` - Claude Sonnet 4.5 with thinking
- `gemini-claude-opus-4-5-thinking` - Claude Opus 4.5 with thinking

### Interleaved Thinking Support

When you use any Claude thinking model (models with `-thinking` suffix), the plugin automatically enables **interleaved thinking** by adding the `anthropic-beta: interleaved-thinking-2025-05-14` header to your requests.

**What is Interleaved Thinking?**

Without interleaved thinking, Claude thinks once at the beginning and then executes all tool calls. With interleaved thinking enabled, Claude can think *between* tool calls, allowing it to:

- **Reason about tool results** before deciding what to do next
- **Chain multiple tool calls** with reasoning steps in between
- **Make more nuanced decisions** based on intermediate results
- **Adapt its approach** as it learns more from each tool interaction

**Why This Matters for Coding Agents**

AI coding tools like Opencode heavily rely on tool use (reading files, searching code, running commands). Interleaved thinking significantly improves the quality of multi-step coding tasks because Claude can:

1. Read a file → *think about what it found* → decide which file to read next
2. Run a test → *analyze the failure* → make a targeted fix
3. Search for a pattern → *reason about the results* → refine the search

**Automatic Enablement**

You don't need to configure anything - when you use any `-thinking` Claude model variant, the plugin automatically:
- Detects the thinking model from the model name suffix
- Injects the `anthropic-beta: interleaved-thinking-2025-05-14` header
- Merges with any existing beta headers (e.g., for prompt caching)

This is enabled by default because if you're opting into extended thinking, you almost certainly want the improved reasoning that interleaved thinking provides for tool-heavy workflows.

## Local Development

```bash
git clone https://github.com/shekohex/opencode-google-antigravity-auth.git
cd opencode-google-antigravity-auth
bun install
```

To load a local checkout in Opencode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-google-antigravity-auth"]
}
```

## Example Opencode config with provider/models

You should copy that config to your opencode config file.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-google-antigravity-auth"],
  "provider": {
    "google": {
      "npm": "@ai-sdk/google",
      "models": {
        "gemini-3-pro-preview": {
          "id": "gemini-3-pro-preview",
          "name": "Gemini 3 Pro Preview",
          "release_date": "2025-11-18",
          "reasoning": true,
          "limit": { "context": 1000000, "output": 64000 },
          "cost": { "input": 2, "output": 12, "cache_read": 0.2 },
          "modalities": { "input": ["text", "image", "video", "audio", "pdf"], "output": ["text"] }
        },
        "gemini-3-pro-high": {
          "id": "gemini-3-pro-preview",
          "name": "Gemini 3 Pro Preview (High Thinking)",
          "options": { "thinkingConfig": { "thinkingLevel": "high", "includeThoughts": true } }
        },
        "gemini-3-pro-medium": {
          "id": "gemini-3-pro-preview",
          "name": "Gemini 3 Pro Preview (Medium Thinking)",
          "options": { "thinkingConfig": { "thinkingLevel": "medium", "includeThoughts": true } }
        },
        "gemini-3-pro-low": {
          "id": "gemini-3-pro-preview",
          "name": "Gemini 3 Pro Preview (Low Thinking)",
          "options": { "thinkingConfig": { "thinkingLevel": "low", "includeThoughts": true } }
        },
        "gemini-2.5-flash": {
          "id": "gemini-2.5-flash",
          "name": "Gemini 2.5 Flash",
          "release_date": "2025-03-20",
          "reasoning": true,
          "limit": { "context": 1048576, "output": 65536 },
          "cost": { "input": 0.3, "output": 2.5, "cache_read": 0.075 },
          "modalities": { "input": ["text", "image", "audio", "video", "pdf"], "output": ["text"] }
        },
        "gemini-2.5-flash-lite": {
          "id": "gemini-2.5-flash-lite",
          "name": "Gemini 2.5 Flash Lite",
          "release_date": "2025-06-17",
          "reasoning": true,
          "limit": { "context": 1048576, "output": 65536 },
          "cost": { "input": 0.1, "output": 0.4, "cache_read": 0.025 },
          "modalities": { "input": ["text", "image", "audio", "video", "pdf"], "output": ["text"] }
        },
        "gemini-claude-sonnet-4-5-thinking-high": {
          "id": "gemini-claude-sonnet-4-5-thinking",
          "name": "Claude Sonnet 4.5 (High Thinking)",
          "release_date": "2025-11-18",
          "reasoning": true,
          "limit": { "context": 200000, "output": 64000 },
          "cost": { "input": 3, "output": 15, "cache_read": 0.3 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "options": { "thinkingConfig": { "thinkingBudget": 32000, "includeThoughts": true } }
        },
        "gemini-claude-sonnet-4-5-thinking-medium": {
          "id": "gemini-claude-sonnet-4-5-thinking",
          "name": "Claude Sonnet 4.5 (Medium Thinking)",
          "release_date": "2025-11-18",
          "reasoning": true,
          "limit": { "context": 200000, "output": 64000 },
          "cost": { "input": 3, "output": 15, "cache_read": 0.3 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "options": { "thinkingConfig": { "thinkingBudget": 16000, "includeThoughts": true } }
        },
        "gemini-claude-sonnet-4-5-thinking-low": {
          "id": "gemini-claude-sonnet-4-5-thinking",
          "name": "Claude Sonnet 4.5 (Low Thinking)",
          "release_date": "2025-11-18",
          "reasoning": true,
          "limit": { "context": 200000, "output": 64000 },
          "cost": { "input": 3, "output": 15, "cache_read": 0.3 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "options": { "thinkingConfig": { "thinkingBudget": 4000, "includeThoughts": true } }
        },
        "gemini-claude-opus-4-5-thinking-high": {
          "id": "gemini-claude-opus-4-5-thinking",
          "name": "Claude Opus 4.5 (High Thinking)",
          "release_date": "2025-11-24",
          "reasoning": true,
          "limit": { "context": 200000, "output": 64000 },
          "cost": { "input": 5, "output": 25, "cache_read": 0.5 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "options": { "thinkingConfig": { "thinkingBudget": 32000, "includeThoughts": true } }
        },
        "gemini-claude-opus-4-5-thinking-medium": {
          "id": "gemini-claude-opus-4-5-thinking",
          "name": "Claude Opus 4.5 (Medium Thinking)",
          "release_date": "2025-11-24",
          "reasoning": true,
          "limit": { "context": 200000, "output": 64000 },
          "cost": { "input": 5, "output": 25, "cache_read": 0.5 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "options": { "thinkingConfig": { "thinkingBudget": 16000, "includeThoughts": true } }
        },
        "gemini-claude-opus-4-5-thinking-low": {
          "id": "gemini-claude-opus-4-5-thinking",
          "name": "Claude Opus 4.5 (Low Thinking)",
          "release_date": "2025-11-24",
          "reasoning": true,
          "limit": { "context": 200000, "output": 64000 },
          "cost": { "input": 5, "output": 25, "cache_read": 0.5 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "options": { "thinkingConfig": { "thinkingBudget": 4000, "includeThoughts": true } }
        }
      }
    }
  }
}
```

## Debugging Antigravity Requests

Use OpenCode's built-in logging to debug Antigravity requests:

```bash
opencode --log-level DEBUG --print-logs
```

Or just set the log level and check the log files:

```bash
opencode --log-level DEBUG
```

Log files are stored in `~/.local/share/opencode/logs/` (or `$XDG_DATA_HOME/opencode/logs/`).

## How to test with Opencode

1. Install plugin locally as above or via registry.
2. Run `opencode auth login` and pick **Antigravity**.
3. Complete browser flow (or copy/paste if headless).
4. Issue a Gemini model request, e.g. `opencode run -m google/gemini-2.5-flash -p "hello"` or `opencode run -m google/gemini-3-pro-high -p "solve this"`.
5. Verify responses succeed and no API key prompt appears.

## Troubleshooting

### Image Support

To enable image input for Antigravity models in OpenCode, you must add the `modalities` configuration to your model definitions in `opencode.json`:

```json
{
  "provider": {
    "google": {
      "models": {
        "gemini-3-pro-high": {
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          }
        },
        "claude-sonnet-4-5-thinking": {
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          }
        }
      }
    }
  }
}
```

Without the `modalities.input` array containing `"image"`, OpenCode will reject image inputs with the error: `"this model does not support image input"`. This applies to both Gemini and Claude models accessed through Antigravity.

**Note:** The example config in this README already includes proper `modalities` configuration for all models.

### Tool Name Compatibility with Gemini

Gemini API requires tool names to match the pattern `^[a-zA-Z_][a-zA-Z0-9_-]*$`, meaning they cannot start with numbers. The plugin automatically sanitizes tool names by prepending `t_` to any tool name that starts with a digit.

For example:
- `21st-dev-magic_component_builder` → `t_21st-dev-magic_component_builder`

This sanitization is transparent and automatic. However, if you encounter tool-related errors with Gemini models, you can disable problematic MCP servers in your config:

```json
{
  "provider": {
    "google": {
      "models": {
        "gemini-3-pro-high": {
          "tools": {
            "21st-dev-magic_*": false
          }
        }
      }
    }
  }
}
```

### Compatibility with `opencode-skills`

The [`opencode-skills`](https://github.com/malhashemi/opencode-skills) plugin is currently **incompatible** with this plugin. Using them together may cause `invalid_request_error` failures, especially with Claude thinking models, due to conflicts in message history handling.

**Recommended Alternative:**
We suggest using [openskills](https://github.com/numman-ali/openskills) instead, which provides similar functionality without these compatibility issues.

## Credits

This project is based on:
- [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) - Original Gemini OAuth implementation by [@jenslys](https://github.com/jenslys)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) - Reference implementation for Antigravity API translation

## Cross-Model Conversations

You can switch between Claude and Gemini models within the same conversation session. The plugin handles the complexities of thinking block signatures automatically.

### How It Works

When models generate "thinking" blocks (extended reasoning), each provider signs them cryptographically. These signatures are provider-specific and cannot be validated across providers. The plugin solves this with:

1. **Signature Caching**: Original signatures are cached before any transformation
2. **Bypass for Gemini**: A special bypass string is used when sending to Gemini
3. **Signature Restoration**: When returning to Claude, original signatures are restored from cache

### Behavior Summary

| Transition | Thinking Preserved | Notes |
|------------|-------------------|-------|
| Claude → Claude | ✅ All Claude thinking | Signatures validated normally |
| Claude → Gemini | ✅ All thinking (Claude + any prior Gemini) | Bypass signature applied |
| Gemini → Gemini | ✅ All thinking | Bypass signature applied |
| Gemini → Claude | ✅ Claude thinking only | Gemini thinking removed (can't restore valid Claude signature for it) |

### Multi-Turn Example

```
Turn 1: Claude (thinking) → "Let me analyze this..."
Turn 2: Switch to Gemini  → Receives Claude's thinking ✅
Turn 3: Gemini (thinking) → "Processing the request..."
Turn 4: Switch to Claude  → Receives Claude's Turn 1 thinking ✅, Gemini's removed
Turn 5: Switch to Gemini  → Receives all thinking (Claude + Gemini) ✅
```

### Key Points

- **Gemini is permissive**: Accepts all thinking blocks with the bypass signature
- **Claude is strict**: Only accepts thinking with valid Claude signatures
- **No data loss for same-provider**: Staying on the same provider preserves all thinking
- **Cross-provider has trade-offs**: Switching to Claude loses Gemini's thinking, but Claude's is always preserved via caching


