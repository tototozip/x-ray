# x-ray

Minimal, exact live LLM-call counter for coding agents.

```sh
npm install -g github:tototozip/x-ray
xray codex
xray claude
```

`xray` runs your agent through a tiny local proxy and shows a floating macOS
window that ticks up the instant the agent calls the model:

```txt
codex llm calls: 6
```

Anything after the agent name is passed straight through, so `xray codex` (or
`xray codex exec ...`, `xray claude -p ...`) behaves exactly like running the
agent itself — there's just a live counter beside it. Close the window or quit
the agent to stop.

## How it counts

Every model inference is one HTTPS request from your machine to the provider's
API. `xray` counts those requests directly, at the source:

- It starts a local proxy on `127.0.0.1` and launches the agent pointed at it.
- For the model API hosts (`api.openai.com`, `api.anthropic.com`,
  `chatgpt.com`) it terminates TLS with a local CA it generates on first run,
  counts each `POST` to an inference endpoint (`/responses`, `/v1/messages`,
  `/chat/completions`), and forwards the request on untouched.
- Every other host is tunneled through without interception.

Because it counts the actual request the moment it leaves, the number is exact
and has no lag — one user prompt can increment it many times (each tool
round-trip is its own call). Codex prefers a WebSocket transport; `xray`
declines it so Codex uses the countable HTTPS path.

## The trade-off

To count requests, the proxy sits in the plaintext path **on your own machine**.
It can see request contents and auth headers as they pass through; it never
logs, stores, or transmits them, and nothing leaves `127.0.0.1`. The generated
CA private key lives in `~/.local/state/xray/certs/` and is only trusted by the
agent `xray` launches (via `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE`), not by your
system. If that trade-off isn't acceptable to you, don't use this.

## Requirements

macOS, Node ≥ 20, and `openssl` (preinstalled). The floating window uses the
built-in `osascript`.
