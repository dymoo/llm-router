# LLM Router

A self-hosted coding-agent inference gateway: it assesses a task, then reserves a model deployment and reasoning configuration through execution. It is not a model runtime.

## Product

**Router**:
The control plane that authenticates keys, assesses tasks, and holds a deployment reservation through generation.
_Avoid_: proxy, load balancer, classifier, Halogen, runtime, analytics warehouse

**Key**:
A tenant credential whose stored policy is the sole authority for priority, locality, limits, and ranking biases.
_Avoid_: user, account, admin login, session cookie

**Catalogue**:
The operator-owned set of concrete deployments the Router may use, each identified by live endpoint facts rather than marketing names.
_Avoid_: model card, provider slug, sample scores as measurements

**Deployment**:
One served model at one endpoint, with a location, transport, verified limits, and capabilities.
_Avoid_: model (when meaning the live endpoint), Qwen, GLM, frontier as if they were deployments

## Assessment

**Assessment**:
A semantic reading of a task (kind, difficulty, effort, local sufficiency, and related signals). It never does arithmetic, admission, or spend. Raw answers remain reusable when ranking sliders change, so long as the evidence and question meanings are unchanged.
_Avoid_: route, live wait/load/price text, Jev as fallback router, classification as authorization

**Classifier**:
The assessment backend, either local Laya or explicitly selected remote Jev.
_Avoid_: generator, Router, automatic fallback

**Classifier readiness**:
Operational status used to decide whether to attempt an Assessment, based on configuration evidence for a remote backend or a live local probe. It does not establish calibrated quality or Task success.
_Avoid_: quality score, Task success, benchmark

**Calibration**:
Measured agreement between one Classifier backend revision and labelled judgments on a declared evaluation set, reported per Assessment question with the errors it permits.
_Avoid_: confidence, readiness, self-claimed accuracy, benchmark as Task success

**Classifier qualification**:
The dated record pairing one Classifier backend revision and question schema with its measured Calibration and sourced token rates. Production routing fails closed without it; absent rates stay unknown.
_Avoid_: licence, certification, model card, readiness

**Laya**:
The local classifier model. Default execution is CPU. NPU is optional and only when IOMMU is enabled.
_Avoid_: Halogen, local Qwen, NPU as the default, generator

**Jev**:
The remote TypeSafe assessment service, used only when the operator selects it.
_Avoid_: the Router, paid fallback, local classifier

**Task**:
A unit of user work, assessed at a safe boundary and not on every tool turn.
_Avoid_: request, turn, tool call, session

**Task brief**:
An advisory compact description of a long task for the Classifier. It is not the generation prompt, not authorization, and not a silently truncated history.
_Avoid_: last user message, truncated prompt, silent summary

**Question overhead**:
The Classifier question text that consumes Laya or Jev context alongside the task state.
_Avoid_: generation tokens, prompt cache, unused 1k family window, mutable occupancy or price snapshots

## Routing

**Route**:
A deployment and reasoning configuration reserved through execution, not a disconnected ranking result.
_Avoid_: suggestion, score, assessment

**Hard constraint**:
A permission, capability, context, quality, or spend limit that ranking and locality cannot override.
_Avoid_: bias, locality preference, score

**Locality bias**:
A continuous per-key preference in `[0, 1]` for keeping work on local deployments. It is not a privacy lock and not a binary cloud-overflow switch.
_Avoid_: local-only, privacy, routingPreference, allowCloudOverflow, cloud-overflow

**Priority**:
A non-preemptive admission rank of high, medium, or low.
_Avoid_: interactive, background, preemption, SLA, reservedInteractiveSlots (deployment reserve, not key priority)

**Verified saturation**:
Evidence from the local runtime that it cannot accept more work. Gateway slot counts and missing telemetry are not saturation.
_Avoid_: semaphore full, unknown health, complexity, busy guess

**Cost bias** / **Quality bias** / **Latency bias**:
Independent per-key ranking weights in `[0, 1]`. They never relax a hard constraint.
_Avoid_: locality bias, monthly budget, invoice cap

**Effort**:
The thinking control requested from the Assessment and mapped onto what the chosen deployment actually supports.
_Avoid_: applied `on` as a graded `high`, no-thinking as the default for coding

## Batch

**Batch job**:
A submitted unit of low-priority deferred chat work: one model, one completion window, a bounded set of items, and one terminal status.
_Avoid_: background job, bulk request, upload, task queue

**Batch item**:
One chat request inside a Batch job, admitted and accounted through the ordinary routing path when it dispatches.
_Avoid_: sub-request, queued message, row

**Deferred lane**:
The scheduling lane in which Batch items wait for idle capacity — dispatch only when interactive queues are empty, and never compete with high, medium, or low admission.
_Avoid_: low priority, background priority, overflow queue, preemption

