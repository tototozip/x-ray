# x-ray

Minimal live Codex LLM-call counter.

```sh
npm install -g github:tototozip/x-ray
xray
```

Run `xray`. A floating macOS window opens and counts Codex model calls until you
stop it:

```txt
codex llm calls: 6
```

Use Codex in the desktop app or from another terminal. When you are done, close
the window or press Ctrl-C in the terminal running `xray`. `xray` restores your
Codex config before exiting.

## How it counts

`xray` uses Codex's own OpenTelemetry events instead of intercepting network
traffic:

- It starts a local OTLP receiver on `127.0.0.1`.
- It temporarily points Codex's user config at that receiver.
- It counts Codex request events for HTTPS model calls and WebSocket model calls.
- On exit, it restores the original Codex config exactly.

This is intentionally Codex-only. It avoids macOS system proxy settings, local
certificate trust, and per-terminal wrapping.

## Requirements

macOS, Node >= 20, and Codex installed. The floating window uses the built-in
`osascript`.
