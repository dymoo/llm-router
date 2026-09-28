# Jev / System One routing research

**Date:** 2026-09-20  
**Scope:** Official TypeSafe coding-agent skill, live docs, and official SDK contracts. No paid TypeSafe calls. No application-code changes.  
**Question:** Should Jev only emit semantic assessment (complexity / task / effort / local-sufficiency), or own the entire routing decision if given human-readable slider policies as a rubric, with deterministic fallbacks?

Facts, recommendations, and unknowns are separated below. Cookbook numeric results are quoted as published examples, not as measurements of this repo.

---

## Official skill URLs

| What                                          | URL                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Live skill page (source of truth for install) | https://docs.typesafe.ai/agent-skill                                                  |
| Skill Markdown                                | https://docs.typesafe.ai/agent-skill.md                                               |
| Official GitHub skill (raw)                   | https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md |
| Official GitHub skill (blob)                  | https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md           |
| Official skill directory                      | https://github.com/typesafe-ai/skills/tree/main/skills/typesafe-ai                    |
| Docs index the skill tells agents to read     | https://docs.typesafe.ai/llms.txt                                                     |
| HTTP API                                      | https://docs.typesafe.ai/api                                                          |
| Models / price / context                      | https://docs.typesafe.ai/models                                                       |
| Official JS SDK                               | https://github.com/typesafe-ai/typesafe-sdk-js (inspected `v0.6.0`)                   |

The GitHub tree for `skills/typesafe-ai` on `main` contains only `SKILL.md` and `LICENSE`. The live skill page still says to copy “the entire skills/typesafe-ai directory, including its reference files”; those extra files are not present in the inspected tree.

**Not official:** `@compootor/effective-jev` (this repo’s current Jev client). Official packages are `@typesafe-ai/sdk` (JS) and `typesafe_sdk` (Python).

---

## Strongest official guidance (quoted)

Skill (`SKILL.md`):

> Code owns the workflow; the model supplies programmable common sense where ordinary code needs semantic understanding.

> Keep known rules, calculations, exact lookups, and execution in code.

> **Ask independent questions over the same state together**, including useful speculative questions. They run in parallel and cannot see one another's answers.

> Choice/Score confidence summarizes distribution concentration, not overall workflow correctness or permission to act.

> Keep policy explicit and raw judgments reusable. Weighted scores suit compensating preferences; an “any serious violation” rule needs separate conditions. Changing a weight or display filter need not rerun inference when evidence and question meanings are unchanged.

