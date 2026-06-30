# x-ray

Minimal live LLM-call counter for coding agents.

```sh
npm install -g github:tototozip/x-ray
xray
```

By default it watches Codex and prints one live line:

```txt
codex llm calls: 0
```

Supported adapters:

```sh
xray codex
xray opencode
xray openclaw
xray pi
xray pii
```

It is intentionally local-only. It reads the agent's own local session/event files and never proxies network traffic, reads API keys, or sends telemetry.

## How It Counts

- It counts model inference calls, not user prompts or agent tasks. One user request can increment the counter many times.
- Codex: counts new `event_msg` / `token_count` rows in `~/.codex/sessions`.
- opencode: counts new `session.next.step.ended` rows in the local SQLite DB.
- OpenClaw: counts new assistant JSONL messages with non-zero `usage`.
- Pi/PII: counts new assistant JSONL messages with non-zero `usage`.

For live use, start `xray` before sending the task to the agent. Use `--total` to count existing history too.
