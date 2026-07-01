# x-ray

Minimal live Codex and Claude Code LLM-call counter.

```sh
npm install -g github:tototozip/x-ray
xray
```

Run `xray`. A floating macOS window opens and counts Codex and Claude Code model
calls, plus risky returned model messages, until you stop it:

```txt
codex llm calls: 6
```

Click the floating window to toggle a larger details panel with per-model call
counts. Codex and Claude Code models use different bar colors, and risky
returned messages show as a red segment inside the model bar. The compact popup
also flashes red briefly when a risky returned message is detected. In the
details panel, click `Risky` to toggle a distribution of risky calls by detected
action, such as `git push`, `rm -rf`, `secret/auth`, `package install`, or
`cloud/infra`.

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
- Codex sessions started after `xray` launches also use a temporary local
  OpenAI reverse proxy through Codex's temporary `openai_base_url` config. This
  lets `xray` scan streamed responses in memory for risky markers.
- Claude Code sessions started after `xray` launches pick up the same local
  receiver through temporary `~/.claude/settings.json` telemetry env settings.
- Claude Code sessions started after `xray` launches also use a temporary local
  per-process HTTPS proxy and temporary CA file. `xray` scans streamed responses
  in memory and increments the risky count once per response when it sees
  destructive deletes, Git mutations, secret/auth access, network calls, package
  changes, file writes, process/system control, database mutations, cloud/infra
  commands, browser control, or broad filesystem scans.
- It does not modify Codex config, app-server state, certificates, or macOS proxy
  settings permanently. On exit, it restores the original Codex and Claude Code
  config files and removes the temporary proxy certificate files.

This is intentionally limited to Codex and Claude Code. It avoids macOS system
proxy settings, system certificate trust, per-terminal wrapping, and log-database
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
