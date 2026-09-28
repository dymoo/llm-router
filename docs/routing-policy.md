# Routing policy

Normative product policy for dymoo/llm-router. The decisions below supersede conflicting controls in the original model-router handoff. Numeric defaults are editable suggestions, not measured optima, SLAs or calibrated success probabilities.

Stack (given, not re-argued here): Effect 4 RC, Drizzle on SQLite, Next.js, T3 Env for typed configuration. Topology, env names, backup, and drain live in operator docs — do not copy them here.

- Topology, accounting retention, timeouts: [operations.md](operations.md)
- Env, bind, proxy-gated console: [setup.md](setup.md)
- Open WebUI and System One: [ai-hub.md](ai-hub.md)
- Live catalogue facts: [catalogue.md](catalogue.md)
- Session metadata for coding agents: [clients.md](clients.md)
- Domain language: [../CONTEXT.md](../CONTEXT.md)
- Shape decisions: [adr/0001-assessment-versus-deterministic-routing.md](adr/0001-assessment-versus-deterministic-routing.md), [adr/0002-separate-runtime-deployment-and-licensing.md](adr/0002-separate-runtime-deployment-and-licensing.md), [adr/0003-metadata-analytics-without-transcripts.md](adr/0003-metadata-analytics-without-transcripts.md)

## Authority and superseded handoff controls

| Status         | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **In force**   | Explicit classifier-free Rules mode or qualified Kev/Jev assessment followed by deterministic chat routing; locality bias `[0,1]`; high/medium/low priority, with low keys on Gufo flex; hard limits; pinned task continuations; tenant-scoped exact classifier cache in assessed modes; explicit briefs without silent truncation; no classifier fallback; internal admin gated by an authenticating proxy; metadata-only accounting/analytics; Gufo as the local runtime; Open WebUI routes through the gateway.                                                                                                                                                                                                                     |
| **Superseded** | Mandatory admin login / `admin_sessions`; optional admin Basic auth; priority `interactive \| background`; privacy `local-only \| cloud-allowed`; `routingPreference`; binary `allowCloudOverflow`; silent cloud spill; silent classifier fallback; silent classifier truncation; sample catalogue numbers as measurements; automatic paid classifier fallback; counters-only admin; treating HTTP 200 as task success; collecting chat transcripts by default; selectable local runtime adapters and Compose runtime profiles; a separate local classifier service; embeddings and transcription endpoints; omitting `usage.cost` on local; treating local API price 0 as COGS zero; inventing zero for unknown token counts or rates |

The handoff remains useful for stack intent, reservation-through-execution, and “do not invent live model ids.” It is not authority for the superseded rows.

## Hard constraints

A candidate is ineligible unless it satisfies **all** of:

- Key allowlist (empty list denies all; unset means every configured deployment, including ones added later)
- Key and deployment context / completion limits (input plus generation allowance must fit **both**)
- Required capabilities (tools, JSON, vision) and supported reasoning
- Configured minimum quality / health — when those fields are present and verified
- `maxEstimatedUsd` when set (cold-cache, max-generation **estimate**, not an invoice cap; excludes classifier and tool charges)

Locality bias, cost/quality/latency weights, and priority **cannot** compensate a failed hard constraint. If nothing is eligible, fail explicitly. Do not downgrade quality, widen a budget, or change locality to invent a candidate.

## Locality bias

Per-key slider in `[0, 1]`. Preference, not a percentage of traffic, not a privacy mode, not a location lock.

| Region                           | Intent                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 (less local / cloud-first)** | Complexity may escalate to cloud. Local stays eligible when it meets hard limits.                                                             |
| **Intermediate**                 | Prefer local. Highly complex work may still use cloud. Verified saturation may also use cloud.                                                |
| **1 (maximum local)**            | Stay local until **verified saturation**. Complexity alone does not escalate. Gateway permit counts and unknown telemetry are not saturation. |

Live UI copy must describe the current value (slider plus sentence), not a hidden enum. Escalation still waits for a **checkpoint** on an existing Session; `continue` does not silently migrate.

## Priority and queues

Admission and wait order is **high, then medium, then low**. Non-preemptive: in-flight work is not cancelled for a higher key. A deployment's `reservedInteractiveSlots` keep that many permits for **high** keys only — see [operations.md](operations.md).

Priority also sets the Gufo service tier (Gufo `docs/ROUTER.md`):

