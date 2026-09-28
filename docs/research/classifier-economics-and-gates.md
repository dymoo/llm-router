# Classifier economics and gates: assumptions re-audit

**Date:** 2026-09-22
**Scope:** Re-audit of Classifier assumptions against official TypeSafe docs and this repo's recorded evidence, to give future gate calibration a citable fact base. Context7 (`/websites/typesafe_ai`) queried first, then official pages read directly. No paid TypeSafe calls; no Laya/AMD execution; no new measurements of any kind. Verified primary-source facts, recorded repo evidence, inferences, recommendations, and unknowns are separated below; every numeric claim carries its source. Sibling batches were landing concurrently during this audit — line numbers below are as observed on 2026-09-22, and volatile files are cited by exact symbol/section instead.

---

## Verified primary-source facts (official docs, read 2026-09-22)

### Jev pricing and usage identity

| Fact | Source |
| --- | --- |
| `jev-1.13.0` price: **\$42 per Btok / \$0.042 per Mtok**, "Charged per input token. Output tokens are free." | [docs.typesafe.ai/models](https://docs.typesafe.ai/models), read 2026-09-22 |
| The models page prints **no as-of date** for the rate; our as-of is the read date. The prior repo audit read the same rate on 2026-09-20 (`docs/research/jev-routing.md:147`). | models page; `docs/research/jev-routing.md:147` |
| Official cookbook pins the same rate as a constant: `TYPESAFE_PRICE = (0.042, 0.00)` — "\$ per 1M tokens (input, output); ... Historical TypeSafe rate, as of 2026-08". | [consistency_choice_cookbook](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook), via Context7, 2026-09-22 |
| Response `usage` is exactly two fields: `input_tokens` and `output_tokens` — **no cache/prompt-cache fields**. Example: `"usage": { "input_tokens": 296, "output_tokens": 20 }`. | [docs.typesafe.ai/api](https://docs.typesafe.ai/api), read 2026-09-22 |
| `output_tokens` is returned and non-zero even though output billing is free (Choice example: `588` in / `212` out). | [docs.typesafe.ai/primitives/choice](https://docs.typesafe.ai/primitives/choice), via Context7, 2026-09-22 |
| Aliases: `jev-latest` and `jev-preview` both currently resolve to `jev-1.13.0`; "An alias moves when a new release ships". | models page, read 2026-09-22 |
| Output-freeness is **model-version-scoped**: an official cookbook prices `jev-1.12` at "\$0.10 / \$0.30 (flat)" per 1M input/output, "prices ... as of 2026-07". | [sde_cascade cookbook](https://docs.typesafe.ai/cookbooks/sde_cascade), via Context7, 2026-09-22 |

### Confidence semantics

| Fact | Source |
| --- | --- |
| `confidence` is "a statistic computed from the probability distribution the answer already gives you"; it "collapses that shape into a single number". Noul answers carry none. | [docs.typesafe.ai/confidence](https://docs.typesafe.ai/confidence), read 2026-09-22 |
| It is distribution concentration, **not** task success: "Choice/Score confidence summarizes distribution concentration, not overall workflow correctness or permission to act." (official skill) | [docs.typesafe.ai/agent-skill](https://docs.typesafe.ai/agent-skill), quoted at `docs/research/jev-routing.md:41` (read 2026-09-20) |
| Official threshold guidance: "The correct threshold values depend on your domain and the performance of the model for your use case. Start with conservative thresholds, **test with your own data**, and adjust as you observe results." | confidence page, read 2026-09-22 |

### Cross-check: our old hardcoded `0.042` / `jev-1.13.0` assumption

Audit baseline (as observed 2026-09-22): the Analytics SQL computes `classifierEstimatedUsd` as `classifier_input_tokens * 0.042 / 1000000.0` only when `classifier_backend = 'jev' AND classifier_reuse = 'classified' AND classifier_model_revision = 'jev-1.13.0'` (`src/keys/analytics.ts:29-30`); `JEV_MODEL_ID = "jev-1.13.0"` (`src/domain.ts`, symbol `JEV_MODEL_ID`); default `TYPESAFE_MODEL=jev-1.13.0` (`.env.example:42`).

| Repo assumption | Primary source | Verdict |
| --- | --- | --- |
| \$0.042/Mtok input | models: \$42/Btok = \$0.042/Mtok input | **Matches** the published rate for `jev-1.13.0` on 2026-09-22. |
| Output cost contributes nothing | models: "Output tokens are free" | **Matches for this revision only** — `jev-1.12` was priced with a \$0.30/Mtok output term (cookbook, as of 2026-07), so output-freeness must never be assumed beyond a sourced, revision-keyed rate. |
| Rate keyed to literal `'jev-1.13.0'` | Alias table (`jev-latest` moves) | **Sound shape**: revision-keyed pricing is correct. But the literal SQL carries no provenance/as-of, and rows recorded under any *other* revision contribute `NULL` to the sum — silently unpriced rather than counted unknown. The encoded fix is `ClassifierRates` + `classifierCostUnknownCount` (`src/domain.ts`, symbols `ClassifierRates` / `AnalyticsBucket`); `docs/operations.md` ("Classifier qualification" section) states "The previously hardcoded Jev rate in Analytics is gone; rates come from the qualification record with their provenance" — reconcile at integration; that batch was in flight while this audit ran, and the SQL literal above was still present when this audit read it. |
| Usage = `{input_tokens, output_tokens}` | API reference: exactly those two fields | **Matches** `ClassifierUsage` (`src/domain.ts:448-451`); there are no cache fields to persist or fake. |

---

## Recorded repo evidence (no new measurements)

### Laya quality failures — what was measured vs. inferred

Source: `docs/research/laya-routing-validation.md`, dated 2026-09-20 — real CPU execution (`laya==0.3.4`, pinned revision `1c5edc17a7acd8701df6fc341c0d179f1c62c982`, float32, max length 512 / head budget 192), explicitly "**diagnostic examples, not a routing benchmark**" (line 3).

**Measured (single-case observations; numbers only where the doc records them):**

| Arm | Recorded outcome |
| --- | --- |
| Production-container protocol smoke, synthetic prompt "Write a TypeScript function that adds two numbers.", gateway task-and-deployment metadata state | `task` → **`chat`** (probability not recorded); local sufficiency **below the 0.8 admission threshold** (value not recorded); gateway rejected a local-only catalogue with **`no_eligible_model`**, recording assessment + exclusion (line 13). |
| Same smoke, a greeting | Also **failed the local-sufficiency gate** (line 13; no value recorded). |
| Diagnostic: task text alone (no local catalogue supplied) | `task` = `coding`, probability **0.9563**, entropy confidence **0.8861**; but `trivialChat` = **0.8451** and local sufficiency = **0.3137** (line 19). |
| Diagnostic: structured task plus local deployment | `task` → **`chat`**; "Metadata materially changed the answer" (line 20). |
| Diagnostic: plain labelled task and deployment sections | `task` → **`extraction`**; "Formatting alone did not establish a reliable fix" (line 21). |
| Software behaviour | Loads healthy, tokenizer-aware limits, typed answers, measured input usage, exact assessment reuse; over-budget returns explicit rejection; gateway does not silently switch to Jev (line 7). |

**Not measured / not recorded (must not be cited as if measured):**

- **No `difficulty` answers were recorded anywhere in the validation doc** — grep for "difficulty" matches zero lines. Whether difficulty was misclassified is unknown; only `task` (and the `trivialChat`/`localSufficiency` values above) carry recorded values.
- **No false-positive `localSufficiency` observation exists in the recorded evidence.** Both recorded local-sufficiency outcomes were *below* threshold (denials). With `localSufficiency` as the Noul "Would even the least capable of the listed local deployments be adequate to complete this task well?" (`src/classifier.ts:36-74`, `assessmentQuestions`), the greeting denial is a **false-negative**-direction error against obvious ground truth; the `0.3137` arm had **no local catalogue supplied**, so its interpretation is confounded (no-catalogue fact recorded at line 19; "confounded" is inference). False-*positive* local-sufficiency rates are explicitly **open measurement work**, not evidence: issue [#1](https://github.com/dymoo/llm-router/issues/1) ("particularly false-positive local-sufficiency decisions").
- No counts, denominators, rates, or repeats — hence **no error rate or false-positive rate can be derived** from this doc. No effort / freshFacts / expectedLength values, no Jev comparison, and "no paid Jev classification has been run here" (line 29).
- The tests (`test/classifier.test.ts`: "exact classification cache reuses the first Laya result without healthz", "malformed Laya answers fail closed", "a mismatched pinned Laya revision fails…", "real Jev SDK preserves pinned model, usage and semantic answers over HTTP", readiness fails closed) verify **protocol and accounting plumbing against synthetic fixtures** — the validation doc states such fixtures "do not count as evidence of classifier or generator quality" (line 31).

### Accounting identity as encoded

1. **Reuse = real zero.** `classifierCostUsd(reuse, inputTokens, rates)` (`src/domain.ts`, symbol) returns `{ _tag: "zero", usd: 0 }` whenever `reuse !== "classified"` — correct because an exact-cache hit makes no backend call: the cached result carries `usage: { input_tokens: 0, output_tokens: 0 }` (`src/classifier.ts`, exact-cache return), the hit path skips the health probe (`test/classifier.test.ts`, "exact classification cache reuses the first Laya result without healthz"), and persistence stores `classifierInputTokens: 0` for non-fresh reuse (`src/router/model-router.ts:791`, `server/runtime.ts:84-87`). Session reuse likewise makes no new classifier call (`docs/operations.md`, "Accounting and analytics" section: "Exact-cache and session reuse incur no new classifier call").
2. **Unknown ≠ zero.** Missing rates, missing token counts, or a non-zero output rate return `{ _tag: "unknown" }`, never 0 (`classifierCostUsd` branches), and unknowns are *counted*: `AnalyticsBucket.classifierCostUnknownCount` (`src/domain.ts`, symbol); generation-side analogues `unknownCostCount` / `unknownUsageCount` (`src/keys/analytics.ts`, METRICS symbols); "Price provenance `unknown` yields unknown accounting, not a zero bill" (`docs/operations.md`, "Accounting and analytics" section).
3. **Only input token counts persist → output-billed backends stay unpriceable.** The `requests` table has `classifier_backend`, `classifier_model_revision`, `classifier_source`, `classifier_input_tokens`, `classifier_elapsed_ms`, `classifier_reuse` — and no classifier output-token column (`src/db/schema.ts:62-67`). `classifierCostUsd` refuses to price any rate set with `outputUsdPerMillion !== 0` (doc comment: "Only input tokens are persisted, so a backend with a non-zero output rate cannot be priced from input counts alone"): such a backend is *unknown*, not zero. Laya conforms today — its response schema pins `output_tokens: 0` (`src/domain.ts:456-459`) — while its external token fee is zero and its compute/energy cost is operator-unknown (`docs/research/jev-routing.md:291`).
4. **Aggregate-time pricing from sourced rates.** Rates live on the qualification record as `ClassifierRates` with provenance `EstimateProvenance { unit, source, asOf }` (`src/domain.ts`, symbols); `docs/operations.md` ("Classifier qualification" section): "rates come from the qualification record with their provenance". Dollar values are computed when aggregates are read, never stored per row.
5. **Selection stays explicit and cost-safe.** `CLASSIFIER_MODE` is `laya` or `jev` with no automatic paid fallback (`docs/routing-policy.md`, "Classification" section; `.env.example:36`); `localSufficiency < LOCAL_SUFFICIENCY_THRESHOLD` (0.8, `src/domain.ts`, symbol) denies local candidates (`src/router/select-route.ts:291-297`) and forces cloud spill on high locality bias (`src/router/locality.ts:36-37`).

### Gate identity (as wired in this batch)

`server/qualification.ts` (symbol `loadClassifierQualifications`) loads `CLASSIFIER_QUALIFICATION` (unset → `[]`, malformed file throws loudly) and both the readiness path and classifier layer consume it (`server/health.ts` `classifier()`, `server/runtime.ts` `makeInferenceRuntime()`). Per-question identity: `{ backend: CLASSIFIER_MODE (.env.example:36), modelRevision: LAYA_MODEL_REVISION pin (.env.example:56) for Laya / TYPESAFE_MODEL jev-1.13.0 (.env.example:42) for Jev, questionSchemaVersion: ASSESSMENT_QUESTION_SCHEMA_VERSION = "dymoo-assessment-questions/v1" (src/domain.ts, symbol) }`; `requiredQuestionIds` = `Object.keys(assessmentQuestions)` = `task, difficulty, effort, trivialChat, localSufficiency, freshFacts, expectedLength` (`src/classifier.ts:36-74`). With no qualifying record the outcome is `{ _tag: "missing" }` → fail closed, readiness `unqualified` — intended product behavior (`docs/operations.md`, "Classifier qualification" section; `.env.example:37-40`). `evaluateClassifierQualification` re-checks metrics against thresholds per required question and fails `unmeasured` when any required question lacks a metric/threshold pair, `error-rate` when errors exceed `maxErrorRate`, and `false-positive-rate` when a non-null `maxFalsePositiveRate` has `falsePositives: null` or exceeds the bound (`src/domain.ts`, symbol; failure reasons in `ClassifierUnqualified`, `src/errors.ts`, symbol).

---

## Inferences (reasoned from the above, not measured or documented upstream)

- **Why per-question threshold *shape* differs.** For the Noul `localSufficiency`, a false positive ("local is adequate" when it is not) routes production traffic to an inadequate local deployment — a quality incident; a false negative merely denies local admission (cloud cost, or `no_eligible_model` under a local-only catalogue, as the recorded greeting case shows). The recorded Laya errors were denials plus a `task` misclassification, but the *cost asymmetry* is what the threshold shape must defend: `localSufficiency` (and `trivialChat`, whose recorded 0.8451 on a coding prompt is a trivial-chat false positive against obvious ground truth) need a **strict non-null `maxFalsePositiveRate`**, not just `maxErrorRate`, which mixes both error directions. Encoding consequence: a non-null `maxFalsePositiveRate` with `falsePositives: null` fails `false-positive-rate` (see `evaluateClassifierQualification` above), so requiring the bound *forces* calibration to record false-positive counts — fail closed if unmeasured.
- **Task/difficulty/effort/expectedLength** are closed-set Choices where the operational cost is a wrong label → `maxErrorRate` is the natural bound; `difficulty` in particular has **no recorded evidence at all** and must be measured before any threshold is set.
- The Laya failures are state-formatting-sensitive (three different `task` answers across three state forms, lines 19–21), so a qualification record is only meaningful for a **pinned revision + pinned question schema + a described state-assembly method** — exactly the identity the gate keys on.
- Confidence thresholds should be gated per question as the official docs advise (test with your own data), never borrowed across backends: "Matching the HTTP schema does not establish equivalent calibration or justify reusing hosted Jev thresholds" (issue #1).

---

## Recommendations

### Illustrative qualification record — NOT evidence

The block below shows the *shape* a citable record should have, not a measurement or a selected operating policy. Every string that would claim measurement or provenance carries `REPLACE_`, which `qualificationIsPlaceholder` rejects (`src/domain.ts`, symbol; `isPlaceholderValue` = contains `REPLACE_`). Count and threshold placeholders are **strings** solely so this JSONC snippet cannot be pasted as a loadable record; the live schema requires numeric counts (`cases` positive, other counts non-negative) and numeric bounds. The `fail` verdict remains until real labelled evidence and operator-chosen bounds justify a pass. The `rates` values are the only real numbers shown, and they are published pricing facts, not quality measurements or thresholds.

```jsonc
{
  "backend": "jev",                              // or "laya"
  "modelRevision": "jev-1.13.0",                 // Laya: the pinned 1c5edc17… revision
  "questionSchemaVersion": "dymoo-assessment-questions/v1",
  "calibration": {
    "evaluationSet": {
      "id": "REPLACE_EVAL_SET_ID",
      "cases": "REPLACE_MEASURED_CASE_COUNT",
      "labelsSource": "REPLACE_HOW_GROUND_TRUTH_WAS_LABELLED",
      "asOf": "REPLACE_EVAL_SET_ASOF_DATE"
    },
    "measuredAt": "REPLACE_MEASUREMENT_DATE",
    "method": "REPLACE_RUN_DESCRIPTION_STATE_FORMS_REPETITIONS_HARDWARE",
    "metrics": {                                  // per required question; measured counts
      "task":            { "cases": "REPLACE_N", "negativeCases": null, "errors": "REPLACE_N", "falsePositives": null },
      "difficulty":      { "cases": "REPLACE_N", "negativeCases": null, "errors": "REPLACE_N", "falsePositives": null },
      "effort":          { "cases": "REPLACE_N", "negativeCases": null, "errors": "REPLACE_N", "falsePositives": null },
      "trivialChat":     { "cases": "REPLACE_N", "negativeCases": "REPLACE_LABELLED_NEGATIVE_N", "errors": "REPLACE_N", "falsePositives": "REPLACE_FP_N" },
      "localSufficiency":{ "cases": "REPLACE_N", "negativeCases": "REPLACE_LABELLED_NEGATIVE_N", "errors": "REPLACE_N", "falsePositives": "REPLACE_FP_N" },
      "freshFacts":      { "cases": "REPLACE_N", "negativeCases": "REPLACE_LABELLED_NEGATIVE_N", "errors": "REPLACE_N", "falsePositives": "REPLACE_FP_N" },
      "expectedLength":  { "cases": "REPLACE_N", "negativeCases": null, "errors": "REPLACE_N", "falsePositives": null }
    },
    "thresholds": {                               // policy, chosen after measurement — not facts
      "task":            { "maxErrorRate": "REPLACE_POLICY_MAX_ERROR_RATE", "maxFalsePositiveRate": null },
      "difficulty":      { "maxErrorRate": "REPLACE_POLICY_MAX_ERROR_RATE", "maxFalsePositiveRate": null },
      "effort":          { "maxErrorRate": "REPLACE_POLICY_MAX_ERROR_RATE", "maxFalsePositiveRate": null },
      "trivialChat":     { "maxErrorRate": "REPLACE_POLICY_MAX_ERROR_RATE", "maxFalsePositiveRate": "REPLACE_STRICT_MAX_FPR" },
      "localSufficiency":{ "maxErrorRate": "REPLACE_POLICY_MAX_ERROR_RATE", "maxFalsePositiveRate": "REPLACE_STRICT_MAX_FPR" },
      "freshFacts":      { "maxErrorRate": "REPLACE_POLICY_MAX_ERROR_RATE", "maxFalsePositiveRate": "REPLACE_POLICY_MAX_FPR" },
      "expectedLength":  { "maxErrorRate": "REPLACE_POLICY_MAX_ERROR_RATE", "maxFalsePositiveRate": null }
    },
    "verdict": "fail"
  },
  "rates": {
    "inputUsdPerMillion": 0.042,
    "outputUsdPerMillion": 0,
    "provenance": {
      "unit": "USD per 1M tokens (input; output billed at 0)",
      "source": "https://docs.typesafe.ai/models",
      "asOf": "2026-09-22"
    }
  }
}
```

Shape rationale (inference, see above): `cases` counts the labelled cases for each question; `errors / cases` measures total error rate. For every non-null `maxFalsePositiveRate`, record `negativeCases` as the number of labelled negative opportunities for that question (**greater than zero**, at most `cases`), and `falsePositives` as the incorrectly positive answers among them (at most `negativeCases` and `errors`); measured FPR is `falsePositives / negativeCases`, **not** `falsePositives / cases` or `falsePositives / errors`. `maxErrorRate` and `maxFalsePositiveRate` are independently chosen policy limits, not observed rates: select and justify them from the intended operational risk after measurement, and never infer a zero FPR from zero negative cases. Non-null FPR bounds defend costly over-positive answers (`localSufficiency`, `trivialChat`; `freshFacts` bounds unnecessary escalation cost); pure-label questions leave that bound `null`. The published Jev rates are shown sourced and dated because they are primary-source facts; a Laya record should carry `null` rates (unknown compute) or an operator-configured local cost with its own provenance — never \$0.042: "Local classification must not acquire the hosted Jev price just because it uses the same wire protocol" (issue [#1 comment](https://github.com/dymoo/llm-router/issues/1#issuecomment-5759380081)).

### Open work needed to produce real calibration evidence

Tracked in issue [#1](https://github.com/dymoo/llm-router/issues/1) (open as of 2026-09-22): "a single labelled routing evaluation set covering all seven questions"; "Measure calibration, option-order/prompt sensitivity and precision/backend changes, particularly false-positive local-sufficiency decisions"; AMD Strix Halo execution remains blocked on hardware access; "Matching the HTTP schema does not establish equivalent calibration or justify reusing hosted Jev thresholds". Until such a run fills a record, Assessment use stays refused and readiness reports `unready` — that fail-closed outcome is the approved product behavior, not a bug to soften. No benchmarks are claimed here; Laya/AMD execution was out of scope for this stretch.

---

## Unknowns

- The false-positive rate of `localSufficiency` (and of every other question) on any backend — no labelled set exists.
- Whether `difficulty` was ever wrong in the recorded Laya runs — no values were recorded.
- Whether the Laya task failures are state-formatting artifacts, checkpoint calibration limits, or both — three state forms produced three answers, but no labelled sweep separated the causes.
- How long the published \$0.042 rate holds: the models page prints no as-of date, and aliases move; re-verify before trusting `provenance.asOf` past the read date.
- Whether TypeSafe will add prompt-cache fields to `Usage` (none in the API reference or official SDK types inspected 2026-09-20) or reintroduce output billing on a future revision (as `jev-1.12` had).
- Operator local-compute COGS for Laya classification (energy, depreciation) — unknown unless configured.
- Ground-truth label source and inter-rater agreement for the future evaluation set.

---

## Sources

- https://docs.typesafe.ai/models (read 2026-09-22)
- https://docs.typesafe.ai/api (read 2026-09-22)
- https://docs.typesafe.ai/confidence (read 2026-09-22)
- https://docs.typesafe.ai/primitives/choice, https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook, https://docs.typesafe.ai/cookbooks/sde_cascade (retrieved via Context7 `/websites/typesafe_ai`, 2026-09-22)
- https://docs.typesafe.ai/agent-skill (quoted at `docs/research/jev-routing.md:41`, read 2026-09-20)
- Repo: `docs/research/laya-routing-validation.md` (2026-09-20), `docs/research/jev-routing.md` (2026-09-20), `docs/operations.md`, `docs/routing-policy.md`, `.env.example`, `src/domain.ts`, `src/errors.ts`, `src/classifier.ts`, `src/db/schema.ts`, `src/keys/analytics.ts`, `src/router/select-route.ts`, `src/router/locality.ts`, `src/router/model-router.ts`, `server/qualification.ts`, `server/health.ts`, `server/runtime.ts`, `test/classifier.test.ts`
- Issue: https://github.com/dymoo/llm-router/issues/1
