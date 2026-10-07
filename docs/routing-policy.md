# Routing policy

Normative product policy for dymoo/llm-router. The Router serves one local GPU runtime (Gufo, transport `gufo`) and one cloud tier (OpenRouter, transport `openrouter`); `openai-compatible` stays as a generic local escape hatch. Numeric defaults are named constants, not measured optima or SLAs.

- Topology, accounting retention, timeouts: [operations.md](operations.md)
- Env, bind, proxy-gated console: [setup.md](setup.md)
- Open WebUI and System One: [ai-hub.md](ai-hub.md)
- Live catalogue facts: [catalogue.md](catalogue.md)
- Client requests, sessions and effort: [clients.md](clients.md)
- Domain language: [../CONTEXT.md](../CONTEXT.md)

## Key policy

A Key's policy is the whole routing configuration:

```ts
{
  priority: "high" | "medium" | "low";
  cloud: boolean;
  requestsPerMinute: number;
  maxConcurrent: number;
}
```

- **priority** sets the tier and queue order (below).
- **cloud** lets high and medium work leave Gufo for the first eligible cloud deployment. It may incur provider charges; nothing else does.
- **requestsPerMinute** and **maxConcurrent** are admission limits (integers ≥ 0; 0 admits nothing).

The admin API rejects any other policy field. Stored policies from before migration 0007 are rewritten by it (`cloud = overloadAction == "failover"`, the rest dropped), and an unmigrated row is read the same way.

Suggestions (every field editable): **Interactive** `{high, cloud, 120 rpm, 4 concurrent}`, **Standard** `{medium, no cloud, 60 rpm, 2}`, **Background** `{low, no cloud, 30 rpm, 2}`.

## Eligibility

A deployment could ever serve a request when it has the required capabilities (tools, JSON, vision) and the prompt fits its context (estimated at 2 bytes per token) and any requested `max_completion_tokens` is within its output limit. `max_completion_tokens` is a cap, not a reservation: Gufo stops a reply at the end of the context with `length`. A deployment is available now when its credential is configured and its health probe passes. A request no deployment the key may use could ever serve fails **422 `no_eligible_model`**; nothing is widened to invent a candidate.

## Requested model

