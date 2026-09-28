# Deployment catalogues

`MODEL_CATALOG` selects the chat catalogue. `AUXILIARY_CATALOG` optionally selects System One deployments. Catalogues contain endpoint/model facts and ranking/accounting configuration, never provider secrets. Restart the gateway after changing them; catalogue content hashes invalidate assessment reuse.

## Gufo chat

`catalog.example.json` holds one Gufo deployment and the OpenRouter `cloud-glm` deployment. `scripts/setup.mjs` copies it into the live catalogue and sets the Gufo endpoint from `--gufo-endpoint`. Without that flag the entry keeps `REPLACE_GUFO_ENDPOINT`, and the gateway refuses the whole catalogue for inference rather than silently skipping a broken local entry. Never commit the private endpoint or credential. A missing `GUFO_API_KEY` makes the Gufo deployment unavailable rather than sending unauthenticated requests.

The deployment ID is `gufo-qwen3.8-flash-next`; the **exact provider model alias** is `qwen3.8-flash-next-gufo` with transport `gufo`. Gufo's authenticated `GET /v1/models` must advertise that exact ID; the health probe checks it, and the adapter rejects any response whose `model` differs from the catalogued alias. Context 131,072 and maximum output 8,192 tokens are catalogue limits, not measurements. The adapter caps output with `max_tokens`.

`capacity.maxParallel: 24` matches Gufo's 24 sessions and is the **router admission permit cap**. `reservedInteractiveSlots: 4` keeps four permits for **high** keys; medium and low keys share the other twenty. Permit occupancy is not verified runtime saturation. Router permits cannot see load from clients that call Gufo directly. Gufo advertises tools, but not JSON mode or vision: `capabilities: { tools: true, json: false, vision: false }`. Tool fields are only sent for tool requests. No cache or disk-cache capability is claimed.

Gufo exposes graded `reasoning_effort` `off`, `low`, `medium`, `xhigh`: catalogue `reasoning.levels` are `none`, `low`, `medium`, `xhigh`; `none` maps to `off`. There is no native `high` level (a requested `high` maps upward to `xhigh` under existing effort routing), and no `enable_thinking` switch. Reasoning-token estimates are provisional ranking allowances, not observed usage. Quality and latency values are **unmeasured operator bootstrap priors**, not benchmarks or calibrated task-success probabilities. All three numeric price fields are zero only as schema-compatible placeholders with `prices.provenance.source: "unknown"`: these are **not** a claim of zero operating cost. A key's non-null `maxEstimatedUsd` rejects this candidate until meaningful rates with provenance are configured.

Direct checks on 2026-09-24 observed: unauthenticated `GET /v1/models` 401; authenticated 200 with only `qwen3.8-flash-next-gufo`; an unknown model 404 `model_not_found`; exact-alias non-streaming and SSE responses reporting that model with final usage; and tool calls with `tool_choice` `auto` or `required`. Gufo rejects OpenAI's named `{type:"function",function:{name}}` form with 400 `invalid_tools`, so the adapter sends exactly the named tool with `tool_choice: "required"`, which is equivalent. During an earlier restart window, the same address briefly returned responses labelled with another model; this is why the adapter checks the served model name. These are protocol checks, not quality, latency, or router-routed evidence.

