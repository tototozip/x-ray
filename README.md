# x-ray

Minimal, exact live LLM-call counter for coding agents.

```sh
npm install -g github:tototozip/x-ray
xray
```

Run `xray`. A floating macOS window pops up, and it counts **every LLM call made
from your machine** — whether you talk to Codex in the terminal or in the app,
or to any other agent. The window ticks up the instant a call goes out:

```txt
llm calls: 6
```

Close the window or `exit` to stop — it puts everything back the way it was.

The first time, macOS asks once for your password so `xray` can trust its own
local certificate (needed to read the count); after that it just works.

> **Desktop agent apps** (e.g. the Codex app): start `xray` first, then
> **quit and reopen the app** so its engine picks up the proxy. Apps already
> running when `xray` starts won't be counted until relaunched.

## How it counts

Every model inference is one HTTPS request from your machine to the provider's
API. `xray` counts those requests directly, at the source:

- It starts a local proxy on `127.0.0.1` and routes traffic to it three ways:
  the macOS **system proxy** (browsers and other apps that honor it), GUI
  **`launchctl` env vars** (agent apps whose engine ignores the system proxy and
  reads `HTTPS_PROXY` instead, like the Codex app), and a **wrapped shell**
  (terminal agents) — so calls from anywhere flow through `xray`.
- For the model API hosts (`api.openai.com`, `api.anthropic.com`,
  `chatgpt.com`) it terminates TLS with a local CA it generates on first run,
  counts each `POST` to an inference endpoint (`/responses`, `/v1/messages`,
  `/chat/completions`), and forwards the request on untouched.
- Every other host is tunneled straight through, never decrypted.
- On exit it restores your previous proxy setting (and does so even on Ctrl-C,
  a closed terminal, or `kill`).

Because it counts the actual request the moment it leaves, the number is exact
and has no lag — one user prompt can increment it many times (each tool
round-trip is its own call). Codex prefers a WebSocket transport; `xray`
declines it so Codex uses the countable HTTPS path.

## The trade-off

To count requests, the proxy sits in the plaintext path **on your own machine**,
and while it runs your system proxy points at it. It can see request contents
and auth headers for the model hosts as they pass through; it never logs,
stores, or transmits them, and nothing leaves `127.0.0.1`. Everything else is
tunneled without being decrypted. The generated CA private key lives in
`~/.local/state/xray/certs/`; trusting it lets local apps talk to the model
hosts through `xray`. If that trade-off isn't acceptable to you, don't use this.

## Requirements

macOS, Node ≥ 20, and `openssl` (preinstalled). The floating window uses the
built-in `osascript`.