`model: "auto"` is the policy routing below. `cheap` and a pinned model id ([clients.md](clients.md#model), [ADR 0005](adr/0005-requested-model-ids.md)) replace only the choice of deployment: the key's priority, wait budgets, reserved slots and limits apply unchanged, and the request routes through the same tier with that one deployment as the only candidate. Pinning cannot widen policy: a cloud model for a cloud-off key or a low/flex request is refused (403), never rerouted, and a pinned local model has no cloud failover, not even when Gufo is down.

## Default tier: high and medium

`POST /v1/chat/completions` with `model: "auto"`:

1. **Gufo first.** Take a Router permit on an eligible, available local deployment and dispatch with `X-Gufo-No-Queue`. A deployment's `reservedInteractiveSlots` keep permits for **high** keys only; queue order is high, then medium, non-preemptive.
2. **Wait, within a budget.** Wait for a permit, and retry Gufo's pre-enqueue refusals (429 `queue_full` / `client_queue_full`, 503 `draining`) after their `Retry-After` (floor 250 ms), for at most **5 s (high) / 30 s (medium)** (`LOCAL_WAIT_MS`). A refusal whose `Retry-After` ends past the budget stops the wait at once.
3. **Then cloud, or report.** If local is unavailable (down, or cannot serve this request) or the wait runs out: with `cloud: true`, dispatch to the first eligible cloud deployment (waiting for its permit only within what remains of the budget); otherwise fail **503 `local_overloaded`** with `Retry-After` (Gufo's, else 1 s).
4. **Gufo down: cloud for every key.** When every eligible local deployment fails its health probe (stopped, restarting, maintenance), the request goes to cloud whatever the key's `cloud` switch says, flex and low included, so an outage never strands a key. A merely busy Gufo still keeps cloud-off keys local.

Nothing is retried after a provider may have started work: an ambiguous provider failure is `502 provider_failure`.

## Flex tier: low, or `service_tier: "flex"`

Low keys always run as flex; any key may ask for it per request. Flex never goes to cloud while Gufo is up, whatever `cloud` says; when Gufo is down it takes the default tier's outage path to cloud (step 4 above).

- Requests wait in a Router-side **FIFO flex queue per deployment**. At most `flex_limit` of them hold a slot and may be dispatched to Gufo at once, where `flex_limit` is Gufo's `GET /v1/runtime` `sessions.flex_limit` (cached 30 s; `DEFAULT_FLEX_LIMIT` = 2 when unknown).
- The slot holder sends `service_tier: "flex"`. On Gufo's 429 `resource_unavailable` it keeps its slot, waits `Retry-After` (floor 250 ms) and retries, so waiting requests never all poll Gufo.
- **No starvation:** a flex request that has waited 60 s (`FLEX_PROMOTE_AFTER_MS`) is promoted. It dispatches on Gufo's default tier and takes a permit ranked with high traffic by arrival, so a steady stream of high-priority work still lets it through. Only flex-slot holders (Gufo's `flex_limit`) are promoted, which caps what low work takes from interactive traffic. It still never goes to cloud while Gufo is up.
- The wait is capped at **10 minutes** (`FLEX_MAX_WAIT_MS`, under the 11-minute gateway deadline); then **429 `resource_unavailable`** with `Retry-After`. A flex request no local deployment could ever serve fails 422 `no_eligible_model`.

## Streams

Every tier takes the same streaming path: HTTP 200 is committed at once, `event: router.queue` notices and keepalives flow while the request waits, and a failure before provider output is a terminal `event: router.error` (with `retry_after_seconds` for `local_overloaded` and `resource_unavailable`). After provider output starts, a failure aborts the stream.

## Sessions

Best-effort stickiness, never an error. A session id comes from `routing.sessionId` or the Open WebUI `X-OpenWebUI-Chat-Id` header (namespaced `webui:`); `routing.boundary`, `taskBrief` and `qualityOverride` are accepted and ignored. Per key and session (bounded LRU, 30-minute TTL) the Router remembers the deployment the last turn ran on and tries it first next turn when it is still eligible and the key may use it (cloud requires `cloud: true`). A missing, expired or ineligible entry just routes normally.

## Reasoning effort

The standard `reasoning_effort` (`none | minimal | low | medium | high | xhigh`; `minimal` is `low`) passes through, mapped onto the chosen deployment's supported levels (next supported level up, else the highest). Absent, each deployment runs its cheapest level: off when supported, else its lowest graded level, or mandatory thinking `on`. A deployment that cannot think runs without.

## Batch

`/v1/batches` items run locally as flex, only while no interactive work runs. Undispatched items spill to OpenRouter Batch only when the submitting key has `cloud: true` (after `CLOUD_SPILL_DELAY_MS`, one hour, or at once when local can never serve them or Gufo is down, full or draining). Other jobs wait for local capacity until their 24-hour window expires. See [batch.md](batch.md#spill-rule).

## System One

`/v1/systemone` passes each request to the named Kev or Jev deployment. Any key may use the configured deployments; priority orders its queue, which waits up to the high or medium budget.

## Embeddings

`/v1/embeddings` goes to the one local embeddings deployment under the same rules as System One. It never uses cloud, whatever the key's `cloud` flag: an unreachable server is 503 ([ADR 0006](adr/0006-embeddings-stream-to-one-local-deployment.md)).

## COGS and completeness

Responses expose OpenRouter-compatible `usage.cost` on non-stream completions and the final streaming usage.

| Kind               | Meaning                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Actual (cloud)     | Provider-reported `usage.cost` and token fields, passed through                                  |
| Accounting (local) | Configured per-deployment input / cached-input / output rates × observed tokens. Not an invoice. |
| Unknown            | Missing, cancelled, incomplete, or missing rates: **never coerced to zero**                      |

Preserve prompt, completion, cached-input and reasoning counts; never count reasoning tokens twice. A session pin is not a cache hit and never applies the cached-input rate.

## Analytics

Metadata only, no transcripts: time trends and breakdowns by key, priority and deployment; COGS reported vs unknown; local vs cloud share; decision reasons; queue wait, TTFT, decode TPS and latency when observed; error and cancel counts; paginated request drilldown. Classifier and assessment fields remain in the response shapes for historical rows and are null or empty for new ones. HTTP success is not task success.

## Admin access

The console is internal: no login form and no admin session. Deployments gate it at the proxy (forward auth in front of everything except `/v1` and `/health`), see [setup.md](setup.md). Inference keeps `jrv_` API keys, which never authorize administration. Mutations require the exact `APP_ORIGIN` and the same-origin admin header.
