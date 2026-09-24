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

| Field | Rule |
| --- | --- |
| `sessionId` | Client-owned trajectory id, namespaced by API key. Do not reuse one id across unrelated agents. |
| `boundary` | `new-task` classify and pin; `continue` reuse pin (no silent migrate); `checkpoint` reclassify when a switch is safe. |
| `taskBrief` | Optional, capped, **advisory**. Source is `caller-brief`. It is not authorization, completeness evidence, or a substitute for the generation prompt. |

The generation prompt is never shortened. Laya/Jev never truncate. Short tasks go in as classifier state; large histories use an explicit `taskBrief` plus server-derived metadata (full prompt token estimate, tools, turns, pending calls). If neither fits the classifier, the gateway returns an explicit context-exceeded / brief-required error — not a guessed route and not a silent Jev call.

## Boundaries

- Start a user task with `new-task`.
- Tool-result continuations of the **same** task use `continue` so the task assessment can be reused.
- A new user task, changed constraints, or a safe model switch uses `checkpoint`.
- Do not carry a greeting's no-thinking pin into coding work.

A changed continuity hash (system/developer messages, tools, tool choice, response format) on `continue` yields `BoundaryRequired`. Missing/expired pins yield `MissingSession`. Pins are process-local and **do not survive gateway restart**.

## Response headers

Successful responses expose request, deployment, session, and applied-effort headers (URI-encoded where needed). Persist `sessionId` from the header or from the id you sent; do not invent a second trajectory.

## OMP / coding-agent wiring

Point the harness at `http://127.0.0.1:3000/v1` with the gateway API key (`jrv_…`). Send `routing.sessionId` as the harness task/session id and `routing.boundary` as:

- first turn of a task → `new-task`
- subsequent tool/user turns of that task → `continue`
- compact/handoff/model reconsideration → `checkpoint`

Supported ordinary generation controls are `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, `stop`, `n: 1`, and `stream_options.include_usage`. Unknown/provider-specific controls are rejected; clients cannot override routing-owned reasoning or provider selection. The gateway requests terminal usage for accounting. Never put provider credentials in browser code. Admin access is network reachability plus optional Basic authentication, not an inference key.

Streaming holds model capacity and session ownership through the complete SSE lifetime. Disconnect aborts pending classification/queue work and cancels the chat upstream reader. The gateway does not retry after generation dispatch.

Streaming responses commit HTTP 200 SSE headers before classification and routing. If the request fails before a provider stream is established (for example `classifier_unqualified`, `no_eligible_model` or `local_overloaded`), the stream ends with one `event: router.error` whose data is the same `{"error":{"code","message"}}` body a non-streaming request would receive, then closes. Only `local_overloaded` adds `retry_after_seconds`. Once a provider stream is established, any later failure (including accounting that cannot be persisted) aborts the stream instead, so a truncated or unaccounted answer never ends like a complete one.

## Classifier cache (server)

Assessments are reused only for the same authenticated key, backend/model revision, question schema, state/brief and catalogue version. The completed-result cache is bounded by size and TTL. There is no in-flight request coalescing or fuzzy semantic cache. Exact-cache reuse reports no new classifier usage. A session pin is not a generator cache hit.

## Queue status

Send a UUID `X-Request-ID` to correlate a request. The response and `GET /v1/requests/:id` use that correlation ID, scoped to the authenticated key. States distinguish `admitted`, `queued`, `dispatched`, `completed`, `error` and `cancelled`; classification is not mislabeled as a queue wait.

While a streaming request waits for capacity, the gateway emits `event: router.queue` with JSON `{ request_id, state, priority, waited_ms }` and periodic comment keepalives. Clients that implement this extension can display an explicit queued notice. Ordinary OpenAI-only clients may ignore custom events; they can poll the status endpoint. Queue metadata is not inserted into model-generated assistant text.

The status endpoint checks current key expiry/revocation without taking another admission. Terminal status is retained for a bounded period. A reused in-flight correlation ID conflicts rather than mixing two requests.

## Local overload responses

Keys default to reporting local overload rather than sending work to a paid cloud Deployment. Local overload means no immediately available Router-owned permit on any eligible local Deployment, or a definitive local runtime pre-execution rejection (Gufo HTTP 429 `queue_full` / `client_queue_full`); it is not proof of Verified saturation, and Gufo exposes no pre-request "all sessions busy" signal. With the default report action, the gateway waits up to the Key's maxWaitMs, then reports overload. Non-streaming requests receive HTTP 503, error code `local_overloaded`, and `Retry-After`. Streaming requests have already received HTTP 200 SSE headers, so they receive a terminal `event: router.error` whose data is `{"error":{"code":"local_overloaded","message":"local deployment overloaded","retry_after_seconds":N}}`, then the stream closes. Do not treat an overload response as a provider-completed answer.

An operator may enable failover per Key. It can select an already eligible cloud Deployment only before provider dispatch, subject to allowlist, capability, context, credentials and estimated-spend/pricing limits. It does not silently migrate a continue pin or replay after uncertain provider contact. Clients should not request an automatic retry of a possibly dispatched turn.

## Usage and optional modalities

Local chat `usage` contains integer prompt/completion/total token counts, optional nested cached/reasoning counts and `cost`, with zero upstream API cost details. Configured internal local rates determine cost; missing rates/counts produce null, not invented zero. Provenance is internal metadata, not a nonstandard `cost_source` wire field. Cloud usage is passed through.

`GET /v1/models`, `POST /v1/embeddings`, and multipart `POST /v1/audio/transcriptions` share inference authentication. Embeddings/STT use explicit configured model IDs, not chat `auto`; see [ai-hub.md](ai-hub.md) for supported formats and upstream limitations.
