# Antigravity OAuth Plugin for Opencode

Authenticate the Opencode CLI with your Antigravity (Cloud Code) account so you can use the Antigravity-backed Gemini models with your existing quota.

## Setup

1. Add the plugin to your [Opencode config](https://opencode.ai/docs/config/):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-google-antigravity-auth"]
   }
   ```

2. Run `opencode auth login`.
3. Choose the Google provider and select **OAuth with Antigravity**.

The plugin spins up a local callback listener on `http://localhost:51121/oauth-callback`, so after approving in the browser you'll land on an "Authentication complete" page with no URL copy/paste required. If that port is already taken or you're headless, the CLI automatically falls back to the copy/paste flow and explains what to do.

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

Set `OPENCODE_ANTIGRAVITY_DEBUG=1` to capture Antigravity request/response logs. Logs are written to `antigravity-debug-<ISO>.log` in the current working directory.

```bash
OPENCODE_ANTIGRAVITY_DEBUG=1 opencode
```

Authorization headers are redacted; payload previews are truncated to 2 KB.

## How to test with Opencode

1. Install plugin locally as above or via registry.
2. Run `opencode auth login` and pick **Antigravity**.
3. Complete browser flow (or copy/paste if headless).
4. Issue a Gemini model request, e.g. `opencode run -m google/gemini-2.5-flash -p "hello"` or `opencode run -m google/gemini-3-pro-high -p "solve this"`.
5. Verify responses succeed and no API key prompt appears.

## Credits

This project is based on:
- [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) - Original Gemini OAuth implementation by [@jenslys](https://github.com/jenslys)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) - Reference implementation for Antigravity API translation

