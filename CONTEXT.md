# LLM Router

A self-hosted coding-agent inference gateway: it authenticates keys, runs work on the local GPU runtime first, and lets opted-in keys use the cloud tier when local cannot take it. It is not a model runtime.

## Product

**Router**:
The control plane that authenticates keys, picks a deployment by key policy, and holds a deployment permit through generation.
_Avoid_: proxy, load balancer, classifier, Gufo, runtime, analytics warehouse

**Key**:
A tenant credential whose stored policy (`priority`, `cloud`, `requestsPerMinute`, `maxConcurrent`) is the sole authority for how its requests route and are admitted.
_Avoid_: user, account, admin login, session cookie

**Catalogue**:
The operator-owned set of concrete deployments the Router may use, each identified by live endpoint facts rather than marketing names.
_Avoid_: model card, provider slug, sample scores as measurements

**Deployment**:
One served model at one endpoint, with a location, transport, verified limits, and capabilities.
_Avoid_: model (when meaning the live endpoint), Qwen, GLM, frontier as if they were deployments

## Routing

**Priority**:
A non-preemptive admission rank of high, medium, or low. High and medium use the default tier; low always uses Flex. A deployment's `reservedInteractiveSlots` keep permits for high keys only.
_Avoid_: interactive, background, preemption, SLA

**Cloud switch**:
A key's `cloud` flag: whether its high and medium work may go to the first eligible cloud deployment when local is unavailable or the wait budget runs out. It never applies to Flex.
_Avoid_: locality bias, overload action, automatic paid fallback, retry after dispatch

**Wait budget**:
How long default-tier work waits for a local permit or Gufo admission before cloud or `local_overloaded`: 5 s for high, 30 s for medium (`LOCAL_WAIT_MS`).
_Avoid_: maxWaitMs, per-key wait

**Flex**:
Gufo's idle-compute service tier (OpenAI `service_tier: "flex"`). Low keys always use it and any key may ask for it. Requests wait in the Router's FIFO flex queue; at most Gufo's `flex_limit` are dispatched at once, the slot holder retries Gufo's refusals, and nothing waits past 10 minutes. It never goes to cloud.
_Avoid_: batch, low-cost cloud, preemptible, overload failover

**Local overload**:
No Router permit on any eligible local deployment within the wait budget, a definitive Gufo refusal before execution (queue full, draining) that outlasts it, or a local deployment that is down.
_Avoid_: verified saturation, unknown health, an uncertain failure after provider contact

**Eligible**:
A deployment that could ever serve the request: required capabilities (tools, JSON, vision) and the request's context and output fit. A request with no eligible deployment the key may use fails `no_eligible_model`.
_Avoid_: ranking, score, quality floor

**Effort**:
The thinking control a request runs with: the client's `reasoning_effort` mapped onto what the selected deployment supports, else its cheapest level.
_Avoid_: applied `on` as a graded `high`, inferred task complexity

**Session**:
A client-named trajectory (`routing.sessionId`, or an Open WebUI chat id), namespaced by key. Its next turn tries the deployment its last turn ran on. Best effort: a session never fails a request.
_Avoid_: admin session, login, pin as a cache hit, boundary protocol

## Batch

**Batch job**:
A submitted unit of low-priority deferred chat work: one model, one completion window, a bounded set of items, and one terminal status.
_Avoid_: background job, bulk request, upload, task queue

**Batch item**:
One chat request inside a Batch job, admitted and accounted through the ordinary routing path when it dispatches.
_Avoid_: sub-request, queued message, row

**Deferred lane**:
The scheduling lane in which Batch items wait for idle capacity: dispatch as Flex only when no interactive work runs.
_Avoid_: low priority, background priority, overflow queue, preemption

**Spill**:
Sending a cloud key's undispatched Batch items to the pinned OpenRouter Batch path. A key without `cloud` never spills; its items wait for local capacity until the job expires.
_Avoid_: failover, overflow, automatic paid fallback

**Result holding**:
The bounded per-key opt-in store of a Batch job's terminal results (read retry-safely, held briefly, then deleted), kept apart from the metadata store and Analytics.
_Avoid_: transcript archive, prompt store, results database, full capture

## Runtimes

**Gufo**:
The owner's private GPU inference server on a Strix Halo host, and the only local runtime. The Router reaches it over HTTP with a bearer key (`transport: "gufo"`). It is operated outside this repository and is not a Compose service. Another local OpenAI server can use the generic `openai-compatible` transport.
_Avoid_: bundled runtime, Compose service, runtime choice, Router

**System One**:
TypeSafe's API for typed questions about a state (`POST /v1/systemone`). The Router passes each request to one named Kev or Jev deployment and never substitutes one for the other.
_Avoid_: chat completion, task classifier, automatic fallback

**Kev**:
TypeSafe's System One model served locally by Gufo, an Auxiliary deployment with `transport: "gufo"`.
_Avoid_: Jev, Gufo chat deployment, generator, automatic fallback

**Jev**:
TypeSafe's cloud System One model, an Auxiliary deployment with `transport: "typesafe"`.
_Avoid_: the Router, paid fallback, Kev

**Auxiliary deployment**:
An explicitly configured System One endpoint: Kev on Gufo or cloud Jev. Any key may use it; it keeps admission, resource ownership and accounting, and never falls back to another deployment.
_Avoid_: automatic chat fallback, unmetered side channel, free because local

**Auxiliary resource**:
A shared admission identity (`resourceId`) for auxiliary deployments on the same backend. It is distinct from a model ID and a chat permit.
_Avoid_: one independent pool per model, unconstrained parallelism

**Open WebUI**:
An optional chat client of the gateway. Its dedicated gateway key governs its calls; its own conversation store is separate from gateway metadata.
_Avoid_: runtime bypass, provider credential store for this topology, gateway transcript logging

## Accounting

**COGS**:
Recorded generation cost that distinguishes cloud provider actuals, internal local accounting, and unknown. Missing counts or rates are unknown, never invented zero.
_Avoid_: local API bill, invoice, monthly budget, session as a cache discount, double-counted reasoning tokens

**Accounting cost**:
An internal figure on a response, including local generation priced from configured per-deployment input, cached-input, and output rates. It is not a provider invoice. Cloud `usage.cost` is the provider’s actual, passed through.
_Avoid_: electricity guess, invented zero

**Cache hit**:
Deployment-specific evidence that cached tokens were actually used on generation.
_Avoid_: Session, stickiness, provider restriction, repeated prompt

**Analytics**:
First-class time-trended views of routing, COGS, cache, and performance, broken down by key, priority, and deployment, with metadata request drilldown.
_Avoid_: request counters only, HTTP 200 as task success, prompt store

**Route decision**:
The recorded reason a request went where it did (local, sticky, queued, cloud after local overload, or why it failed).
_Avoid_: guessed route, undocumented ranking

**Task success**:
Whether the coding Task actually completed useful work. It is not HTTP success and is not inferred from a generation finish reason.
_Avoid_: HTTP 200, stream close, paid evaluator as current fact

**Full capture**:
Stored prompts, completions, and related transcript text. It is not collected now. A later opt-in would be per-key, access-controlled, retained, redacted, and storage-budgeted.
_Avoid_: current analytics, default logging, silent chat archive
