# x-ray

Minimal live Codex and Claude Code LLM-call counter.

```sh
npm install -g github:tototozip/x-ray
xray
```

Run `xray`. A floating macOS window opens and counts Codex and Claude Code model
calls until you stop it:

```txt
codex llm calls: 6
```

Click the floating window to toggle a larger details panel with per-model call
counts.

Use Codex in the desktop app or from another terminal. When you are done, close
the window or press Ctrl-C in the terminal running `xray`. `xray` restores your
Codex config before exiting.

## How it counts

`xray` counts live Codex request events at the point Codex sends work toward the
LLM service:

- It temporarily points Codex's OpenTelemetry exporter at a local receiver and
  counts each outbound Codex or Claude Code LLM request as it arrives.
- It deduplicates repeated telemetry records for the same request, so one model
  request increments the counter once.
- If the Codex desktop app is already open, `xray` relaunches it once after
  installing that temporary endpoint. This makes the app pick up live counting
  instead of falling back to delayed local logs.
- Claude Code sessions started after `xray` launches pick up the same local
  receiver through temporary `~/.claude/settings.json` telemetry env settings.
- It does not modify Codex config, app-server state, certificates, or macOS proxy
  settings permanently. On exit, it restores the original Codex and Claude Code
  config files.

This is intentionally limited to Codex and Claude Code. It avoids macOS system
proxy settings, local certificate trust, per-terminal wrapping, and log-database
polling.

A single visible user message can still produce more than one count when Codex
does background LLM work, such as generating the thread title. Those are counted
because they are also outbound model requests from your machine.

Tool events are not counted separately because they are not LLM requests. If the
model returns JSON or asks Codex to run a shell/Python command, that output is
part of the already-counted model request.

## Requirements

macOS, Node >= 20, and Codex or Claude Code installed. The floating window and
Codex app relaunch use the built-in `osascript`.