**Result holding**:
The bounded per-key opt-in store of a Batch job's terminal results — read retry-safely, held briefly, then deleted — kept apart from the metadata store and Analytics.
_Avoid_: transcript archive, prompt store, results database, full capture

## Continuity

**Session**:
A key-namespaced client trajectory that reuses an Assessment, deployment, and effort until a safe boundary.
_Avoid_: admin session, login, one session for every request on a Key

**Session pin**:
The stored Route for a Session. Affinity is not a cache hit.
_Avoid_: KV residency, prefix-cache evidence, provider restriction as a hit

**Boundary**:
The client declaration of `new-task` (assess and pin), `continue` (reuse the pin), or `checkpoint` (reassess when a switch is safe).
_Avoid_: silent migrate, mid-tool switch, inferred shared session

**Checkpoint**:
A client-declared safe point where reclassification and a controlled deployment change are allowed.
_Avoid_: continue, crash recovery, automatic retry after dispatch

## Runtimes

**Local generator**:
A separate completion process reached through a small adapter. llama.cpp and Halogen are first-class runtime choices with matching catalogue and Compose configuration.
_Avoid_: Classifier, Halogen as required default, baked-in runtime

**llama.cpp**:
A supported GGUF generator. The optimized native control is the pinned pwilkin Strix Halo build with isolated ROCr/HIP for Qwen3.8-Flash-Next. A separately pinned upstream Vulkan Compose image supplies a compatibility lane, not an equivalent-performance claim. Hardware validation remains pending.
_Avoid_: Halogen `.hgn`, proven quant, IOMMU-off as a llama.cpp requirement, generic Vulkan pin as gfx1151 proof

**Halogen**:
A supported generator adapter using the unmodified Flash Server image and its matching quality overlay. `.hgn` weights are not portable to llama.cpp. The public packaging restriction applies to this image only.
_Avoid_: required default, combined public image, GGUF, deleted adapter

**NPU**:
The XDNA2 inference processor used optionally by FastFlowLM for embeddings and transcription, with IOMMU enabled. Laya's separate VitisAI path is experimental; CPU remains its default. Sharing an NPU with GPU chat still shares host RAM and memory bandwidth.
_Avoid_: default Laya backend, CPU Laya, llama.cpp prerequisite

**Auxiliary deployment**:
An explicitly configured embedding or transcription endpoint. It uses key policy, admission, resource ownership and accounting without chat-task classification or GPU/cloud fallback.
_Avoid_: automatic chat fallback, unmetered side channel, free because local

**NPU resource**:
A shared admission identity for auxiliary deployments on the same physical NPU. It is distinct from a model ID and a GPU chat slot.
_Avoid_: one independent NPU per model, unconstrained parallelism

**Open WebUI**:
An optional client of the gateway for chat, RAG embeddings and speech-to-text. Its dedicated gateway key governs all those calls; its own conversation store is separate from gateway metadata.
_Avoid_: runtime bypass, provider credential store for this topology, gateway transcript logging

## Accounting

**COGS**:
Recorded generation cost that distinguishes cloud provider actuals, internal local accounting, estimates, and unknown. Missing counts or rates are unknown, never invented zero.
_Avoid_: local API bill, invoice, monthly budget, pin as a cache discount, double-counted reasoning tokens

**Accounting cost**:
An internal figure on a response, including local generation priced from configured per-deployment input, cached-input, and output rates. It is not a provider invoice. Cloud `usage.cost` is the provider’s actual, passed through.
_Avoid_: electricity guess, invented zero, ranking estimate as billed cost

**Cache hit**:
Deployment-specific evidence that cached tokens were actually used on generation.
_Avoid_: Session pin, affinity, provider restriction, repeated prompt, classifier exact cache

**Classifier exact cache**:
Reuse of an Assessment for the same key, backend, question schema, state, and catalogue version.
_Avoid_: Cache hit, Session reuse, fuzzy semantic cache

**Session reuse**:
Continuing a Session from a pin without a new Assessment.
_Avoid_: Cache hit, Classifier exact cache

**Analytics**:
First-class time-trended views of routing, COGS, cache, and performance, broken down by key, priority, and deployment, with metadata request drilldown.
_Avoid_: request counters only, HTTP 200 as task success, prompt store

**Policy decision**:
The recorded reason a Route was chosen and why other candidates were excluded.
_Avoid_: Assessment as authorization, guessed route, undocumented ranking

**Task success**:
Whether the coding Task actually completed useful work. It is not HTTP success and is not inferred from a generation finish reason.
_Avoid_: HTTP 200, stream close, paid evaluator as current fact

**Full capture**:
Stored prompts, completions, and related transcript text. It is not collected now. A later opt-in would be per-key, access-controlled, retained, redacted, and storage-budgeted.
_Avoid_: current analytics, default logging, silent chat archive
