# x-ray

Minimal, exact live LLM-call counter for coding agents.

```sh
npm install -g github:tototozip/x-ray
xray
```

Run `xray`. A floating macOS window pops up, and you land in a normal shell —
use `codex`, `claude`, or any agent as you always would. The window ticks up
the instant any of them calls the model:

```txt
llm calls: 6
```

Close the window or `exit` the shell to stop.

To count just one agent for a single run, name it (anything after passes
straight through):

```sh
xray codex            # -> "codex llm calls: N"
xray claude -p "..."
```

The catch: counting happens by routing the agent through `xray`, so the agent
has to run **inside** the `xray` shell (or be launched as `xray <agent>`). A
`codex` you start in some other terminal isn't counted.

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