| Priority     | Tier     | Behaviour                                                                                                                                                                                                                                                     |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| high, medium | default  | Router permits and queue; overload per `overloadAction`                                                                                                                                                                                                       |
| low          | **flex** | Idle local compute only. Gufo refuses flex while default work is queued or prefilling; the Router retries after its `Retry-After` until `maxWaitMs`, then returns 429 `resource_unavailable`. Never spills or fails over to cloud, whatever the locality bias |

Any key can ask for flex per request with `service_tier: "flex"`; a low key cannot ask for more. Gufo measured flex as a trickle beside agent load, so keep medium for work that must finish while the machine is busy, and low for work that can wait for idle time. Deferred bulk work belongs on `/v1/batches`.

Work waiting for local capacity must surface a **visible queued notice** to the client. It must not silently spill to cloud.

Do not claim a per-stream TPS floor or a measured host throughput. Those are unverified on this hardware.

## Local overload action

Local overload is an admission observation, **not Verified saturation**: no immediately available Router-owned permit for any Key-eligible local Deployment, or a definitive local runtime pre-execution rejection (Gufo HTTP 429 `queue_full`, `client_queue_full` or `resource_unavailable`, or HTTP 503 `draining`). Verified saturation from Gufo is its `GET /v1/runtime` report that a default request could not start now (`accepting.default: false`); an unreadable or unknown-version report is unknown, not saturation. Gateway permit counts alone do not prove the runtime is saturated. Unknown health and uncertain provider failures are not local overload evidence.

Each Key has an editable overloadAction, persisted with its policy. Missing values on historical policies and all suggestions default to report. A full-policy PATCH from an older client that omits the field preserves the stored action. No paid cloud dispatch is enabled by this default.

- **report**: retain the Key's local capacity wait up to maxWaitMs, then return local_overloaded: HTTP 503 with Retry-After for non-streaming requests, or a terminal SSE `router.error` event with `retry_after_seconds` for streams (their 200 SSE headers are already committed).
- **failover**: while still **before provider dispatch**, switch only to an already eligible cloud Deployment. Key allowlist, required capabilities, context/completion limits, credential availability, and maxEstimatedUsd with usable pricing still apply. If none qualifies, report local overload instead; never waive limits or infer a price of zero.

This action is separate from continuous Locality bias and must not turn incidental capacity into Verified saturation or alter locality-biased ranking spill. Never replay after uncertain provider contact. A pinned continue request does not silently migrate; only the existing safe-boundary rules permit switching. Operators must opt in to cloud failover per Key and understand it may incur provider charges.

## Policy suggestions

Every field is editable. Biases and locality use sliders with live descriptions. Names are starting points for Dylan’s keys, a balanced key, and a cheap background key — not locked profiles.

| Suggestion    | Priority | Ranking intent                | Locality intent                                                    | Queue                                 |
| ------------- | -------- | ----------------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| Dylan         | high     | Quality-biased; usually cloud | Low locality bias; complexity may escalate                         | Does not sit behind low work          |
| Balanced      | medium   | Cost-biased; usually local    | Mid-high locality; complexity or verified saturation may use cloud | After high                            |
| Free Vibecode | low      | Strong cost                   | Local idle compute only (flex)                                     | Up to 30 s for idle compute, then 429 |

Context, completion, RPM, concurrency, wait, allowlist, and `maxEstimatedUsd` remain operator-chosen. Earlier handoff tables (65k/131k/32k caps, 0.6/0.7 cost weights, `interactive`/`background`) are **not** mandatory. Relative intent stands: Dylan may receive a larger allowance than Free Vibecode; no number here is a tokenizer proof that a deployment can accept that cap.

## Rules mode

With `CLASSIFIER_MODE=rules`, the existing selection, reservation and dispatch path runs **without an Assessment**. No Kev/Jev client is constructed, no classifier endpoint/key is needed, and qualification files are neither loaded nor consulted (including admin analytics). This is an explicit mode, never an automatic fallback from an unqualified classifier.

