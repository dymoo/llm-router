# Coding-agent / OMP clients

The chat API is `POST /v1/chat/completions` with `model: "auto"`. Ordinary OpenAI clients that omit routing metadata get a **new UUID and `new-task` on every request**. Open WebUI is an explicit exception: its forwarded chat ID is adapted into key-namespaced session continuity, described in [ai-hub.md](ai-hub.md).

## Required routing object

```json
{
  "model": "auto",
  "stream": true,
  "messages": [],
  "routing": {
    "sessionId": "stable-trajectory-id",
    "boundary": "new-task",
    "taskBrief": "optional caller-authored brief"
  }
}
```

| Field       | Rule                                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId` | Client-owned trajectory id, namespaced by API key. Do not reuse one id across unrelated agents.                                                                             |
| `boundary`  | `new-task` select and pin; `continue` reuse pin (no silent migrate); `checkpoint` reconsider when a switch is safe. Laya/Jev assess at new-task/checkpoint; Rules does not. |
| `taskBrief` | Optional, capped, **advisory**. Source is `caller-brief`. It is not authorization, completeness evidence, or a substitute for the generation prompt.                        |

The generation prompt is never shortened. In **Rules mode**, no classifier is called and no `taskBrief` is required to fit classifier context. Selection uses hard eligibility and Key policy, with the deployment’s lowest supported effort (Gufo thinking off); task and difficulty metadata are absent, not guessed. Locality below 0.5 can prefer cloud, otherwise local is preferred. Requests local cannot fit or support may use eligible cloud even for a report Key; no eligible deployment yields `no_eligible_model`.

In **Laya/Jev modes**, neither backend truncates. Short tasks go in as classifier state; large histories use an explicit `taskBrief` plus server-derived metadata (full prompt token estimate, tools, turns, pending calls). If neither fits the classifier, the gateway returns an explicit context-exceeded / brief-required error — not a guessed route and not a silent Jev call. These modes still return `classifier_unqualified` without qualifying evidence.

## Boundaries

- Start a user task with `new-task`.
- Tool-result continuations of the **same** task use `continue` so the route (and Assessment in Laya/Jev modes) can be reused.
- A new user task, changed constraints, or a safe model switch uses `checkpoint`.
- In assessed modes, do not carry a greeting’s no-thinking pin into coding work. Rules intentionally uses the lowest supported effort for all tasks, including coding.

A changed continuity hash (system/developer messages, tools, tool choice, response format) on `continue` yields `BoundaryRequired`. Missing/expired pins yield `MissingSession`. Pins are process-local and **do not survive gateway restart**.

## Response headers

Successful responses expose request, deployment, session, and applied-effort headers (URI-encoded where needed). Persist `sessionId` from the header or from the id you sent; do not invent a second trajectory.

## OMP / coding-agent wiring

Point the harness at `http://127.0.0.1:3000/v1` with the gateway API key (`jrv_…`). Send `routing.sessionId` as the harness task/session id and `routing.boundary` as:

- first turn of a task → `new-task`
- subsequent tool/user turns of that task → `continue`
- compact/handoff/model reconsideration → `checkpoint`

OMP v18.3.2 with an isolated `openai-completions` provider was captured against a local SSE endpoint: both the plain reply and tool-request prompt sent `model`, `messages` (system and user), `tools` (12 function definitions), `max_completion_tokens: 8192`, `store: false`, `stream: true`, and `stream_options: { include_usage: true }`. Headers included `Accept: text/event-stream`, `Content-Type: application/json`, and bearer authorization; the bearer value was not recorded in this table. Neither request sent `parallel_tool_calls` by default.

