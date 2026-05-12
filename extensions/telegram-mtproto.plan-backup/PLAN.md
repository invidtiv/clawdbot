# Telegram MTProto Userbot Plugin for OpenClaw

## Overview

A plugin that connects OpenClaw to a real Telegram user account via the MTProto protocol (not Bot API), enabling full account access: read any chat, send as the user, join groups, read history, handle media, and more.

## Bot API vs MTProto

|                  | Bot API (current @BsBrainBot)  | MTProto (this plugin)                   |
| ---------------- | ------------------------------ | --------------------------------------- |
| **Identity**     | Bot account                    | Real user account                       |
| **Access**       | Only messages sent to the bot  | All chats, groups, channels             |
| **Capabilities** | Limited                        | Full (read, send, join, history, media) |
| **Auth**         | Bot token from BotFather       | Phone + SMS code + optional 2FA         |
| **Library**      | grammy / node-telegram-bot-api | GramJS (`telegram` npm package)         |

## Library Choice: GramJS (Option A — Recommended)

- `telegram` npm package — full MTProto client in TypeScript
- Runs natively in Node.js (same runtime as OpenClaw)
- Session persistence via StringSession
- Supports: messages, media, voice, groups, channels, user info
- Alternatives considered:
  - Telethon (Python) — requires sidecar process, adds complexity
  - TDLib (C++) — heavy, requires compilation, overkill

## Plugin Structure

```
extensions/telegram-mtproto/
├── openclaw.plugin.json    # Plugin manifest (id, channels, configSchema)
├── package.json            # Dependencies (telegram/gramjs)
├── index.ts                # Plugin entry: register channel + tools
└── src/
    ├── client.ts           # GramJS client wrapper (auth, session, reconnect)
    ├── channel.ts          # OpenClaw ChannelPlugin implementation
    ├── acl.ts              # Per-user access control
    ├── observer.ts         # Group observer mode (monitor, summarize, report)
    └── tools.ts            # Agent tools (send, read, reply, screenshot, etc.)
```

## Config Schema (in openclaw.json)

```jsonc
// channels.telegram-mtproto
{
  "accounts": {
    "default": {
      "apiId": 30421066,
      "apiHash": "dc5f7e481d72f61dfbb42109ac12c903",
      "phone": "+351933297291",
      "session": "<stored StringSession after auth>",
    },
  },
  "acl": {
    "users": {
      "1082729605": {
        // Per-user rules
        "reply": true,
        "read": true,
        "call": true,
        "converse": true,
        "notify": true,
      },
      "987654321": {
        "reply": false,
        "read": true, // Read-only (observe)
        "call": false,
        "converse": false,
        "notify": false,
      },
    },
    "default": {
      // Default for unlisted users
      "reply": false,
      "read": false,
      "call": false,
      "converse": false,
      "notify": false,
    },
  },
  "groups": {
    "-1001234567890": {
      "mode": "observer", // observe | participate
      "summarize": true,
      "reportTo": "1082729605",
      "reportInterval": "6h",
    },
  },
}
```

## Agent Tools

| Tool                      | Description                                  |
| ------------------------- | -------------------------------------------- |
| `mtproto_send_message`    | Send a message to a user/group (ACL-gated)   |
| `mtproto_read_chat`       | Read recent messages from a chat (ACL-gated) |
| `mtproto_reply`           | Reply to a specific message                  |
| `mtproto_get_contacts`    | List contacts                                |
| `mtproto_search_messages` | Search message history                       |
| `mtproto_get_chat_info`   | Get chat/group/channel metadata              |
| `mtproto_take_screenshot` | Export chat as text/HTML                     |
| `mtproto_forward_message` | Forward messages between chats               |
| `mtproto_download_media`  | Download media from messages                 |

## Auth Flow

1. First run: plugin prompts for SMS code via Telegram bot (@BsBrainBot)
2. User replies with the code
3. If 2FA enabled, asks for password
4. Session string saved to config — subsequent starts are automatic

## Phases

### Phase 1: Core (MVP)

- GramJS client with auth (SMS + 2FA)
- Send/receive/reply messages
- Per-user ACL (whitelist model)
- Session persistence
- Basic tools: send, read, reply

### Phase 2: Observer Mode

- Group monitoring
- Periodic summaries and reports
- Event-based triggers (keywords, @mentions)

### Phase 3: Advanced

- Media handling (photos, videos, voice)
- Call support
- Chat export/screenshot
- Contact management
- Forward/cross-post

## Open Design Questions

1. **Plugin vs Standalone**: Plugin (inside container) or sidecar (separate container)?
2. **ACL granularity**: Per-group rules? Time-based? Rate limits?
3. **Message routing**: Always respond? Only when user inactive? Queue for review? Ghost mode?
4. **Identity**: Respond as user (indistinguishable) or with `[AI]:` prefix?
5. **Group observer**: Passive only or can post? Report triggers?
6. **Session security**: Encrypted storage? Separate secrets volume?
7. **Screenshot scope**: Render chat as image or export as text/HTML?

## Credentials (from Brain's config attempt)

- API ID: `30421066`
- API Hash: `dc5f7e481d72f61dfbb42109ac12c903`
- Phone: `+351933297291`
- STT: Enabled (voice transcription via gpt-4o-mini-transcribe)
