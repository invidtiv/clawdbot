# ACP Claude Code Runtime

OpenClaw ACP runtime backend that uses the **Claude Code CLI** (`claude`) for agent sessions.

## How It Works

```
Channel (Telegram, etc.)
  -> OpenClaw gateway dispatch
    -> ACP control plane (auto-init for runtime.type=acp agents)
      -> claude-code backend (this extension)
        -> claude -p --output-format stream-json <prompt>
          -> Claude responds (Opus, Sonnet, etc.)
        -> NDJSON events mapped to ACP runtime events
      -> response streamed back to channel
```

Each turn spawns a fresh `claude -p` process. Session continuity is maintained
via `--resume <session-id>` — Claude Code persists sessions to
`~/.claude/sessions/*.jsonl`.

## Setup

### 1. Install the extension

Add to OpenClaw plugin load paths:

```bash
openclaw config set plugins.load.paths '["/path/to/existing/plugins", "/path/to/Bsclawdbot/extensions/acp-claude-code"]'
openclaw config set plugins.allow '["...existing...", "acp-claude-code"]'
```

### 2. Configure the plugin

```bash
openclaw config set plugins.entries.acp-claude-code '{
  "enabled": true,
  "config": {
    "command": "/home/bsdev/.local/bin/claude",
    "permissionMode": "plan",
    "defaultCwd": "/home/bsdev",
    "maxTurns": 10,
    "appendSystemPrompt": "You are being invoked by OpenClaw ACP."
  }
}'
```

### 3. Add the agent to ACP allowed list

```bash
# Get current list and append
openclaw config set acp.allowedAgents '["codex","claude","gemini","kimi","claude-code-agent"]'
```

### 4. Create an agent with ACP runtime

Add to `agents.list` in `~/.openclaw/openclaw.json`:

```json
{
  "id": "acp-test",
  "name": "ACP Claude Code Test",
  "runtime": {
    "type": "acp",
    "acp": {
      "agent": "claude-code-agent",
      "backend": "claude-code",
      "mode": "persistent",
      "cwd": "/home/bsdev"
    }
  }
}
```

Or use the CLI:

```bash
openclaw agents add acp-test --non-interactive --workspace /home/bsdev/.openclaw/workspace-acp-test
# Then manually add runtime.type=acp to the agent entry in openclaw.json
```

### 5. Bind to a Telegram bot

```bash
# Configure a Telegram bot account
openclaw config set channels.telegram.accounts.acptest '{
  "dmPolicy": "allowlist",
  "botToken": "YOUR_BOT_TOKEN",
  "allowFrom": [YOUR_TELEGRAM_USER_ID],
  "streaming": "off"
}'

# Bind the bot to the agent
openclaw agents bind --agent acp-test --bind "telegram:acptest"
```

### 6. Apply the dispatch patch (required until upstream supports DM-level ACP)

The OpenClaw dispatch layer doesn't auto-initialize ACP sessions for DM-level
messages. A patch to `dispatch-acp.runtime-*.js` in the dist is required.

The patch adds auto-initialization: when `resolveSession` returns `"none"` for
an agent with `runtime.type === "acp"`, it calls
`acpManager.initializeSession()` to bootstrap the ACP session on the fly.

See `src/auto-reply/reply/dispatch-acp.ts` for the source-level patch.

### 7. Restart the gateway

```bash
systemctl --user restart openclaw-gateway.service
```

## Configuration Reference

| Field                | Default         | Description                                     |
| -------------------- | --------------- | ----------------------------------------------- |
| `command`            | `claude`        | Path to Claude Code CLI binary                  |
| `model`              | (default)       | Model override (e.g. `claude-sonnet-4-6`)       |
| `permissionMode`     | `plan`          | `default`, `plan`, `auto`, `approved`, `bypass` |
| `defaultCwd`         | `process.cwd()` | Working directory for sessions                  |
| `maxTurns`           | `25`            | Max agentic turns per invocation                |
| `maxBudgetUsd`       | (none)          | Dollar spend limit per invocation               |
| `timeoutSeconds`     | `300`           | Per-turn timeout                                |
| `systemPrompt`       | (none)          | Replace default system prompt                   |
| `appendSystemPrompt` | (none)          | Append to default system prompt                 |
| `allowedTools`       | (all)           | Restrict to specific tools                      |
| `disallowedTools`    | (none)          | Block specific tools                            |
| `mcpConfig`          | (none)          | Path to MCP servers JSON                        |

Environment variable overrides: `CLAUDE_CODE_COMMAND`, `CLAUDE_CODE_MODEL`, `CLAUDE_CODE_CWD`.

## Gateway Methods

| Method                     | Description                           |
| -------------------------- | ------------------------------------- |
| `acp.claude-code.health`   | Returns `{healthy, version, command}` |
| `acp.claude-code.sessions` | Lists Claude Code sessions            |

## Architecture

```
extensions/acp-claude-code/
├── index.ts              # Plugin entry + gateway methods
├── openclaw.plugin.json  # Manifest + config schema + UI hints
├── package.json          # NPM metadata
├── runtime-api.ts        # Re-exports from openclaw/plugin-sdk/acp-runtime
├── test-integration.ts   # Integration test (bun test-integration.ts)
└── src/
    ├── config.ts         # Config resolution (plugin config + env vars)
    ├── process.ts        # Claude CLI spawn + NDJSON streaming
    ├── runtime.ts        # AcpRuntime implementation
    └── service.ts        # Plugin service lifecycle
```

The `ClaudeCodeRuntime` class implements the `AcpRuntime` interface:

- `ensureSession()` — Creates/tracks session state by key
- `runTurn()` — Spawns `claude -p --output-format stream-json`, streams events
- `cancel()` — Sends SIGINT to active process
- `close()` — Kills process and removes session state
- `doctor()` — Checks CLI availability via `claude --version`