How to build (https://docs.typesafe.ai/concepts/how-to-build-with-system-one):

> System One is TypeSafe's model for building AI-powered software, not agents. It does not generate code or choose its own next action.

**Scope of that quote (primary, not architecture inference):** it contrasts System One with agent loops that pick unconstrained next tools/steps. It does **not** forbid a typed Choice whose options are model or handler IDs. The use-case map explicitly lists “chooses which LLM receives each prompt.” What the same pages _do_ keep in code: arithmetic, authorization, lookups, side effects (admission), and composing answers.

> Keep control flow, deterministic rules, and side effects in code.

> Break broad judgments into narrow, typed questions with explicit instructions and criteria.

> Ask independent questions together, then compose their answers in code.

Primitives (https://docs.typesafe.ai/primitives):

> "Does this message convey urgency?" is a good question. "Analyze this message and determine the best course of action" is not.

> Every answer is independent. One question's answer is not hidden context for another.

> If a later judgment depends on an earlier answer, make a second request in code. The dependency is real only when your code cannot build the second request until it has the first answer.

Intent routing (https://docs.typesafe.ai/patterns/intent-routing): TypeSafe “sit[s] in front” as “a fast, cheap classifier that determines which handler to invoke.” The example asks **intent (Choice) + complexity (Score)** in one call; **code** then gates on confidence and dispatches to deterministic lookup, specialist LLM, or human.

Use-case map (https://docs.typesafe.ai/concepts/use-case-map), under “Model routing”:

> Use Jev to build a custom router that chooses which LLM receives each prompt.  
> Set routing rules and thresholds for your specific workflow.  
> Classify intent and domain.  
> Estimate difficulty and risk.  
> Escalate requests that need a more expensive model.

Those five bullets name **both** task assessment and candidate selection as intended uses. They do not say the model should apply live capacity, queue admission, session affinity, or dollar budgets.

Jaggedness for `jev-1.13` (https://docs.typesafe.ai/model-jaggedness/jev-1.13, reviewed 2026-09-17):

> Jev is not a calculator. We strongly recommend implementing any mathematical logic in code.

> Accuracy falls as the state grows with content unrelated to the decision.

> Jev suffers from context rot, so unrelated material in the `state` costs you accuracy.

---

## Facts: typed primitives and one `systemOne` call

Endpoint: `POST https://api.typesafe.ai/v1/systemone` with `state`, `model`, `questions`. ([API](https://docs.typesafe.ai/api))

| Primitive | Question             | Returns                                                                    | Limits                                                                         |
| --------- | -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Choice    | one of a defined set | `choice`, `probabilities` (sum to 1), `confidence` 0–1                     | max 255 options; add `other` / `none of the above` when coverage is incomplete |
| Score     | ordered rubric       | `score` (can land between levels), `legend`, `probabilities`, `confidence` | at least 2 levels, API accepts up to 10                                        |
| Noul      | yes/no               | `noul` in `[0,1]` only                                                     | optional `criteria.true` / `criteria.false`; **no** `confidence`               |

All three types may be mixed in one request. Every question sees the **same** `state`, is evaluated **in parallel and in isolation**, and cannot see sibling answers. Question IDs are for code and are **not sent to the model**; complete meaning must live in `instructions` + `criteria`. `instructions` and criteria values may be string, object, array, or (where allowed) `null`. Nested state is referenced with backticked paths such as `` `ticket.messages[0].text` ``.

`state` is string, JSON object, or array of text. Text only; no image/audio/video. English is the primary training language.

A second request is warranted only when the first answer is needed to fetch evidence, construct new state, or determine the next options. Otherwise pack speculative questions into the first call and ignore unused answers in code. Extra questions still consume tokens.

Official JS request shape (`typesafe-sdk-js` `v0.6.0` `src/types.ts`): `{ state, questions, model? }`. No `temperature`, `seed`, `cache_control`, `prompt_cache`, or reservation fields. `Usage` is only `{ input_tokens, output_tokens }`.

### Compact SDK example (grounded in official JS SDK README / `client.ts`)

```ts
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient(); // default model jev-latest
const response = await client.systemOne({
  state: { document: "I was charged twice. Please fix this ASAP." },
  questions: {
    category: choice("What is this ticket about?", {
      billing: null,
      technical: null,
      other: null,
    }),
  },
});
console.log(response.answers.category.choice);
```

---

## Facts: confidence vs probability

- Choice/Score `confidence` is a **statistic of the returned distribution**, not a separate calibrated P(correct) and not permission to act. ([Confidence](https://docs.typesafe.ai/confidence); skill quote above.)
- The docs’ interactive demo approximates three-option Choice confidence as `(3 × largest probability − 1) / 2`, i.e. `(n·peak − 1)/(n − 1)`. They explicitly say you may compute a different statistic from `probabilities`.
- Noul `0.5` means similar probability of yes and no, **not** medium intensity. (Skill; primitives.)
- Several acceptable alternatives can spread probability; low confidence need not invalidate a harmless preference.
- System One probabilities are trained for calibration **across groups of predictions**; that “does not guarantee that an individual answer is correct.” ([System One](https://docs.typesafe.ai/concepts/system-one))
- Intent-routing example uses `intent.confidence < 0.5` to escalate, and a separate complexity Score. Thresholds are domain-specific; cookbook numbers are examples, not universal rules.
- Jaggedness: do not carry a Noul threshold onto a Choice, and do not assume `P(noul) + P(not noul) = 1` across separate questions. A Choice is relative (“which option”); each Noul is absolute and can be low for every option.

This repo already documents the concentration semantics on `Assessment` in `src/domain.ts`: “Confidence is output-distribution concentration, not calibrated task-success probability.” That matches the official definition.

---

## Facts: context, cost, cache, retries, reproducibility

Inspected **2026-09-20** from [Models](https://docs.typesafe.ai/models) for `jev-1.13.0` (`jev-latest` and `jev-preview` both currently alias this ID):

| Item          | Official value                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Price         | **$42 / Btok = $0.042 / Mtok input.** Output tokens are **free**. Charged per input token.                                         |
| Context       | **64k tokens per request** covering `state` + all questions combined; **32k tokens for `state` plus the single longest question**. |
| Ingest        | State is ingested once; every question is evaluated against it in parallel.                                                        |
| Rate limits   | 250,000 tokens/s and 1,200 rpm; **“adjusting dynamically”** and can change without notice. Over-limit → `429`.                     |
| Input         | Text only.                                                                                                                         |
| Customization | No per-account fine-tune/LoRA. Shape answers via `state` + `instructions`/`criteria`.                                              |
| Training data | “Jev is not trained on customer requests or responses.” ZDR is **enterprise**, via privacy@.                                       |

**Prompt / KV cache:** not present in the HTTP API, Models page, or official JS `Usage` / `SystemOneRequest` types. The parallel-questions cookbook’s cost saving is **not** a provider cache: it is that `state` is paid once per request, so N questions in one call avoid re-sending the document N times.

Published cookbook (https://docs.typesafe.ai/cookbooks/parallel_questions), 13 questions over a ~54k-character GDPR article, `jev-1.12`, 5 repeats:

- Batching **did not change answers** (no sibling-question effect).
- One batched call: **$0.000497 / 0.27s** vs 13 singles **$0.006090 / 2.71s** → **12.2× cheaper, 10.0× faster** in that sequential-sum latency accounting.
- Some Nouls had run-to-run stddev (e.g. `breach_72h` 0.0055); most Choices/Scores were identical across 5 repeats.

Docs inconsistency: primitives.md currently says that same cookbook is “11.5x cheaper and 9.6x faster”; the cookbook page and its table say 12.2× / 10.0×. Treat the cookbook table as the measured write-up.

**Latency claim elsewhere:** how-to-build says “Most queries complete in about 100 ms.” That is not the same workload as the 0.27s document-dominated cookbook run.

**Errors / retries** ([API](https://docs.typesafe.ai/api); JS SDK `src/retry.ts` `v0.6.0`):

| Status | Meaning                |
| ------ | ---------------------- |
| 401    | bad/missing key        |
| 422    | validation             |
| 429    | rate limit             |
| 529    | temporarily overloaded |

SDK defaults: timeout **10_000 ms per attempt** (no total retry budget), `maxRetries: 2`, backoff 500–5000 ms with 0.25 jitter, retry HTTP **408, 429, 500–599** (so **529 is retried**), honor `Retry-After` / `retry-after-ms` up to 60s, retry connection and timeout errors. There is no documented SLA for outage duration.

**Reproducibility:** no seed. How-to-build: “designed to return stable answers across repeated evaluations.” Jaggedness: “extremely consistent” for semantically similar inputs, but structural identities across differently worded questions are **not** guaranteed. Cookbook shows mostly identical repeats with some Noul sampling noise. Aliases (`jev-latest`) can move to a new versioned ID; pin `jev-1.13.0` if thresholds were tuned against that version.

---

## Facts: Laya vs the “Laya1k / Jev32k” discussion

Pinned in this repo (`.env.example`, `docs/npu.md`, Laya `budget.py`):

- Laya checkpoint `convaiinnovations/laya` revision `1c5edc17a7acd8701df6fc341c0d179f1c62c982`.
- Root **`max_len=512`**, **`head_max_len=192`**. “Do not assume 1k state.”
- The Laya service **rejects** over-budget requests instead of silently slicing state.

Jev current docs: **64k total / 32k state+longest-question**, not a flat 32k window.

This repo’s `JEV_MODEL_CONTEXT_TOKENS = 32_000` therefore under-describes the official split budget. `CLASSIFIER_BRIEF_MAX_CHARS = 24_000` is a character cap, not a Jev tokenizer measurement, and is far larger than Laya’s 512-token sequence.

---

## Facts: current classifier / router seam in this repo

`src/classifier.ts` already follows the **task-assessment** seam:

One `systemOne` (or Laya `/v1/decide`) call with independent questions: `task`, `difficulty`, `effort`, `trivialChat`, `localSufficiency`, `freshFacts`, `expectedLength`. State is `{ brief, localDeployments, source, meta }`. Answers are decoded into `Assessment`; **`selectRoute` in `src/router/select-route.ts` applies KeyPolicy** (allowlist, context/output limits, quality floor from difficulty/effort confidence, cost ceiling on **cold-cache USD**, locality/effort mapping).

Jev path: `CLASSIFIER_ATTEMPT_TIMEOUT_MS = 1_200`, `CLASSIFIER_MAX_RETRIES = 1`, backoff forced to 0, outer `CLASSIFIER_TOTAL_TIMEOUT_MS = 2_500`. Local in-process classification cache TTL 120s / 2048 entries. No TypeSafe prompt cache.

`CLASSIFIER_MODE` is `laya` **or** `jev` with **no automatic fallback** (`docs/operations.md`).

---

## Why a live queue/capacity snapshot in the classifier cannot reserve capacity atomically

This is a systems fact; TypeSafe’s contract makes it worse, not better.

1. **No side effects.** `systemOne` returns typed answers. It does not admit a request, decrement a slot, or pin a session. Skill/how-to-build: execution and side effects stay in code.
2. **Round-trip staleness.** Any occupancy/queue numbers placed in `state` are a **read of the past**. By the time the answer returns, other requests may have taken the slot. The model cannot hold a lock across that gap.
3. **Independent questions cannot coordinate.** Sibling questions cannot see each other, so they cannot jointly pick “the one remaining GPU slot” and exclude a competing option.
4. **Numeric / distractor failure modes.** Jaggedness: Jev is not a calculator; large state full of unrelated operational telemetry is a documented accuracy cost.
5. **Reservation is compare-and-swap, not classification.** Atomic admission is `tryReserve(deploymentId)` (or equivalent) **after** a candidate list exists. Feeding the snapshot into Choice criteria only produces a **stale preference**. Two concurrent requests can both prefer the same “empty” local model.

Therefore: even if Jev ranks candidates, **admission, saturation, affinity, and budgets remain a deterministic control-plane step**. Putting sliders and live load into the rubric does not close the race.

---

## Evidence implications for three seams

**Primary guidance (quoted above):** independent typed questions; code composes answers; keep calculations, lookups, authorization, and side effects in code; Choice over a closed set of handlers/models is a named use case; “changing a weight or display filter need not rerun inference when evidence and question meanings are unchanged.”

**Architecture inference (this section, not a TypeSafe verdict):** three ways this repo could place the Jev/Laya seam. Official docs do not pick among them. The contested part of seam 3 is embedding **live capacity, slider arithmetic, and admission** in the rubric—not the legality of a model-id Choice.

### 1. Task assessment only (current intended model)

Jev/Laya score the **task**: kind, difficulty, effort, length, local-sufficiency, missing facts. Effect policy then applies per-key sliders, constraints, priority, saturation, queue admission, session/cache affinity, budgets.

| Pros                                                                                                               | Cons                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Matches “code owns workflow / keep rules in code / change weights without rerunning inference.”                    | Model never sees the actual candidate IDs, so it cannot express “this prompt is a GLM-class coding job.”            |
| Assessment is cacheable across keys that share the same brief (this repo already keys cache on `keyId` though).    | `localSufficiency` is a Noul against a listed local set; it is not a ranking of cloud vs local under a cost slider. |
| Small, stable question schema (`ASSESSMENT_QUESTION_SCHEMA_VERSION`). Cheap to batch; state can stay a task brief. | Quality/cost targets that differ per key must be applied **after** the model, which is what KeyPolicy already does. |
| Operational facts (RPM, wait, cold-cache USD, saturation) stay exact.                                              | If the assessment is wrong, every downstream policy inherits it.                                                    |
| Aligns with intent-routing example: classify intent+complexity, then code routes.                                  | Does not use the use-case-map bullet “chooses which LLM receives each prompt” as a Choice over catalogue IDs.       |

**COGS:** pay Jev once per distinct brief (plus local TTL cache). Do **not** resend per-key slider text. Best cache preservation of the three seams.

### 2. Constrained candidate ranking (hybrid)

Keep assessment questions **or** replace/augment with per-eligible-deployment Scores/Nouls (or one Choice over **already-filtered** IDs). Code still filters by allowlist/health/context/cost **before** the call, then uses probabilities to rank; code still `tryReserve`.

| Pros                                                                                                                                                                                             | Cons                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choice over a closed set is a first-class primitive (max 255 options). Skill-suggestion cookbook ranks 182 skills in one request, then a **second** request re-reads top-3 with better evidence. | Eligible set is **request-specific** (allowlist, context fit, health). That **destroys shared-state caching** unless you rank a stable universe and filter after.       |
| Official model-routing use case: “chooses which LLM receives each prompt” + “estimate difficulty and risk.”                                                                                      | Putting slider numbers and live load into criteria **forces a rerun whenever policy or occupancy changes**, contradicting “changing a weight need not rerun inference.” |
| Probabilities over candidates are reusable; code can apply different key weights without a second Jev call **if** the question did not embed those weights.                                      | Large catalogue descriptions in `state` or criteria inflate the 32k state+longest-question budget and add distractors (jaggedness).                                     |
| Can keep speculative “is local enough?” Nouls next to a candidate Choice.                                                                                                                        | Still cannot reserve. Ranking ≠ admission.                                                                                                                              |
| `other` / `none of the above` is the documented escape hatch when nothing fits.                                                                                                                  | If code already filtered to one eligible model, the Choice is vacuous.                                                                                                  |

**COGS:** higher than assessment-only whenever candidate lists or policy text are in the request. Batching still shares `state`. No TypeSafe prompt cache to preserve catalogue prefixes.

### 3. Full operational routing (Jev owns the decision)

One Choice (or a broad “best course of action” question) whose criteria include human-readable sliders, live queue/capacity, session affinity, and dollar ceilings; deterministic fallback only on timeout/low confidence.

| Pros                                                                          | Cons                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One round trip, one artifact to log.                                          | **Inference, not a ban on Choice:** packing sliders, live occupancy, affinity, and USD ceilings into one “best route” rubric asks for arithmetic, authorization, and side effects the skill says to keep in code. Jaggedness: not a calculator. |
| Typed Choice over catalogue IDs is valid System One semantics (use-case map). | Broad “analyze and determine the best course of action” is the primitives anti-pattern; a **closed** model-id Choice with stable criteria is not that anti-pattern.                                                                             |
| Rubric can be written in English for operators.                               | Live snapshots cannot atomically reserve (section above). Fallback still needs the control plane.                                                                                                                                               |
|                                                                               | Independent questions cannot enforce “if saturated then other.” Stale occupancy in `state` is a read of the past.                                                                                                                               |
|                                                                               | Lowest cache reuse if sliders and load maps enter `state`/criteria: every key and every tick change the token stream. Highest **external API** COGS of the three.                                                                               |
|                                                                               | Typed output guarantees the interface, not truth. A confident wrong model ID is still executed unless code re-validates allowlist/health/budget—which is seam 1/2.                                                                              |

---

## Analytics implications (facts vs what a seam can feed)

Product requirement (this conversation, 2026-09-20): first-class analytics — time trends and breakdowns by **key + priority + deployment**; cost **reported vs estimated/unknown**; local–cloud share; **observed cached input tokens** vs **classifier exact-cache** vs **session reuse**; policy decision reasons and candidate exclusions; complexity/effort distributions; queue wait / TTFT / decode TPS / latency; error / cancel / saturation counts; metadata request drilldown. Full chat logging and a task-success classifier are **future opt-in**, not collected now. **HTTP success is not task success.** No paid evaluator calls. Privacy: no transcripts.

Shared-owner DTO names (FoundationContracts, `src/domain.ts`, not edited here): `AnalyticsRequestRow` (metadata drilldown; `taskSuccess` always `null` today), `CandidateExclusion`, `SelectionReason`, `AnalyticsBucket`, `AnalyticsSnapshot` (window + `byKeyId` / `byPriority` / `byDeploymentId` / `byTask` / `byEffort` / `bySelectionCode`). `RequestAccounting` unchanged. Unknown costs/tokens stay `null`.

**TypeSafe cannot supply most of those series.** Official `Usage` is `{ input_tokens, output_tokens }` with **no cached-token field**. Jev has no queue, TTFT, decode TPS, reservation, or USD estimate. Complexity/effort exist only if **this gateway asks those questions and stores the answers**. Policy reasons and exclusions exist only if **code** records `selectRoute` denials, not if a single Choice swallows them.

Three **distinct cache counters** must not be collapsed:

| Counter                      | What it is                                                                                                                                                                               | TypeSafe source?                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Classifier exact-cache       | Gateway in-process hit on identical classify key (`CLASSIFICATION_CACHE_TTL_MS`, `reuse: "exact-cache"`)                                                                                 | No. Local to this process.                                              |
| Session reuse                | Pin / continuity reuse of a prior assessment or deployment (`ClassificationReuse` includes `"session"`; classified assessment currently only `"classified" \| "exact-cache"`)            | No.                                                                     |
| Observed cached input tokens | Generation prompt-cache hits on `RequestAccounting.cachedInputTokens` (`llamacpp` default local; `openai-compatible` / `openrouter`; `halogen` optional). Never on TypeSafe/Jev `Usage`. | **Not** Jev. Classifier `Usage` is `input_tokens`+`output_tokens` only. |

Classifier **external token API fee:** Jev input tokens × $0.042/Mtok (output free). Laya has **zero external TypeSafe/token API fee**. Laya **compute / energy / depreciation** is not $0; it is unknown unless an operator configures a local-cost estimate. Separate from generation COGS and from estimated vs reported generation USD.

| Analytics need                                   | Seam 1 assessment-only                                                                                                                                                        | Seam 2 candidate ranking                                                                   | Seam 3 full operational routing                                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `byTask` / `byEffort` / difficulty distributions | Direct: already independent Choice/Noul answers on `Assessment`                                                                                                               | Same if assessment questions are kept; a candidate-only Choice does **not** produce effort | Only if extra questions are still asked; a single “pick model” Choice is not an effort histogram                                                            |
| `SelectionReason` + `CandidateExclusion`         | Natural: code already denies by allowlist/health/context/quality/cost/reasoning                                                                                               | Code still must log filter-before-Jev and post-rank reserve failures                       | If Jev “owns” the pick, exclusions happen inside the model; analytics then has a label without a structured reason unless code re-validates and logs anyway |
| Cost reported vs estimated/unknown               | Classifier usage is reported input tokens; generation estimate stays in `selectRoute` (`pricing === "unknown"` already denies a USD ceiling)                                  | Ranking does not create a TypeSafe USD field                                               | Embedding slider text does not produce estimated USD; still unknown unless code computes it                                                                 |
| Classifier cache hit rate                        | Highest: stable questions + brief-only state (aside from `localDeployments`)                                                                                                  | Falls if eligible IDs/criteria change per request                                          | Worst: sliders + live load in state bust the exact-cache key every tick                                                                                     |
| Local–cloud share                                | Policy after assessment; localityBias remains a **preference**, not a Jev output                                                                                              | Rank can bias; share is still the reserved deployment’s `location`                         | Jev Choice over locations still needs code to record what actually ran                                                                                      |
| Task success                                     | Official confidence ≠ task success. Do not use Jev `confidence` as `taskSuccess`. Future opt-in classifier; `taskSuccess` stays `null` now. No transcripts, no paid Jev eval. | Same                                                                                       | Same                                                                                                                                                        |

Implication for routing (not a decision): the analytics snapshot’s `byTask` / `byEffort` / `bySelectionCode` and `CandidateExclusion` lists are **cheap if the control plane already owns those facts**. Seam 3 makes those series either missing or a second logging path that reimplements seams 1–2.

---

## Contradictions with current implementation assumptions

| Assumption in this repo                                        | Official / inspected fact                                                                                                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JEV_MODEL_CONTEXT_TOKENS = 32_000` as “the” window            | 64k request total **and** 32k for `state` + longest question.                                                                                                         |
| Informal “Laya 1k / Jev 32k” discussion                        | Pinned Laya **512 / head 192**; Jev 64k/32k split.                                                                                                                    |
| `@compootor/effective-jev` as the Jev client                   | Unofficial. Official JS is `@typesafe-ai/sdk`.                                                                                                                        |
| Jev attempt timeout 1.2s, retries=1, backoff 0                 | Official SDK default 10s/attempt, 2 retries, 500–5000 ms backoff, retries 408/429/5xx including 529. Short timeouts are a product choice, not a documented Jev limit. |
| In-process classification cache as if it were a TypeSafe cache | TypeSafe has **no** documented prompt cache; `Usage` has no cached-token field. This cache is local to the gateway.                                                   |
| Passing `localDeployments` in classifier `state`               | Allowed (structured state). Jaggedness warns that irrelevant bulk hurts accuracy; keep only what `localSufficiency` needs.                                            |
| `jevClassify` omits `model`                                    | SDK default `jev-latest` (today `jev-1.13.0`). Aliases can move; pin if thresholds are tuned.                                                                         |
| Confidence stored on difficulty/effort Choices                 | Semantically aligned with official concentration definition. Not P(task success).                                                                                     |
| No silent Jev fallback from Laya                               | Compatible with “code owns workflow”; official docs do not require a cloud fallback.                                                                                  |
| KeyPolicy cold-cache USD ceiling in `selectRoute`              | Correct place for arithmetic. Jev has no estimate or cache-price field.                                                                                               |

---

## Recommendations (architecture inference, not primary docs)

Official docs do **not** decide this repo’s seam. Inferences from the programming model:

1. **Assessment-only best matches “keep rules/weights in code”** when hard constraints are sliders, saturation, affinity, and budgets. Intent-routing’s worked example is this shape: semantic Choice/Score in one call, dispatch in code.
2. **Direct candidate Choice is valid intended use** (use-case map; Choice over ≤255 options; skill-suggestion ranking). Fit **after** deterministic eligibility, with **stable** option descriptions that do **not** embed live load or per-key numeric sliders—so changing a weight need not rerun inference.
3. **If ranking is added, keep KeyPolicy weights in code** so a quality-vs-cost slider change does not bust the Jev cache or require a new rubric.
4. **Do not put live queue/capacity into `state` expecting atomic placement.** Rank, then `tryReserve`, then fall back along the already-ranked list. The issue is stale authorization/capacity, not that choosing a model ID is forbidden.
5. **Do not treat `@compootor/effective-jev` as the official skill or SDK.** If/when integrating, prefer `@typesafe-ai/sdk` contracts inspected above.
6. **Pin `jev-1.13.0`** if confidence thresholds are tuned; log `response.model`.
7. **Keep classifier answers and `selectRoute` denials as first-class analytics fields.** Do not use Jev/Laya `confidence` as task success. Do not pay Jev to score transcripts. Count classifier exact-cache, session reuse, and `RequestAccounting.cachedInputTokens` separately; TypeSafe has no prompt-cache usage field.

---

## Unknowns (not observed in first-party sources)

- Exact tokenizer and how JSON `state` is counted toward the 32k/64k budgets.
- Whether 529 overloaded is distinct from 5xx capacity in practice; duration of overload.
- Per-account rate-limit headroom beyond the public 250k tok/s / 1200 rpm (enterprise only).
- Whether a future Jev version will add prompt caching, seeds, or multimodal state.
- Accuracy of Jev **on this catalogue / coding-agent distribution**. Official docs forbid treating cookbook numbers as universal. No paid calls were made here.
- Whether `jev-1.13` vs the cookbook’s `jev-1.12` changes batching noise.
- Whether TypeSafe will publish the alternative confidence-statistic cookbook promised on the Confidence page.
- Whether a future TypeSafe `Usage` will report cached/prompt-cache tokens (none in `v0.6.0` types).
- Task-success measurement on this traffic (explicitly out of scope now; `taskSuccess` stays null).

---

## Source list

- https://docs.typesafe.ai/agent-skill and `.md`
- https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md (and raw)
- https://docs.typesafe.ai/llms.txt
- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/concepts/system-one
- https://docs.typesafe.ai/concepts/state
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- https://docs.typesafe.ai/concepts/use-case-map
- https://docs.typesafe.ai/primitives
- https://docs.typesafe.ai/primitives/choice
- https://docs.typesafe.ai/primitives/advanced
- https://docs.typesafe.ai/confidence
- https://docs.typesafe.ai/patterns
- https://docs.typesafe.ai/patterns/fan-out
- https://docs.typesafe.ai/patterns/intent-routing
- https://docs.typesafe.ai/patterns/confidence-routing
- https://docs.typesafe.ai/patterns/composite-scoring
- https://docs.typesafe.ai/models
- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/model-jaggedness/jev-1.13
- https://docs.typesafe.ai/cookbooks/parallel_questions
- https://docs.typesafe.ai/cookbooks/skill_suggestion
- https://docs.typesafe.ai/legal
- https://docs.typesafe.ai/sdk/javascript and `TypeSafeClient` / `RetryPolicy` / `Usage` / `SystemOneRequest`
- https://github.com/typesafe-ai/typesafe-sdk-js `v0.6.0` `src/client.ts`, `src/types.ts`, `src/retry.ts`, `README.md`
- This repo: `src/classifier.ts`, `src/domain.ts`, `src/router/select-route.ts`, `services/laya/laya_service/budget.py`, `.env.example`, `docs/npu.md`
