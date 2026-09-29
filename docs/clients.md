# Coding-agent / OMP clients

The chat API is `POST /v1/chat/completions` with `model: "auto"` and a gateway key (`jrv_…`). Routing is set by the key's policy ([routing-policy.md](routing-policy.md)); a request adds only an optional session and reasoning effort.

## Optional routing object

```json
{
  "model": "auto",
  "stream": true,
  "messages": [],
  "reasoning_effort": "medium",
  "routing": { "sessionId": "stable-trajectory-id" }
}
```

| Field               | Rule                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `routing.sessionId` | Client-owned trajectory id (≤ 256 characters), namespaced by API key. The next turn tries the deployment the last one ran on (warm prefix cache). Best effort: an unknown or expired session just routes normally. |
| `routing.*`         | `boundary`, `taskBrief` and `qualityOverride` from the older session protocol are accepted and ignored. Other fields are rejected.                                                                                 |
| `reasoning_effort`  | `none`, `minimal` (= `low`), `low`, `medium`, `high` or `xhigh`, mapped onto the chosen deployment's levels. Absent: the deployment's cheapest level (Gufo thinking off).                                          |

Open WebUI's `X-OpenWebUI-Chat-Id` header becomes session `webui:<id>` when the body has no `routing` object ([ai-hub.md](ai-hub.md)). The generation prompt is never shortened. Sessions are process-local and do not survive a gateway restart.

## Response headers

Successful responses expose request, deployment, priority, queue-wait and applied-effort headers, and the session id when one was sent (URI-encoded where needed).

## Message order on Gufo

Qwen's chat template accepts system (or developer) messages only at the start. The Router sends a system message that appears later in the conversation to Gufo as a user turn in the same place, prefixed `[System note]`, so agents that inject reminders mid-conversation keep working and the prompt prefix stays cacheable. Other requests Gufo rejects before any work come back as **400 `invalid`** with Gufo's reason.

## App attribution

Every client app should send OpenRouter's app attribution headers on every chat request:

```http
HTTP-Referer: https://your-app.example
X-OpenRouter-Title: Your App
X-Title: Your App
```

`HTTP-Referer` is the app's public URL (OpenRouter's app identity); `X-OpenRouter-Title` is its display name, and `X-Title` repeats it for older tooling. `X-OpenRouter-Categories` (up to two, comma-separated, lowercase hyphenated, each at most 30 characters) and `X-OpenRouter-App-Visibility: hidden` (keep the app out of public rankings) are optional.

| Header                               | Accepted when                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `HTTP-Referer`                       | Absolute `http`/`https` URL without credentials or whitespace, at most 512 characters |
| `X-OpenRouter-Title`, else `X-Title` | 1–128 characters after trimming, no control characters                                |
| `X-OpenRouter-Categories`            | OpenRouter's format above; the whole header is dropped otherwise                      |
| `X-OpenRouter-App-Visibility`        | Exactly `hidden`; anything else means public, which is the default                    |

Attribution is advisory metadata. It never changes routing, authentication or key policy, and an invalid value is ignored rather than failing the request. Categories and visibility count only alongside a valid URL or title.

The router records the URL and title with the request (the admin **Request** dialog shows them as **App**). When the request is served by OpenRouter, the router forwards the client's attribution instead of its own: `HTTP-Referer` = URL, `X-OpenRouter-Title` and `X-Title` = title, plus categories and visibility only if the client sent them. Referer and title replace the router's as a pair, so a title without a URL is sent without a Referer and never renames the router's own app. Requests without a URL or title keep the router's attribution (`llm-router`, hidden). Gufo and other runtimes never receive these headers, and `POST /v1/batches` OpenRouter spill always uses the router's attribution.

## OMP / coding-agent wiring

Point the harness at `http://127.0.0.1:3000/v1` with the gateway API key. Send the harness task/session id as `routing.sessionId`.

OMP v18.3.2 with an isolated `openai-completions` provider was captured against a local SSE endpoint: both the plain reply and tool-request prompt sent `model`, `messages` (system and user), `tools` (12 function definitions), `max_completion_tokens: 8192`, `store: false`, `stream: true`, and `stream_options: { include_usage: true }`. Headers included `Accept: text/event-stream`, `Content-Type: application/json`, and bearer authorization; the bearer value was not recorded here. Neither request sent `parallel_tool_calls` by default.

