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

`xray` counts live Codex request events at the point Codex sends work toward the
LLM service:

- It temporarily points Codex's OpenTelemetry exporter at a local receiver and
  counts each outbound Codex Responses websocket request as it arrives.
- It deduplicates repeated telemetry records for the same request, so one model
  request increments the counter once.
- If the Codex desktop app is already open, `xray` relaunches it once after
  installing that temporary endpoint. This makes the app pick up live counting
  instead of falling back to delayed local logs.
- It does not modify Codex config, app-server state, certificates, or macOS proxy
  settings permanently. On exit, it restores the original Codex config.

This is intentionally Codex-only. It avoids macOS system proxy settings, local
certificate trust, per-terminal wrapping, and log-database polling.

A single visible user message can still produce more than one count when Codex
does background LLM work, such as generating the thread title. Those are counted
because they are also outbound model requests from your machine.

## Requirements

macOS, Node >= 20, and Codex installed. The floating window and app relaunch use
the built-in `osascript`.