Gufo chat completions, including streams, send `X-Gufo-No-Queue: 1` and carry the Router request id as `X-Request-ID`, under Gufo's router contract (Gufo `docs/ROUTER.md`, contract version 1). Gufo refuses before enqueueing with HTTP 429 `queue_full` or `client_queue_full` when it is full, 429 `resource_unavailable` when it has no idle compute for a flex request, and 503 `draining` during maintenance; an empty-body 429 from the key proxy in front of Gufo means the same as a full queue. The Router treats these as local overload and passes Gufo's `Retry-After` through. Low keys and `service_tier: "flex"` requests are sent as flex; see [routing policy](routing-policy.md#priority-and-queues). `GET /v1/runtime` reports whether a default request could start now and is the Verified saturation evidence. Unknown non-empty HTTP 429/503 responses remain provider failures.

## OpenRouter GLM-5.3-Flash

The selected cloud model is exactly **`z-ai/glm-5.3-flash`**, not base GLM-5.3 or another provider/model substitution. Endpoint `https://openrouter.ai/api/v1`, credential variable `OPENROUTER_API_KEY`.

The example pins `sail-research/fp8` with fallbacks disabled and `require_parameters=true`. Public endpoint metadata inspected on 2026-09-20 advertised:

- Context 1,048,576; maximum completion 131,072.
- Tools including forced tool choice, JSON/structured output and reasoning controls.
- USD per million: input **0.1425**, cached input **0.0285**, output **0.475**.
- `supports_implicit_caching: false`. A cached-input price is not a cache-hit guarantee.

Source: [OpenRouter endpoint catalogue](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints). Prices and endpoint availability can change; refresh them before relying on a spend estimate. No paid completion was used to verify these facts.

The k3s `cloud-glm` deployment instead pins **`inference-net` (fp4)**, matching the
first provider in the workstation OMP routing preference. On 2026-09-26, its
endpoint metadata advertised context **1,048,576**, maximum completion **128,000**,
and USD per million tokens: input **0.045**, cached input **0.01**, output **0.14**.
It advertised tools, tool choice, JSON/structured output and reasoning controls.
The same catalogue listed `deepinfra` (fp4) at input **0.075**, cached input
**0.015**, output **0.25**, with maximum completion **131,072**. These are advertised
rates, not a cache-hit guarantee or a paid request measurement. The synchronous
router adapter encodes `providerRestriction` as exactly one provider in `only`
and disables OpenRouter fallbacks; it cannot reproduce OMP's ordered
InferenceNet → DeepInfra backup within one deployment. The pinned cloud entry
therefore fails closed rather than silently routing to another priced provider.

Pinning one provider is intentional for cache locality: switching serving endpoints
can turn a warm prompt prefix into a paid cache miss. OpenRouter documents its
[sticky routing](https://openrouter.ai/docs/guides/best-practices/prompt-caching),
but it can fall back when a sticky provider becomes unavailable; this deployment
instead sends a single `provider.only` entry with `allow_fallbacks: false`.

The [Chat Completions success schema](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)
does not guarantee a top-level serving-provider field. After a completed generation,
the gateway asynchronously reads the documented
[`GET /api/v1/generation?id=…` metadata](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation)
`data.provider_name` to verify the provider identity (the slug before any `/`
variant). For example, `sail-research/fp8` matches `Sail Research`; the `/fp8`
or `/us` variant itself cannot be verified from generation metadata. The gateway
logs a mismatch once and raises a bounded metric without failing the served
request. A failed or missing metadata lookup is unknown, not a match; shutdown
skips lookups. Deployments without a cloud provider restriction are not checked.

[OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
returns `usage.prompt_tokens_details.cached_tokens` by default when available,
including in the terminal stream chunk. `usage.include` and
`stream_options.include_usage` are deprecated no-ops; neither is required.

Its `maxParallel: 4` is a conservative router admission cap, not a measured
provider concurrency guarantee. Public metadata does not prove the
provider-specific chat adapter behavior; no paid inference was performed.

The current OpenRouter health check uses authenticated `GET /api/v1/auth/key`,
not `/models`. A ready cloud deployment confirms the credential and network
path, not that InferenceNet is presently serving this model. The provider
metadata above comes from a separate public endpoints-catalogue request.

Reasoning is configured as binary thinking-on/off, because exact graded backend semantics were not independently established. The gateway reports applied `on`, not an invented high/xhigh execution level. Reasoning-token counts in the catalogue are estimates for ranking, not measured usage.

Cloud quality and latency numbers are explicitly labelled **operator bootstrap priors**, not benchmarks or calibrated success probabilities. For a cloud-only installation, delete the Gufo entry from the generated catalogue.

The router identifies itself on every OpenRouter call, including health checks and batch requests, with `HTTP-Referer: https://github.com/dymoo/llm-router`, `X-OpenRouter-Title: llm-router` and `X-OpenRouter-App-Visibility: hidden`.

## Local accounting and unknown values

The local example's price provenance is `unknown`. Its numeric zeros are not configured COGS. Set input, cached-input and output rates with a meaningful source/date before treating local accounting as known. Explicit configured zero is supported; absent accounting remains null.

Accounting uses observed token counts. Reasoning tokens are already part of completion tokens and are not added twice. Missing cached counts prevent a discount calculation unless cached/uncached rates are equal, in which case the known total does not imply a cache hit. Session affinity and provider pinning are never cache evidence.

A `maxEstimatedUsd` ceiling fails closed when candidate pricing is unknown. Ranking estimates are not invoices and exclude classifier/tool spend.

## System One (Kev and Jev)

`modality: "systemone"` deployments serve TypeSafe's `POST /v1/systemone`.
They name a `transport`:

- `gufo`: local Kev-4B on Gufo (`gufo serve llm --systemone-model`).
  `endpoint` is Gufo's `/v1` base; `credentialEnvVar` names the Gufo key.
  Gufo batches queued requests into one packed pass, so give it a
  `maxParallel` near its `/v1/runtime` `systemone.max_pending`.
- `typesafe`: cloud Jev (`location: "cloud"`, endpoint
  `https://api.typesafe.ai/v1`, `credentialEnvVar: "TYPESAFE_API_KEY"`).

`maxBatchSize` caps questions per request (at most 128) and `maxBodyBytes`
the request body. `requestUsd` is a per-request rate; otherwise
`inputUsdPerMillion` prices reported input tokens. Clients may name a
deployment id, or `kev-latest` / `jev-latest` for the first Kev or Jev
deployment. The router never substitutes one for the other: their
probabilities differ.

`catalog.auxiliary.example.json` holds this Kev entry with
`REPLACE_GUFO_ENDPOINT` in place of the endpoint shown below. Copy it to a private file, set the endpoint, and
point `AUXILIARY_CATALOG` at it (on Compose, set `AUXILIARY_CATALOG_FILE`
and `AUXILIARY_CATALOG=/etc/llm-router/auxiliary.json`). `CLASSIFIER_MODE=kev`
uses this Kev deployment as the Classifier; see
[operations](operations.md#routing-mode-configuration).

```json
{
  "id": "gufo-kev-4b",
  "modality": "systemone",
  "transport": "gufo",
  "location": "local",
  "credentialEnvVar": "GUFO_API_KEY",
  "modelId": "kev-4b",
  "endpoint": "http://192.168.6.62:8000/v1",
  "resourceId": "gufo-kev",
  "capacity": { "maxParallel": 32, "reservedInteractiveSlots": 0 },
  "maxInputTokens": 32768,
  "maxBatchSize": 128,
  "maxBodyBytes": 4194304,
  "inputUsdPerMillion": 0,
  "requestUsd": null,
  "priceVersion": "local-free"
}
```
