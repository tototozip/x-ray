# x-ray

Minimal live LLM-call counter for coding agents.

```sh
npm install -g github:tototozip/x-ray
xray
```

By default it opens a tiny floating macOS window and exits, so your terminal stays free:

```txt
codex llm calls: 0
```

The window stays alive after the launch terminal exits. Close the window to stop the counter.

Supported adapters:

```sh
xray codex
xray claude
xray opencode
xray openclaw
xray pi
xray pii
```

It is intentionally local-only. It reads the agent's own local session/event files and never proxies network traffic, reads API keys, or sends telemetry.

Use terminal mode when you do not want a window:

```sh
xray --stdio
```

## How It Counts

- It counts model inference calls, not user prompts or agent tasks. One user request can increment the counter many times.
- Codex: counts new `event_msg` / `token_count` rows in `~/.codex/sessions`.
- Claude Code: counts new assistant JSONL messages with non-zero `usage` in `~/.claude/projects`.
- opencode: counts new `session.next.step.ended` rows in the local SQLite DB.
- OpenClaw: counts new assistant JSONL messages with non-zero `usage`.
- Pi/PII: counts new assistant JSONL messages with non-zero `usage`.

For live use, start `xray` before sending the task to the agent.