| Chat request field                                                              | Gateway decision / upstream behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`, `messages`, `tools`                                                    | Accept `model: "auto"` and validated chat/function-tool content; route the messages and tools unchanged in meaning.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `store`, `user`, `metadata`, `prompt_cache_key`, `safety_identifier`            | Accept well-formed standard values, **drop** before routing/upstream. The gateway does not store OpenAI completions or forward client identity, metadata, billing tier, cache identity or safety identity to a provider. `store: true` does not enable storage.                                                                                                                                                                                                                                                                                           |
| `service_tier`                                                                  | OpenAI Flex semantics. `flex` runs only on idle local compute: no saturation spill or overload failover to cloud, and Gufo admits it only when no default work is queued or prefilling. The Router retries a refusal until the Key's `maxWaitMs`, then returns HTTP 429 `resource_unavailable` with `Retry-After`, before any SSE is committed (flex streams dispatch first). **Low-priority keys are always flex**; other values (`auto`, `default`, `scale`, `priority`) cannot raise them. For high and medium keys, other values are served normally. |
| `parallel_tool_calls`                                                           | Accept a boolean; forward only to OpenAI-compatible and OpenRouter adapters. Gufo, llama.cpp and Halogen do not receive this control; do not rely on it to restrict their tool behavior.                                                                                                                                                                                                                                                                                                                                                                  |
| `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, `stop` | Validate and forward where supported. Gufo explicitly rejects `stop` rather than silently ignoring it.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `max_tokens`, `max_completion_tokens`                                           | Accept one positive integer (not both). Requests exceeding the key limit fail; dispatch caps the output to the lesser of the key and selected deployment limits.                                                                                                                                                                                                                                                                                                                                                                                          |
| `stream`, `stream_options.include_usage`                                        | Validate; include terminal usage on streaming upstream requests regardless of the client's include-usage choice, for gateway accounting.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `n`                                                                             | Accept only `1`; multiple choices fail with HTTP 400.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tool_choice`                                                                   | Accept `none`, `auto`, `required`, or a named function choice. Forward to supporting adapters; Gufo translates a named choice to a single required tool.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `response_format`                                                               | Accept `text`, `json_object`, or `json_schema` with a named object schema; forward where supported. Gufo explicitly rejects response formatting.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `logit_bias`, `logprobs`, `top_logprobs`                                        | Reject with HTTP 400: these generation controls are not implemented consistently across selected adapters.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `reasoning_effort`                                                              | Reject with HTTP 400: routing mode, key policy and deployment own reasoning effort; clients cannot override it.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Unknown/provider-specific fields                                                | Reject with HTTP 400; no arbitrary inference-body passthrough or override of provider selection/routing policy.                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Never put provider credentials in browser code. Admin access is network reachability behind the deployment's authenticating proxy, not an inference key.

Streaming holds model capacity and session ownership through the complete SSE lifetime. Disconnect aborts pending classification/queue work and cancels the chat upstream reader. The gateway does not retry after generation dispatch.

Session ownership is exclusive for the exact API-key and session-id pair. Another turn for that pair waits up to 10 seconds by default, then fails with a lock timeout if the stream still owns it. Unrelated sessions do not share a session lock, although deployment capacity may independently queue them.

Streaming responses commit HTTP 200 SSE headers before classification and routing. If the request fails before a provider stream is established (for example `classifier_unqualified`, `no_eligible_model` or `local_overloaded`), the stream ends with one `event: router.error` whose data is the same `{"error":{"code","message"}}` body a non-streaming request would receive, then closes. Only `local_overloaded` adds `retry_after_seconds`. Once a provider stream is established, any later failure (including accounting that cannot be persisted) aborts the stream instead, so a truncated or unaccounted answer never ends like a complete one.

## Classifier cache (Laya/Jev modes only)

Assessments are reused only for the same authenticated key, backend/model revision, question schema, state/brief and catalogue version. The completed-result cache is bounded by size and TTL. There is no in-flight request coalescing or fuzzy semantic cache. Exact-cache reuse reports no new classifier usage. A session pin is not a generator cache hit.

## Queue status

Send a UUID `X-Request-ID` to correlate a request. The response and `GET /v1/requests/:id` use that correlation ID, scoped to the authenticated key. States distinguish `admitted`, `queued`, `dispatched`, `completed`, `error` and `cancelled`; classification is not mislabeled as a queue wait.