| Chat request field                                                              | Gateway decision / upstream behavior                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`, `messages`, `tools`                                                    | Accept `model: "auto"` and validated chat/function-tool content; route the messages and tools unchanged in meaning.                                                                                                                                        |
| `store`, `user`, `metadata`, `prompt_cache_key`, `safety_identifier`            | Accept well-formed standard values, **drop** before routing/upstream. The gateway does not store OpenAI completions or forward client identity, metadata, cache identity or safety identity to a provider. `store: true` does not enable storage.          |
| `service_tier`                                                                  | OpenAI Flex semantics. `flex` runs only on idle local compute and goes to cloud only when Gufo is down; it waits in the Router's flex queue up to 10 minutes, then fails 429 `resource_unavailable`. **Low-priority keys are always flex**; other values cannot raise them. |
| `reasoning_effort`                                                              | See above. Other values fail with HTTP 400.                                                                                                                                                                                                                |
| `parallel_tool_calls`                                                           | Accept a boolean; forward only to OpenAI-compatible and OpenRouter adapters. Gufo does not receive this control.                                                                                                                                           |
| `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, `stop` | Validate and forward where supported. Gufo explicitly rejects `stop` rather than silently ignoring it.                                                                                                                                                     |
| `max_tokens`, `max_completion_tokens`                                           | Accept one positive integer (not both). A request no deployment can serve fails 422 `no_eligible_model`; dispatch caps the output at the selected deployment's limit.                                                                                      |
| `stream`, `stream_options.include_usage`                                        | Validate; include terminal usage on streaming upstream requests regardless of the client's include-usage choice, for gateway accounting.                                                                                                                   |
| `n`                                                                             | Accept only `1`; multiple choices fail with HTTP 400.                                                                                                                                                                                                      |
| `tool_choice`                                                                   | Accept `none`, `auto`, `required`, or a named function choice. Forward to supporting adapters; Gufo translates a named choice to a single required tool.                                                                                                   |
| `response_format`                                                               | Accept `text`, `json_object`, or `json_schema` with a named object schema; forward where supported. Gufo explicitly rejects response formatting.                                                                                                           |
| `logit_bias`, `logprobs`, `top_logprobs`                                        | Reject with HTTP 400: these generation controls are not implemented consistently across adapters.                                                                                                                                                          |
| Unknown/provider-specific fields                                                | Reject with HTTP 400; no arbitrary inference-body passthrough or override of provider selection.                                                                                                                                                           |

Never put provider credentials in browser code. Admin access is network reachability behind the deployment's authenticating proxy, not an inference key.

Streaming holds model capacity through the complete SSE lifetime. Disconnect aborts pending queue work and cancels the upstream reader. The gateway does not retry after a provider may have started work.

Streaming responses commit HTTP 200 SSE headers before routing, in every tier. If the request fails before a provider stream is established (for example `no_eligible_model`, `local_overloaded` or `resource_unavailable`), the stream ends with one `event: router.error` whose data is the same `{"error":{"code","message"}}` body a non-streaming request would receive, plus `retry_after_seconds` for the two retryable codes, then closes. Once a provider stream is established, any later failure (including accounting that cannot be persisted) aborts the stream instead, so a truncated or unaccounted answer never ends like a complete one.

## Queue status

Send a UUID `X-Request-ID` to correlate a request. The response and `GET /v1/requests/:id` use that correlation ID, scoped to the authenticated key. States distinguish `admitted`, `queued`, `dispatched`, `completed`, `error` and `cancelled`.

While a streaming request waits for capacity, the gateway emits `event: router.queue` with JSON `{ request_id, state, priority, waited_ms }` and periodic comment keepalives. A flex request whose dispatch Gufo refused goes back to `queued`. Clients that implement this extension can display an explicit queued notice; OpenAI-only clients may ignore custom events and poll the status endpoint. Queue metadata is never inserted into model-generated text.

The status endpoint checks current key expiry/revocation without taking another admission. Terminal status is retained for a bounded period. A reused in-flight correlation ID conflicts rather than mixing two requests.

## Overload responses

| Code                       | When                                                                                                  | Retry                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------- |
| 503 `local_overloaded`     | High/medium key without `cloud`: Gufo is down, or no permit or admission within the 5 s / 30 s budget | `Retry-After` (Gufo's, else 1 s) |
| 429 `resource_unavailable` | Flex request: no idle local compute within 10 minutes, or Gufo is down                                | `Retry-After`                    |
| 422 `no_eligible_model`    | No deployment the key may use could ever serve the request (context, output, capabilities)            | Do not retry unchanged           |
| 429 `rate_limited`         | The key's `requestsPerMinute` or `maxConcurrent`                                                      | Back off                         |

Router Gufo chat requests send `X-Gufo-No-Queue: 1`. When every Gufo session is busy (including sessions used by direct clients the Router cannot see), Gufo answers 429 before the request starts; the Router retries it after `Retry-After` within the key's budget. Unknown non-empty HTTP 429/503 responses stay provider failures. Do not treat an overload response as a completed answer.

## Usage and System One

Local chat `usage` contains integer prompt/completion/total token counts, optional nested cached/reasoning counts and `cost`, with zero upstream API cost details. Configured internal local rates determine cost; missing rates/counts produce null, not invented zero. Cloud usage is passed through.

`POST /v1/systemone` takes TypeSafe System One requests unchanged, so a TypeSafe SDK works with its base URL set to the router and a router key as its API key. `model` names a System One deployment, `kev-latest` or `jev-latest` ([catalogue](catalogue.md#system-one-kev-and-jev)). Errors carry TypeSafe's `detail` beside the router's `error`; a busy Gufo returns 429 `resource_unavailable` with `Retry-After`. `GET /v1/models` lists `auto` and the configured System One deployments, with a TypeSafe `models` list.
