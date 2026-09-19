# WhatsApp channel for Claude Code

Push WhatsApp messages into a **running** Claude Code session, and answer from
your phone. The session stays in your terminal — this is not a headless bridge.

```
WhatsApp ──► Baileys ──► MCP channel ──► your open Claude Code session
                              ▲                      │
                              └──── reply tool ◄─────┘
```

## Reply policy

Claude's transcript never reaches WhatsApp. Only the `reply` tool sends, and the
server's instructions permit it in exactly three cases:

| Situation | Sent to phone |
|---|---|
| Thinking, reading files, running commands, intermediate results | **no** |
| Tool-approval prompt (Bash, Write, …) | yes — as a tappable poll |
| A decision only you can make | yes |
| Task complete — short summary | yes |
| Blocked or failed | yes |

So the phone stays quiet while work happens, and buzzes when it matters.

## Install

Requires [Bun](https://bun.sh).

```bash
claude plugin marketplace add /path/to/parent-dir   # or publish it
claude plugin install whatsapp@<marketplace>
claude --channels plugin:whatsapp@<marketplace>
```

Channels are a research preview; a plugin that is not on Anthropic's allowlist
needs the development flag instead:

```bash
claude --dangerously-load-development-channels plugin:whatsapp@<marketplace>
```

Then pair with `/whatsapp:access pair`. If you already run the whatsapp-pi Pi
extension, credentials and allowlists migrate automatically on first start and
no QR scan is needed.

## Tools

| Tool | Purpose |
|---|---|
| `reply` | Send a message. Decisions, completion, blockers — not progress. |
| `send_image` | Send a local JPEG/PNG/GIF/WebP, up to 16 MB. |
| `react` | Emoji reaction — acknowledge without buzzing the phone. |
| `list_chats` | Recent conversations and their `chat_id`. |
| `search_history` | Stored history for one conversation. |

Inbound images arrive as a file path for Claude to `Read`; voice notes arrive
transcribed.

## Permission relay

A tool-approval prompt opens in the terminal **and** goes to your phone as a
poll (✅ Allow / ❌ Deny). Whichever answer lands first wins. If the poll cannot
be sent, the server falls back to a text prompt — reply `y <id>` or `n <id>`.

Only direct chats on `allowList` are asked. Group members never are.

## Layout

```
server.ts              channel layer: protocol, tools, reply policy
src/channel/           stdio guard, permission relay
src/services/          reused from whatsapp-pi, unchanged except storage paths
src/models/            reused from whatsapp-pi
skills/access/         /whatsapp:access
```

`src/services` and `src/models` are whatsapp-pi's service layer. Only
`storage-path.ts` differs: the storage root moved to
`~/.claude/channels/whatsapp/` and the Pi extension's directory became the
legacy root that migrates from.

## Caveats

- Channels are a research preview; the flag and protocol may change.
- Events arrive only while a session is open. For always-on, keep one running.
- Requires Anthropic auth (claude.ai or Console API key). Not on Bedrock,
  Vertex, or Foundry.
- Verbose mode is intentionally unavailable: it would raise pino to `trace`,
  and pino writes to stdout, which corrupts the MCP stream. Use `claude --debug`
  and read stderr.

## Credits

The WhatsApp half of this project is not original work. `src/services` and
`src/models` come from [**whatsapp-pi**](https://github.com/RaphaCastelloes/whatsapp-pi)
by [Rapha](https://github.com/RaphaCastelloes) — a WhatsApp extension for the
[Pi coding agent](https://pi.dev) — and are reused here substantially unchanged:
the Baileys socket, pairing and reconnection, allowlists, media download, voice
transcription, and conversation history are all theirs.

What this repository adds is the Claude Code channel layer: the MCP protocol
surface, the tools, the permission relay, the stdout guard, and the reply policy.

Both projects are MIT licensed. See [LICENSE](LICENSE).

## License

MIT