1. Hard eligibility still checks the Key allowlist, tools/JSON/vision requirements, input estimate **plus the full requested completion allowance**, Key/deployment context and output caps, usable credentials, health, and cold-cache generation estimate against `maxEstimatedUsd`. Unknown pricing cannot satisfy an estimate ceiling; it is not zero. A local deployment with unknown prices remains eligible when no ceiling is set.
2. Among eligible deployments, locality orders first: bias **at least 0.5 prefers local**, below 0.5 prefers cloud, matching the existing locality preference seam. Within that location, existing cost/latency weights order candidates, with deployment ID as the stable final tie-break. There is no task-quality, difficulty, complexity-escalation, retrieval or expected-length judgment to invent. Output estimates use the full completion allowance. Quality bias and a highest-quality override cannot synthesize a task-quality signal.
3. For local-preferring Keys, busy locals retain `overloadAction`: **report** waits up to `maxWaitMs` then returns `local_overloaded`; **failover** tries eligible local permits first, then eligible cloud before dispatch. Definitive Gufo pre-enqueue/fast rejections keep the same behavior. An uncertain provider failure is never replayed.
4. A **down/unhealthy local that could otherwise serve this request** follows the same action. **report** immediately returns `local_overloaded` (HTTP 503 or terminal SSE `router.error`) without waiting `maxWaitMs` and without a paid-cloud call. **failover** can choose eligible cloud before dispatch. The existing bounded wire code is reused; the decision detail `local-unavailable` distinguishes downtime from exhausted permits. This covers Gufo’s planned 75–90 minute performance-test windows with :8000 down. A cloud-first Key can still choose cloud by preference, not because local is down.
5. If no local can satisfy the request’s non-health constraints (e.g. too large, missing a capability, or missing required credentials), use eligible cloud **regardless of overloadAction**, even at locality 1. Missing credentials are hard ineligibility, not evidence of runtime downtime; without an eligible cloud return `no_eligible_model`, not local overload. Key-level invalid limits and an empty allowlist retain their existing explicit errors. Health is considered after the other candidate constraints, so a down local that could never fit cannot block this cloud route.
6. Apply each deployment’s **lowest supported reasoning effort**: none/off when supported (Gufo maps `none` to `off`), otherwise the lowest graded level, or mandatory thinking `on`. No difficulty or task value is fabricated. Continuations retain the pin, including thinking-off; checkpoint hysteresis and safe-boundary switching remain in force. A down pinned local is reported rather than silently migrated, even for a failover Key.
7. Capacity ownership through streaming, interactive priority and deferred batch admission remain shared. Batch items use the same Rules selection seam, not synchronous cloud dispatch. Before the batch spill deadline, local downtime/pre-enqueue overload may accelerate **remote batch** planning only for `overloadAction=failover` and a configured batch spill port. The batch-only catalogue, key allowlist/capability/context/credential/spend filters and pre-submit key recheck still apply; report keys do not spill merely because local is down. The ordinary deadline-driven batch spill policy remains separate. See [batch.md](batch.md#spill-rule).

Fresh Rules decisions use bounded reason/selection code `deterministic-rules`; overload/failover keep their existing operational codes. Accounting records `classifierBackend: null`, no invented task/difficulty/confidence, no classifier usage, and no classifier-cache reuse (null; continuations still report session reuse). Deployment accounting and cache evidence remain unchanged.

## Classification (Kev/Jev modes)

- **Chat in assessed modes:** assess, then apply deterministic policy. This is not a fallback after a classifier-owned route. `/v1/systemone` requests name their deployment and are not assessed. A bounded Choice over already-filtered chat deployments remains a documented alternative, not the implemented design — [jev-routing.md](research/jev-routing.md).
- Assess a **Task** at `new-task` / `checkpoint`. Tool-result turns of the same Task use `continue` and reuse the Assessment.
- Classifier caching is exact, tenant-scoped and completed-result only: key + backend/model revision + question schema + state/brief + catalogue version. No fuzzy matching or in-flight coalescing.
- Reuse stored judgments across locality/cost/quality **slider** edits when the brief, evidence, and question meanings are unchanged. Do not put slider weights into question text.
- Include a semantic quality rubric in questions **only** when it changes meaning. Do not send mutable wait, load, or price text into classifier state for arithmetic — policy does that math.
- Short work may be classified from the real input. Long work needs an explicit compact **task brief** plus non-secret metadata (size, tools, turns). The generation prompt is never shortened to feed the Classifier.
- **Loss-awareness:** if neither the input nor the brief fits the selected Classifier (tokens, including question overhead), return an explicit context/brief error. Never silently truncate, guess a Route, or call the other Classifier.
- **Kev:** the same TypeSafe System One client as Jev, pointed at the Kev deployment in the auxiliary catalogue (its endpoint and `GUFO_API_KEY`, model `kev-latest`). Kev and Jev give different probabilities for the same question, so each needs its own qualification record.
- **Jev:** this product’s explicit selection bound for the brief is **32k** tokens. Official Jev documents a 64k total / 32k state+longest-question split, sourced in [jev-routing.md](research/jev-routing.md) and not re-measured here. Never silently shrink a larger brief. Cookbook cost/latency figures in that file are published examples, not this host.
- `CLASSIFIER_MODE` is explicitly `rules`, `kev` or `jev`; production runs `rules`. Kev/Jev retain their qualification gate. Neither classifier mode falls back to Rules or to the other classifier on failure.

Assessment confidence is concentration of the classifier’s output distribution, not the probability that generation will succeed.

## Affinity versus three reuse signals

These are different facts. Analytics and COGS must not collapse them.

| Signal                     | What it is                                                             |
| -------------------------- | ---------------------------------------------------------------------- |
| **Cache hit**              | Observed cached **input tokens** on the generator, deployment-specific |
| **Classifier exact cache** | Same Assessment reused for the same key/backend/schema/state/catalogue |
| **Session reuse**          | `continue` from a pin; affinity only                                   |

A pin, a repeated prompt, or a provider restriction is not a generation cache hit and must not apply a cached-input price. Deliberate migration at a checkpoint should expect a cold prefill.

## COGS and completeness

Track per key, priority, and deployment, without storing prompts. Responses expose OpenRouter-compatible `usage.cost` on **both** non-stream completions and the **final** streaming usage. Official nested field schema is owned/verified with the HTTP path — this file does not invent extra usage keys.

| Kind               | Meaning                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual (cloud)     | Provider-reported `usage.cost` and token fields, **passed through**                                                                                                                     |
| Accounting (local) | Internal cost from configured per-deployment **input / cached-input / output** rates × observed tokens. Zero external API bill does **not** omit the field. This is **not** an invoice. |
| Estimate           | Catalogue prices × estimated tokens, with provenance, used for ranking/`maxEstimatedUsd`                                                                                                |
| Unknown            | Missing, cancelled, incomplete, or missing rates — **never coerce to zero**                                                                                                             |

Preserve prompt, completion, cached-input, and reasoning **counts**. Do **not** add reasoning tokens twice (once as reasoning and again as completion) when computing accounting cost.

A pin is not a cache hit and must not apply the cached-input rate. Local catalogue API price 0 is not COGS unless the operator set explicit local rates. `maxEstimatedUsd` is not a monthly budget. Classifier charges, tools, and unmodelled fees are out of generation `usage.cost` unless separately recorded.

## Analytics

Analytics is a first-class console surface backed by bounded SQL aggregates and paginated metadata. Its date/key/priority/deployment filters apply to both totals and request drilldown.

**Now (metadata only — no transcripts):**

- Time trends and breakdowns by key, priority, and deployment
- COGS reported vs estimated vs unknown
- Local vs cloud share
- Observed cached input tokens vs classifier exact cache vs session reuse
- Policy decision reasons and candidate exclusions
- Complexity and effort distributions
- Queue wait, TTFT, decode TPS, and end-to-end latency when observed
- Error, cancel, and saturation counts
- Request **metadata** drilldown (ids, route, timings, usage fields — not prompt text)

Missing timings stay unknown. Do not invent TPS from catalogue placeholders. HTTP success is not task success.

**Not now:**

- Full chat / transcript logging
- A task-success classifier or paid evaluator

**Later, explicitly opt-in roadmap** (do not build as defaults):

- Full capture is sensitive. If added, it requires per-key opt-in, access control, retention, redaction, and a storage budget.
- A later evaluator, if any, is async, sampled, and deduplicated, with **separate spend** from inference. No paid evaluator calls on the default path.
- Distinguish **observed** test/tool outcomes from **model judgments**. Neither is HTTP 200.

## Admin access

The console is internal. There is **no login form and no admin session**. Reachability of the bound address is admin access, so deployments gate the console at the proxy (Authentik forward auth in front of everything except `/v1` and `/health`). See [setup.md](setup.md).

- Inference keeps `jrv_` API keys. Keys never authorize administration.
- Mutations still require the exact `APP_ORIGIN` and the existing same-origin admin header. That check is not a login.

Default bind is loopback. LAN bind is a deliberate exposure of administration.

## Runtime assumptions (unverified here)

- **Gufo is the local runtime.** It is the owner's private GPU inference server, reached over HTTP with a bearer key and operated outside this repository. The generic `openai-compatible` transport remains for another local OpenAI server. [ADR 0002](adr/0002-separate-runtime-deployment-and-licensing.md) records the earlier adapter-choice design and is superseded.
- Cloud chat is explicitly OpenRouter `z-ai/glm-5.3-flash`, with the selected endpoint and dated prices in [catalogue.md](catalogue.md). Public metadata was checked; paid generation and backend-specific graded effort were not. Binary thinking reports applied `on` truthfully.
- Sample quality, latency, and `tokensPerSecond` values are not measurements.
- Decode TPS and TTFT in analytics are observed request fields when present, not host benchmarks.