While a streaming request waits for capacity, the gateway emits `event: router.queue` with JSON `{ request_id, state, priority, waited_ms }` and periodic comment keepalives. Clients that implement this extension can display an explicit queued notice. Ordinary OpenAI-only clients may ignore custom events; they can poll the status endpoint. Queue metadata is not inserted into model-generated assistant text.

The status endpoint checks current key expiry/revocation without taking another admission. Terminal status is retained for a bounded period. A reused in-flight correlation ID conflicts rather than mixing two requests.

## Local overload responses

Keys default to reporting local overload rather than sending work to a paid cloud Deployment. Local overload means no immediately available Router-owned permit on any eligible local Deployment, or a definitive local runtime pre-execution rejection (Gufo HTTP 429 `queue_full` / `client_queue_full`, or the opt-in empty-body HTTP 429 fast rejection); it is not proof of Verified saturation, and Gufo exposes no pre-request "all sessions busy" signal. With the default report action, the gateway waits up to the Key's maxWaitMs, then reports overload. Non-streaming requests receive HTTP 503, error code `local_overloaded`, and `Retry-After`. Streaming requests have already received HTTP 200 SSE headers, so they receive a terminal `event: router.error` whose data is `{"error":{"code":"local_overloaded","message":"local deployment overloaded","retry_after_seconds":N}}`, then the stream closes. Do not treat an overload response as a provider-completed answer.

Router Gufo chat requests (streaming and non-streaming) send `X-Gufo-No-Queue: 1` under the dylans-infra PR #210 contract. When all Gufo sessions are busy, including sessions used by direct clients such as Open WebUI and OMP that Router permits cannot see, the proxy returns an empty-body HTTP 429 before the request reaches Gufo. For a report Key this surfaces as `local_overloaded`; a failover Key may select an eligible cloud Deployment before dispatch. Gufo's `Retry-After: 301` is passed through as its value, not calculated by the Router. Unknown non-empty HTTP 429/503 responses stay provider failures.

An operator may enable failover per Key. It can select an already eligible cloud Deployment only before provider dispatch, subject to allowlist, capability, context, credentials and estimated-spend/pricing limits. It does not silently migrate a continue pin or replay after uncertain provider contact. Clients should not request an automatic retry of a possibly dispatched turn.

In Rules mode, a down/unhealthy local that could otherwise serve the request follows the same overload action: report Keys immediately receive HTTP 503 `local_overloaded` (or terminal SSE `router.error`) without a capacity wait or paid cloud dispatch; failover Keys can use eligible cloud before dispatch. This covers planned Gufo downtime. The decision detail is `local-unavailable`; the bounded wire code remains `local_overloaded`. A down local that cannot fit/support the request does not prevent an otherwise eligible cloud route. Pinned continuations never migrate silently.

A missing local provider credential is hard ineligibility, not downtime. Rules may select eligible cloud even for a report Key; if none qualifies, it returns `no_eligible_model`. Batch downtime follows its separate deferred-lane authorization: only failover Keys can accelerate a configured, eligible remote batch before its spill deadline.

## Usage and optional modalities

Local chat `usage` contains integer prompt/completion/total token counts, optional nested cached/reasoning counts and `cost`, with zero upstream API cost details. Configured internal local rates determine cost; missing rates/counts produce null, not invented zero. Provenance is internal metadata, not a nonstandard `cost_source` wire field. Cloud usage is passed through.

`GET /v1/models`, `POST /v1/embeddings`, and multipart `POST /v1/audio/transcriptions` share inference authentication. Embeddings/STT use explicit configured model IDs, not chat `auto`; see [ai-hub.md](ai-hub.md) for supported formats and upstream limitations.

`POST /v1/systemone` takes TypeSafe System One requests unchanged, so a
TypeSafe SDK works with its base URL set to the router and a router key as
its API key. `model` names a System One deployment, `kev-latest` or
`jev-latest` ([catalogue](catalogue.md#system-one-kev-and-jev)). Errors
carry TypeSafe's `detail` beside the router's `error`; a busy Gufo returns
429 `resource_unavailable` with `Retry-After`. `GET /v1/models` adds a
TypeSafe `models` list of the System One deployments a key may use.
