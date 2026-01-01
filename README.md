# Opencode Antigravity OAuth Plugin

Use your Antigravity model quota with the Opencode coding agent.

## Features

- **Multi-Account Load Balancing** - Automatically rotates between multiple Google accounts when hitting rate limits
- **Google Search Tool** - Built-in web search with URL analysis and source citations
- **Ease of Use** - Uses Opencode's built-in transparent auth, and tries multiple endpoints for reliability
- **Cross-Model Conversations** - Switch between Gemini and Claude with thinking block preservation
- **Automatic Token Refresh** - Handles auth transparently

## Installation

1. Add to your [Opencode config](https://opencode.ai/docs/config/):
   
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-google-antigravity-auth"]
   }
   ```
2. Run `opencode auth login`
3. Select the Google provider and **OAuth with Google (Antigravity)**
4. Authenticate in your browser
5. (Optional) Add additional accounts for load balancing when prompted

The plugin listens on `http://localhost:36742/oauth-callback`. If that port is unavailable or you're headless, it falls back to a copy/paste flow.

## Multi-Account Load Balancing

Add up to 10 Google accounts to rotate through when hitting rate limits.

- **Sticky selection** - Uses the same account until it errors
- **Auto-rotation** - Switches on 429 or 5xx responses
- **Smart recovery** - Re-enables accounts after rate limit timeout

Account metadata is stored in `$XDG_DATA_HOME/opencode/antigravity-accounts.json`.

## Google Search Tool

The `google_search` tool enables real-time web search and URL analysis. Due to Gemini API limitations, native search tools can't be combined with custom tools in the same request—the plugin works around this by making separate API calls with only search tools enabled.

Works with all models (Gemini and Claude via proxy).

## Thinking Configuration

Configure thinking via `thinkingConfig` in your model options:

- **Gemini 3 models**: Use `thinkingLevel` (`"low"`, `"medium"`, `"high"`)
- **Gemini 2.5 / Claude models**: Use `thinkingBudget` (number)

```json
{
  "options": {
    "thinkingConfig": {
      "thinkingLevel": "high",
      "includeThoughts": true
    }
  }
}
```

## Claude Proxy Models

Access Claude models via `gemini-claude-*` names:

- `gemini-claude-sonnet-4-5`
- `gemini-claude-sonnet-4-5-thinking`
- `gemini-claude-opus-4-5-thinking`

Models with `-thinking` suffix automatically enable interleaved thinking (`anthropic-beta: interleaved-thinking-2025-05-14`), allowing Claude to reason between tool calls.

## Cross-Model Conversations

Switching between Claude and Gemini mid-conversation is supported. Thinking blocks are cached per model family—when switching families, the other family's thinking blocks are removed but text content is preserved.

## Updating

Opencode does not auto-update plugins. To update:

```bash
rm -rf ~/.cache/opencode/node_modules/opencode-google-antigravity-auth
opencode
```

## Troubleshooting

### Image Support

Add `modalities` to model definitions to enable image input:

```json
"modalities": { "input": ["text", "image"], "output": ["text"] }
```

### Tool Name Compatibility

Gemini requires tool names to match `^[a-zA-Z_][a-zA-Z0-9_-]*$`. The plugin auto-prefixes `t_` to names starting with digits. Disable problematic tools via config if needed.

### Incompatible Plugins

[`opencode-skills`](https://github.com/malhashemi/opencode-skills) is incompatible—use [openskills](https://github.com/numman-ali/openskills) instead.

## Debugging

```bash
opencode --log-level DEBUG --print-logs
```

Logs are stored in `~/.local/share/opencode/logs/`.

## Local Development

```bash
git clone https://github.com/shekohex/opencode-google-antigravity-auth.git
cd opencode-google-antigravity-auth
bun install
```

Load locally:

```json
{ "plugin": ["file:///absolute/path/to/opencode-google-antigravity-auth"] }
```

## Example Config

See [`example-config.json`](./example-config.json) for a full configuration with all supported models and thinking presets.

## Credits

- [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) by [@jenslys](https://github.com/jenslys)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) for Antigravity API reference
- [Mirrowel](https://github.com/Mirrowel) for Gemini/Claude tool behavior fixes
