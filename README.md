# GitHub Copilot → OpenAI bridge

OpenAI-compatible API for your GitHub Copilot subscription.

Using [Hermes Agent](https://github.com/NousResearch/hermes-agent)? Install the
[`hermes-plugin-github-copilot`](https://github.com/paq85/hermes-plugin-github-copilot) plugin
instead: one command, and it downloads, installs and runs a pinned release of this bridge for you.

A small Node.js server that exposes your GitHub Copilot access through an
OpenAI-compatible Chat Completions API, built on the
[`@github/copilot-sdk`](https://github.com/github/copilot-sdk).

It is designed for stateless, history-resending agent clients (such as Hermes
Agent): each conversation is mapped onto **one continuing Copilot session**, so
context and the provider's **prompt cache** are preserved between turns.

## Requirements

- Node.js 20.19+ (tested on 24)
- GitHub Copilot access, signed in via the Copilot CLI on this machine

## Quick start

```powershell
git clone https://github.com/paq85/github-copilot-openai-bridge.git
cd github-copilot-openai-bridge
.\run.ps1                              # installs deps if needed, serves http://127.0.0.1:8787/v1
.\run.ps1 -Port 9000 -Model auto -ApiKey secret
```

Or double-click / run `run.cmd`. Manually: `npm install && npm start`.

Point any OpenAI client at it; the API key can be any string unless
`BRIDGE_API_KEY` is set:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="anything")
print(client.chat.completions.create(model="auto",
      messages=[{"role": "user", "content": "Hi"}]).choices[0].message.content)
```

## Endpoints

| Method | Path                   | Notes                                              |
| ------ | ---------------------- | -------------------------------------------------- |
| GET    | `/v1/models`           | Rich model catalog (see below)                     |
| GET    | `/v1/models/{id}`      | A single model entry                               |
| POST   | `/v1/chat/completions` | `model`, `messages`, `stream`, `stream_options.include_usage`, `reasoning_effort`, `fusion_tier`, `context_tier` |

### Model catalog

Each entry is OpenAI-shaped (`id`, `object`, `owned_by`) plus: `name`,
`context_window`, `max_output_tokens`, `capabilities` (`streaming`, `tool_calls`,
`vision`, `structured_outputs`), `reasoning_efforts`, `default_reasoning_effort`,
`enabled` and `price_category`. The `auto` model also carries `fusion_tiers`
(Copilot Fusion): `[{id, name, description, enabled, default, promo}]`, with ids
such as `standard`, `high` and `max`. Enabled Fusion tiers are also exposed as
**separate selectable models**, for model pickers that only show model IDs:

| Model ID | Display name | Copilot routing |
| --- | --- | --- |
| `fusion` | Fusion | `auto` with `fusion_tier: standard` |
| `fusion-high` | Fusion High | `auto` with `fusion_tier: high` |

No extra request fields are needed: `{"model":"fusion-high","messages":[...]}`.
These entries inherit Auto's context budget and capabilities and include
`underlying_model: "auto"` and `fusion_tier`. Disabled tiers are not added as
model entries; additional enabled tiers use `fusion-<tier>` (e.g. `fusion-max`).
The catalog is cached for 5 minutes.

Because Fusion routes per request, every Fusion tier advertises the same
conservative window as `auto` (see [Context windows of `auto` and Fusion](#context-windows-of-auto-and-fusion)),
not the window of the model it may route to.

### Context size (100K / 1M)

Copilot lets you pick a context size for some models (the CLI's *Context Size*
toggle, e.g. Claude Haiku 5.5: 100K or 1M). The two sizes are Copilot's
`default` and `long_context` tiers, and the long one usually costs more per
token (see `billing.tokenPrices.longContext` in Copilot's catalog).

Most OpenAI clients (Hermes Agent among them) have no context-size control, so every model that
offers the choice is also listed once per size, as its own model:

| Model ID | `context_length` | Copilot session |
| --- | --- | --- |
| `claude-haiku-5.5` | catalog window | no explicit tier (Copilot uses the long tier) |
| `claude-haiku-5.5-100k` | `100000` | `contextTier: default` |
| `claude-haiku-5.5-1m` | `872000` | `contextTier: long_context` |

The suffix is the size Copilot shows (`-100k`, `-200k`, `-272k`, `-1m`), so the
list depends on your account's catalog. Each variant advertises the prompt
budget Copilot actually enforces for that tier, so clients compact at the right
point, and carries `underlying_model` and `context_tier`. The base entry lists
its sizes in `context_tiers: [{id, context_window, label, model}]`. Models with
one size (and `auto` / Fusion) get no variants.

With any OpenAI client you can also keep the base ID and send
`"context_tier": "default"` or `"long_context"`. A tier that conflicts with a
variant ID, or a tier on a model without the choice, returns `400`. Like
`reasoning_effort`, the tier is part of the session identity.

### Reasoning effort and Fusion

- `reasoning_effort`: one of the model's `reasoning_efforts` (e.g. `low`…`max`).
- `fusion_tier`: with `"model": "auto"`, one of `fusion_tiers[].id`. Alternatively,
  select `fusion` or `fusion-high` directly as the model (recommended for model
  pickers). An explicit tier conflicting with that model returns `400`.

Invalid values return `400` listing the allowed ones. Both are part of the
session identity, so changing them starts a new Copilot session. For clients
that fix one context window per chat, prefer `auto` or a specific model over
Fusion tiers (see [Context windows of `auto` and Fusion](#context-windows-of-auto-and-fusion)).

## Configuration

| Env var          | Default | Description                                   |
| ---------------- | ------- | --------------------------------------------- |
| `PORT`           | `8787`  | Listen port (`0` = random)                    |
| `DEFAULT_MODEL`  | `auto`  | Model used when a request omits `model`       |
| `BRIDGE_API_KEY` | unset   | If set, requires `Authorization: Bearer <key>` |
| `AUTO_CONTEXT_WINDOW` | `200000` | Window advertised for `auto` and Fusion tiers (smallest runtime budget seen; see [Context windows of `auto` and Fusion](#context-windows-of-auto-and-fusion)) |
| `STREAM_HEADER_DELAY_MS` | `8000` | Delay before SSE headers, so early errors return a real HTTP status |
| `IDLE_EXIT_MS`   | `0`     | Exit after this idle time (`0` = never); the Hermes plugin uses it so one bridge serves several Hermes processes |
| `SESSION_TTL_MS` | `3600000` | Idle time before a session is discarded     |
| `BUSY_WAIT_MS`   | `30000` | How long a follow-up waits for its session to finish a previous request |
| `TURN_TIMEOUT_MS`| `600000`| Max time for one Copilot turn                 |
| `EMIT_REASONING` | `1`     | Set `0` to hide model thinking (`reasoning_content`) |

The server binds to `127.0.0.1` only.

## How session continuation works

OpenAI clients resend the full message list every turn. The bridge keeps live
Copilot sessions in memory and, per request:

1. Splits out `system`/`developer` messages (they become the session system prompt).
2. Looks for a session with the same model and system prompt whose recorded
   history is an exact prefix of the incoming messages.
3. **Match:** sends only the new messages to that session.
   **No match** (new chat, edited or forked history): creates a new session and
   replays the full transcript (including any tool calls/results) as its first
   prompt. The console prints why the previous session wasn't continued, e.g.
   `not continuing session 4811a6f2: history diverges at message #11`.
   If the matching session is still finishing a previous request, the bridge
   waits for it (up to `BUSY_WAIT_MS`) instead of forking.
4. After the reply, records `history + assistant reply` for the next turn.

Because the same session carries the whole conversation, Copilot's context and
prompt cache are reused rather than rebuilt from a replayed transcript.

### Response headers

| Header                     | Meaning                                         |
| -------------------------- | ----------------------------------------------- |
| `x-copilot-session-id`     | Copilot session serving the request             |
| `x-copilot-session-reused` | `true` if an existing session was continued     |
| `x-copilot-messages-sent`  | Number of messages actually forwarded to Copilot|

### Usage and cache reporting

`usage` contains `prompt_tokens`, `completion_tokens`, `total_tokens` and
`prompt_tokens_details.cached_tokens` (tokens served from the prompt cache). For
streams, set `stream_options: {"include_usage": true}` to get a final usage chunk.

## Context windows of `auto` and Fusion

Fusion tiers (`fusion`, `fusion-high`, `fusion-max`) and `auto` route **each
request** to a model of Copilot's choosing, and Copilot enforces that model's
context window **at runtime, per request**. Measured with Hermes Agent
(17.11.2026, bridge log):

| Model Copilot routed to | Runtime context window | Turns observed |
| ----------------------- | ---------------------- | -------------- |
| `claude-opus-5.5`       | 200,000                | 73             |
| `claude-sonnet-5.5`     | 200,000                | 10             |
| `gpt-6.1-sol`           | 272,000                | 32             |
| `gpt-6-luna`            | 272,000 (four turns were 200,000) | 28 |

There is no single correct window to advertise, so the bridge reports the
smallest observed budget, `AUTO_CONTEXT_WINDOW` (default `200000`), for `auto`
and every Fusion tier. A client that fixes one window per chat then compacts in
time for a Claude turn and never overflows; the cost is that a chat that would
have fit GPT's 272k window is compacted sooner than needed. Clients like that
should prefer `auto` (one conservative window) or a specific model (the catalog
window matches the model that answers) over Fusion tiers for long chats.

## Using it with agents

**Hermes Agent:** use the [`hermes-plugin-github-copilot`](https://github.com/paq85/hermes-plugin-github-copilot)
plugin (`hermes plugins install paq85/hermes-plugin-github-copilot --enable`). It
downloads and runs a pinned release of this bridge, so there is nothing to clone or start.

**Any other OpenAI-compatible client** (or Hermes' `custom` provider): start the
bridge and point the client at it:

```yaml
model:
  provider: custom
  base_url: http://127.0.0.1:8787/v1
  api_key: anything          # or your BRIDGE_API_KEY
  default: auto              # any id from GET /v1/models
```

What makes this work for agents:

- **Tool calling.** `tools` are registered as custom tools on the Copilot session
  (Copilot's own built-in shell/file tools are disabled). When the model calls
  one, the request returns `tool_calls` (`finish_reason: "tool_calls"`, streamed
  or not). The session waits; the next request with the `role: "tool"` results
  continues the **same** turn and session. Parallel tool calls are batched.
- **One session per conversation** with prompt-cache reuse (below).
- **Context size.** `/v1/models` reports `context_length` / `context_window`
  per model. To choose the context size in a client without a size control, pick a size variant such as
  `claude-haiku-5.5-100k` or `claude-haiku-5.5-1m` (see
  [Context size](#context-size-100k--1m)). `auto` and Fusion tiers get `AUTO_CONTEXT_WINDOW` (the smallest
  window Copilot enforces across the models they may route to; see
  [Context windows of `auto` and Fusion](#context-windows-of-auto-and-fusion)).
  If a client doesn't pick it up, set the context length in its config.
- If a client rewrites earlier history (e.g. context compression), a new session
  is started automatically.

## Thinking / reasoning

The model's thinking is returned separately from the answer, in the
DeepSeek-style `reasoning_content` field that Hermes Agent, Open WebUI,
opencode and the Vercel AI SDK display as a thinking block:

- streaming: `choices[0].delta.reasoning_content` chunks, before the answer's `delta.content`
- non-streaming: `choices[0].message.reasoning_content`

It is never mixed into `content`. Whether a model thinks depends on the model
and `reasoning_effort` (e.g. `claude-haiku-5.5` / `gpt-6-luna` with `high`).
Set `EMIT_REASONING=0` to hide it.

## Images (vision)

Send OpenAI-style content parts in user messages:

```json
{"role": "user", "content": [
  {"type": "text", "text": "What is in this picture?"},
  {"type": "image_url", "image_url": {"url": "data:image/png;base64,...."}}
]}
```

`image_url` may be a `data:` URL or an `http(s)` URL (fetched by the bridge,
max 20 MB, 30 s). Images are passed to Copilot as attachments, are part of
session matching (replayed history still continues the same session), and show
up as `images=N` in the logs. Models that report `capabilities.vision: false`
return `400`; unreachable or unsupported URLs also return `400`.

## Cost, context and session info

Every response carries an `x_copilot` object (also on the final streamed chunk):

```jsonc
{
  "session_id": "…", "session_reused": true, "messages_sent": 1,
  "model": "gpt-6-luna",                 // model actually used (relevant for auto)
  "duration_ms": 2300,
  "request": { "api_calls": 1, "tokens": {"prompt": 4312, "completion": 6, "cached": 1271},
               "cache_hit_ratio": 0.29, "ai_units": 0.0166, "cost_multiplier": 1 },
  "session": { "requests": 3, "tokens": {…}, "ai_units": 0.05, … },   // cumulative
  "context": { "used_tokens": 3043, "limit_tokens": 272000, "percent": 1.1,
               "system_tokens": …, "conversation_tokens": …, "tool_definition_tokens": …, "messages": … }
}
```

`ai_units` is Copilot's reported cost (nano-AIU ÷ 1e9); `cost_multiplier` is the
model's billing multiplier. Non-streaming responses also set the
`x-copilot-ai-units` and `x-copilot-context-used` headers.

| Method | Path                | Notes                                          |
| ------ | ------------------- | ---------------------------------------------- |
| GET    | `/v1/sessions`      | All live sessions with cumulative usage + context |
| GET    | `/v1/sessions/{id}` | One session                                    |

## Console logs

The server logs one line per request and one per response (colored on a TTY;
`NO_COLOR=1` disables):

```
22:37:28.410 → chat model=auto msgs=1 tools=0 session 0c9705c5 (new)
22:37:30.587 ← 200 0c9705c5 stop 2.3s model=gpt-6-luna in=4,312 (cached 1,271, 29%) out=6 cost=0.0166 AIU (x1) | ctx 3,043/272,000 (1%) | session: 1 req, 0.0166 AIU
```

It shows whether a session was continued or new, tools offered, tokens in/out,
cache hits, cost, context fill and running session totals.

## Acceptance tests

Live tests run against the real Copilot runtime, acting as a history-resending
agent:

```bash
npm test             # MODEL=<id> to override the model
```

They verify that: a multi-turn chat (including a streamed turn) stays in one
session and forwards only new messages; diverging history starts a new session;
concurrent conversations stay isolated; and continued turns report
`cached_tokens > 0`.

## Limitations

- Sampling parameters (`temperature` etc.) and `tool_choice` are ignored.
- Fusion tiers route per request, so they share one advertised window (`auto`'s);
  clients that fix one window per chat cannot track the per-model limits - see
  [Context windows of `auto` and Fusion](#context-windows-of-auto-and-fusion).
- Images in tool-result messages are not forwarded.
- Sessions live in memory and are lost on restart.
- Copilot sessions auto-approve their own tool permissions.
- Intended for local, single-user use.

## Files

- `server.mjs` — the bridge (single file, no build step)
- `acceptance.test.mjs`, `multi-session.test.mjs` — live tests
- `run.cmd`, `run.ps1` — launchers
- `AGENTS.md` — guidance for coding agents, including the versioning and release rules
