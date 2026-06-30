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

`xray` uses Codex-local signals instead of intercepting network traffic:

- For Codex processes already running when `xray` starts, it reads the local
  Codex `logs_2.sqlite` database in read-only polling mode and counts new
  `response.created` events by unique response id.
- For Codex processes started after `xray`, it temporarily points Codex's
  OpenTelemetry exporter at a local receiver and counts request events.
- It does not modify Codex config, app-server state, certificates, or macOS proxy
  settings permanently. On exit, it restores the original Codex config.

This is intentionally Codex-only. It avoids macOS system proxy settings, local
certificate trust, per-terminal wrapping, and app restarts.

## Requirements

macOS, Node >= 20, Codex installed, and `sqlite3` available. The floating window
uses the built-in `osascript`.
