# Batch

Low-priority async chat: submit a job, let it run on idle local hardware first, and — only if it has not dispatched by its spill deadline — let undispatched items fall to the pinned OpenRouter Batch path. Batch is **our own compute spilling to our own OpenRouter account**, never a relayed or resold API (see [ToS posture](#tos-posture)). Domain terms: [../CONTEXT.md](../CONTEXT.md) "Batch". The result-retention exception to the metadata-only rule is [adr/0004](adr/0004_batch_result_holding.md).

Policy authority for locality, priority and hard limits: [routing-policy.md](routing-policy.md). Nothing here weakens the fail-closed classifier qualification gate, key policy, or `maxEstimatedUsd` behaviour.

## Endpoints

Inference `jrv_…` Bearer key; every route is **scoped to the submitting key** — list, status, results and delete are invisible to any other key (an id you do not own answers `404 not_found`, same as an unknown id).

| Route                    | Purpose                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `POST /v1/batches`       | Submit a job (validation, limits, deferred-lane admission)                                   |
| `GET /v1/batches/:id`    | Job status; results inline when `completed` — **retry-safe, reading never destroys results** |
| `GET /v1/batches`        | List your jobs — `limit` 1–100 (default 20), `after` cursor, newest first                    |
| `DELETE /v1/batches/:id` | Cancel undispatched items and purge held results (retrieval acknowledgement)                 |

Error bodies are the repo-wide envelope: `{ "error": { "code": "…", "message": "…" } }` — `401 unauthorized` (missing/bad bearer), `400 invalid`, `404 not_found` (unknown id and other-key id are indistinguishable; there is never a `403`), `409 conflict` (in-flight cap), `500` generic (unexpected server-side failure, e.g. corrupt result store — see [corruption policy](#status-and-results)). Codes, statuses and field names are contractual; exact message wording is not — do not parse it.

### Statuses

Job statuses (nine; terminals are `completed`, `failed`, `expired`, `cancelled`):

| Status        | Meaning                                                                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validating`  | Accepted, items being checked                                                                                                                                                                                                                             |
| `queued`      | Valid, waiting in the deferred lane (**our extension** — see [divergences](#divergences-from-openrouter))                                                                                                                                                 |
| `in_progress` | Items dispatching or executing (local or spilled)                                                                                                                                                                                                         |
| `finalizing`  | All items settled, counts/usage being recorded                                                                                                                                                                                                            |
| `cancelling`  | `DELETE` observed, in-flight items allowed to finish                                                                                                                                                                                                      |
| `completed`   | Terminal: all items settled; results readable until TTL expiry or `DELETE`                                                                                                                                                                                |
| `failed`      | Terminal: the job failed as a whole (`error` explains)                                                                                                                                                                                                    |
| `expired`     | Terminal: the job outlived `deadline_at` (local window + provider window) and never reached another terminal state; never-dispatched items become `expired`, in-flight items are **not** interrupted and the job expires on a later sweep once they drain |
| `cancelled`   | Terminal after `DELETE`; in-flight items were allowed to finish first                                                                                                                                                                                     |

Item statuses: `queued`, `running`, `completed`, `failed`, `cancelled`, `expired`, `interrupted`. Items are never preempted once running — neither `DELETE` nor expiry interrupts an in-flight item. `interrupted` marks work that was `running` when the process stopped: it **may have executed** upstream or locally, and is not resumed automatically — after a crash, never assume all running work continues or re-run it blindly; reconcile from the job's remote groups and item records.

## Submit

`POST /v1/batches` — OpenRouter-shaped inline JSON (no file upload):

```json
{
  "endpoint": "/v1/chat/completions",
  "model": "auto",
  "completion_window": "24h",
  "requests": [
    {
      "custom_id": "digest-1",
      "body": {
        "model": "auto",
        "messages": [{ "role": "user", "content": "Summarize commit abc123" }],
        "max_tokens": 512
      }
    },
    {
      "custom_id": "digest-2",
      "body": {
        "model": "auto",
        "messages": [{ "role": "user", "content": "Summarize commit def456" }],
        "max_tokens": 512
      }
    }
  ]
}
```

Success is `202 Accepted` with the batch object:

```json
{
  "id": "batch_550e8400-e29b-41d4-a716-446655440000",
  "object": "batch",
  "endpoint": "/v1/chat/completions",
  "model": "auto",
  "completion_window": "24h",
  "status": "validating",
  "created_at": 1790044800,
  "finalized_at": null,
  "local_wait_until": 1790048400,
  "deadline_at": 1790134800,
  "request_counts": { "total": 2, "completed": 0, "failed": 0 },
  "usage": null,
  "results": null,
  "error": null
}
```

`id` is `batch_` + uuid. `created_at`/`finalized_at`/`local_wait_until`/`deadline_at` are Unix seconds. `endpoint` is always `/v1/chat/completions` (chat only). `completion_window` is always `"24h"` — the only value upstream accepts, and it is the **provider's** window measured from _upstream_ submission, not from our POST. Two gateway-owned clocks make that explicit:

- **`local_wait_until`** = `spillAt` — the end of the local-first window (see [spill rule](#spill-rule)); before this instant only the explicit hard-ineligibility or opted-in overload exceptions below can leave for the provider.
- **`deadline_at`** = `spillAt + completionWindowMs` (= `spillAt + 24h` for this single window) — our completion deadline for the job: local-first window plus provider window, so wall-clock from our POST can reach **~48 h**. The scheduler never expires a remote attempt at `created_at + 24h` while the provider legitimately still runs inside its own window.

Expiry (`expired` status) is judged against `deadline_at`. Result retention is a **separate** 24 h clock that starts only once the job reaches a terminal status — it is not this deadline and not the provider's 30-day upstream retention.

### Submit validation

Top-level fields: `endpoint` (required, must be `/v1/chat/completions`), `model` (required, non-empty — one uniform model per job), `requests` (required, non-empty array of `{custom_id, body}`), `completion_window` (optional; only `"24h"` accepted). Unknown top-level fields are rejected.

`custom_id` is **job-wide identity**: non-empty, ≤ 128 chars, and unique across **all** items including pre-failed ones. Every identity problem is **job-level** `400 invalid` — a non-object request entry, a missing/non-string/empty/overlong `custom_id`, or a duplicate. So are: unknown/missing top-level field, `endpoint` ≠ chat, missing `model`, `requests` not a non-empty array, more than 1000 items, request payload > 32 MiB, and **all entries invalid**.

Per-item failures — **only** for items with valid identity but an invalid body — are **not** 4xx when at least one item is valid; the entry becomes an item with status `failed` plus an `errorCode`, and a result row (`response: null`, `error: {code, message}`) echoing the caller's valid `custom_id`, already counted in the `202` response's `request_counts.failed`. Exactly six codes exist. `body.model` is optional: absent **inherits** the top-level `model`; present **must equal** it — disagreement is rejected (the correct OpenRouter shape):

| Rule                                           | `error.code` (= item `errorCode`) |
| ---------------------------------------------- | --------------------------------- |
| Non-object `body`                              | `invalid_body`                    |
| Item body > 512 KiB                            | `body_too_large`                  |
| `body.model` present but ≠ the top-level model | `model_mismatch`                  |
| `stream: true` — streaming is out by design    | `stream_unsupported`              |
| `messages` missing or empty                    | `messages_invalid`                |
| `max_tokens < 1`                               | `max_tokens_invalid`              |

The effective model stays uniform because one job is one model; a multi-model fan-out needs one job per model. Top-level `model` accepts `"auto"` (our routed choice — the router picks) or a model slug; **slugs never bypass key allowlists, which are enforced at dispatch**. Exceeding the in-flight-job cap (≥ 4 non-terminal jobs for the key) is `409 conflict` — nothing accepted until an earlier job terminates.

Accepted-work edges — an accepted job is **never reported as `500`**: once create succeeds, **any** post-create persistence failure still returns `202` with the durable batch object showing `"status": "failed"`, a contractual `error.code`, and `request_counts.failed` counting every item — durable record first, reason readable via `GET`. Known codes: `input_store_rejected` (durable input store rejects the bodies — validation/cap/budget/ownership checks are all-or-nothing before any write; a mid-loop I/O failure leaves only fully-written files, never a torn one, and the handler purges that accounted prefix) and `result_rows_rejected` (the result store fails to persist pre-failed error rows after create). The observable invariant on either failure class is: **`202`, `status: "failed"`, store empty** — no partial rows, no orphan inputs; the purge itself is idempotent and file-level only, never touching the ledger. A failed scheduler nudge likewise still returns `202` — acceptance is state, not dispatch.

A submit whose remote outcome is ambiguous (timeout after the POST left the wire) is **never blind-retried and never adopted by list/model/count/time similarity** — the durable submit intent is persisted first, an ambiguous outcome is marked submit-unknown, and reconciliation only ever proceeds from a provider id proven to be ours. An ambiguous submission **may still incur unknown charges**: it requires explicit reconciliation, never an automatic repost, and never claiming someone else's batch.

### Limits (ours — upstream publishes none)

| Limit                            | Value                                       |
| -------------------------------- | ------------------------------------------- |
| Items per job                    | 1000                                        |
| Item body                        | 512 KiB                                     |
| Whole submit / job payload       | 32 MiB                                      |
| In-flight jobs per key           | 4                                           |
| Result holding per job / per key | 64 MiB / 256 MiB                            |
| Completion window `deadline_at`  | `spillAt + 24h` (up to ~48 h from our POST) |
| Result TTL after terminal        | 24 h (separate retention clock)             |
| List `limit`                     | 1–100 (default 20)                          |

All are fixed code constants — no environment knobs (see [setup.md](setup.md#environment)). Job-level overflows (> 1000 items, > 32 MiB) are `400 invalid`; a single oversized item (≤ 512 KiB rule) is a failed item with `body_too_large`, not a job rejection; the in-flight cap is `409 conflict`.

## Status and results

`GET /v1/batches/:id` — mid-flight:

```json
{
  "id": "batch_550e8400-e29b-41d4-a716-446655440000",
  "object": "batch",
  "endpoint": "/v1/chat/completions",
  "model": "auto",
  "completion_window": "24h",
  "status": "in_progress",
  "created_at": 1790044800,
  "finalized_at": null,
  "local_wait_until": 1790048400,
  "deadline_at": 1790134800,
  "request_counts": { "total": 2, "completed": 1, "failed": 0 },
  "usage": null,
  "results": null,
  "error": null
}
```

`request_counts` (`total`, `completed`, `failed`) is the only mid-flight progress signal; partial results are never exposed — `results` is `null` for every status except `completed`. `cancelled`/`expired` items stay in `total` only (OpenRouter parity of the three-field counter).

A `completed` job returns its rows inline on **every** read until they are purged:

```json
{
  "status": "completed",
  "finalized_at": 1790046600,
  "local_wait_until": 1790048400,
  "deadline_at": 1790134800,
  "request_counts": { "total": 2, "completed": 2, "failed": 0 },
  "usage": {
    "prompt_tokens": 1180,
    "completion_tokens": 420,
    "total_tokens": 1600,
    "cost": 0.00042,
    "is_byok": false
  },
  "results": [
    {
      "id": "batch_req_7c9e1a54-1f2b-4c3d-8e5f-6a7b8c9d0e1f",
      "custom_id": "digest-1",
      "response": {
        "status_code": 200,
        "request_id": "gen-550e8400",
        "body": { "id": "gen-550e8400", "object": "chat.completion", "choices": [] }
      },
      "error": null
    },
    {
      "id": "batch_req_0a1b2c3d-4e5f-4a6b-8c7d-9e8f7a6b5c4d",
      "custom_id": "digest-2",
      "response": null,
      "error": { "code": "stream_unsupported", "message": "stream:true is not a batch body" }
    }
  ],
  "error": null
}
```

Row invariant: exactly one of `response` or `error` is non-null (`response` XOR `error`). Invalid-at-validation items surface here as failed rows too — `response: null`, `error: {code, message}` explaining the violation. The batch-level `error` (on a `failed` job) is the same `{code, message}` shape. Parse row `error` fields defensively beyond that shape: upstream's error-row fields are not documented.

**Safety clarification (supersedes earlier consume-once drafts):** a `GET` **never destroys results** — there is no way to know the client received them, so reads are retry-safe and re-readable. Results disappear only when (a) an explicit terminal `DELETE` purges them (that is the retrieval acknowledgement), or (b) the local TTL of 24 h after the job reached a terminal status elapses. The earlier `results_consumed_at` field and consume-once stamping **do not exist** on this surface.

**Corruption policy (propagate):** a corrupt result store fails the completed `GET` with `500` (the standard failure envelope, no new error code; details logged server-side) — the batch record and remaining rows stay intact for **retry after repair**. Corruption deletes nothing: row files stay byte-intact and the ledger is untouched, so a repaired file makes the next `GET` return the full set in original sequence order; writes are atomic (temp + rename), so corruption cannot be client-self-inflicted, and `GET` is the only row reader — the scheduler never reads results, the adapter only appends, and list never inlines them.

## List

`GET /v1/batches?limit=20&after=batch_…` returns your jobs, newest first, without any `results`:

```json
{
  "object": "list",
  "data": [
    {
      "id": "batch_550e8400-e29b-41d4-a716-446655440000",
      "object": "batch",
      "endpoint": "/v1/chat/completions",
      "model": "auto",
      "completion_window": "24h",
      "status": "completed",
      "created_at": 1790044800,
      "finalized_at": 1790046600,
      "local_wait_until": 1790048400,
      "deadline_at": 1790134800,
      "request_counts": { "total": 2, "completed": 2, "failed": 0 },
      "usage": null,
      "results": null,
      "error": null
    }
  ],
  "first_id": "batch_550e8400-e29b-41d4-a716-446655440000",
  "last_id": "batch_550e8400-e29b-41d4-a716-446655440000",
  "has_more": false
}
```

`limit` must be 1–100 (default 20; anything else is `400 invalid`). Pass `last_id` as `after` for the next page while `has_more` is true; an empty `data` ends the cursor walk. List rows always carry `results: null` — listing never reads or touches held results. Listing is key-scoped (OpenRouter's is workspace-scoped).

## Delete

`DELETE /v1/batches/:id` returns `200` with **the batch object itself** (`results` always `null`):

- **Non-terminal job**: queued items → `cancelled` immediately (they never ran, they hold no result); the job → `cancelling`, or straight to `cancelled` + `finalized_at` when nothing is running. **In-flight items are never interrupted** — they run to their natural terminal status while the job drains.
- **Terminal job**: held results are **purged** from the store — this is the operator-facing retrieval acknowledgement and data-deletion path, alongside TTL expiry.
- The job record and its metadata rows in the requests ledger are **retained**, so a later `GET` still returns `200` (OpenRouter would answer `404` — divergence below).
- Repeat deletes of a terminal job are a no-op `200`; unknown/other-key id is `404 not_found`.

Divergence: OpenRouter's `DELETE` is a terminal-only purge — in-flight returns `409`, and it has no cancel route at all. Ours **also cancels locally**; that is deliberate and documented below.

## Deferred lane and spill rule

Batch never competes with interactive work. Concretely:

- Items dispatch **only when the interactive capacity queues (high/medium/low) are empty and a permit is free**. Batch is last in line by construction, not by a priority value.
- At dispatch, an item is an **ordinary routed request**: it admits through KeyService, gets a per-item Assessment (the existing fail-closed qualification gate; the exact classifier cache dedupes identical states), routes deterministically through the ModelRouter, and finalizes into the requests ledger with its `requestId`/`deploymentId`.
- **Once dispatched, non-preemptive**: neither `DELETE`, expiry, nor a higher-priority arrival takes an in-flight item away.
- **On Gufo, items run as `service_tier: "flex"`**: Gufo admits them only when it has idle compute (a free session, no default request queued or prefilling, and fewer than its `--flex-sessions` flex requests running), which Router permits cannot see (direct clients share the runtime). A flex refusal (HTTP 429 `resource_unavailable`) is `CapacityBusy`: the item returns to `queued` and is retried on a later tick, not failed.

### Spill rule

Each job carries a computed spill deadline:

$$\texttt{spillAt} = \texttt{createdAt} + \operatorname{clamp}\big(24\text{h} \times \texttt{localityBias},\ 5\text{min},\ 23\text{h}55\text{m}\big)$$

| `localityBias` (key policy) | Local-only window before spill is allowed |
| --------------------------- | ----------------------------------------- |
| `0` — cloud-preferred       | 5 min (floor)                             |
| `0.5`                       | 12 h                                      |
| `1` — local-until-saturated | 23 h 55 min (ceiling)                     |

- **Before `spillAt`**: local deployments are preferred; only the explicit hard-ineligibility and opted-in overload exceptions below can accelerate remote work. The floor gives ordinary work a local-first window and the ceiling makes every job deadline-spill-eligible inside 24 h.
- **At/after `spillAt`**: _undispatched_ items may route to the pinned OpenRouter Batch path. Spill fans out **one upstream batch per compatibility group** (model + response_format/reasoning config — upstream allows one shape per batch), so a job can carry **several** remote batch ids, one per group; each group's items stay bound to that group's proven id. Already-dispatched items are unaffected.
- **Hard-constraint local ineligibility** (quality, context, allowlist): the item spills **immediately** when a cloud batch candidate remains; if none does, the item fails with `no_eligible_model`. Hard constraints are never relaxed to invent a candidate.
- **Local downtime / definitive pre-enqueue overload**: before `spillAt`, only a Key with `overloadAction=failover` plus a configured spill port may enter remote batch planning. This uses the batch-only catalogue, not synchronous cloud dispatch. All Key/deployment allowlist, capability, context, credentials and spend constraints still pass through the real router planner and deferred key recheck; planning failure never makes a provider call. Report-only local work records the local overload instead of silently paying for cloud. Deadline-triggered spill remains a separate, unchanged batch authorization. A local-to-remote handoff keeps one request/admission and finalizes accounting once.
- **Provider pinning**: the selected deployment’s `providerRestriction` is preserved as upstream `provider.only` — never silently dropped to gain availability. A pin no `:batch` endpoint satisfies fails clearly instead.
- `maxEstimatedUsd` ceilings behave exactly as on interactive traffic: **fail closed on unknown pricing** — unknown price is not a low price.

### Spill deployment

The spill path targets a **dedicated batch-only deployment, separate from the synchronous catalogue** — synchronous chat (Sail FP8) is untouched:

| Field                 | Value                                                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment id         | `cloud-glm-batch`                                                                                                                                                                                                             |
| Model                 | `z-ai/glm-5.3-flash`                                                                                                                                                                                                          |
| `providerRestriction` | `deepinfra/fp4`                                                                                                                                                                                                               |
| Catalogue             | Its own batch catalogue file — `BATCH_CATALOG` names the in-gateway path, bound read-only from the host via `BATCH_CATALOG_FILE` (default `./catalog.batch.example.json`); never inserted into the synchronous chat catalogue |

Endpoint metadata confirmed against the public batch catalogue on **2026-09-22**: input **$0.06/Mtok**, cached input **$0.012/Mtok**, output **$0.20/Mtok**, context **1,048,576**, max output **131,072**. This is **dated catalogue metadata for ranking and `maxEstimatedUsd` math — not performance evidence**; no paid batch benchmark has been run, and the model page remains the pricing source of truth.

**Confirmed-group recovery constraint:** while an upstream group is pending, keep its batch deployment id mapped to the same endpoint and provider pin, and keep the submitting OpenRouter account available. The ledger stores the proven batch id and deployment id, but not the original endpoint/account identity. Reusing that deployment id after a catalogue or credential rotation can poll the wrong context and lose final accounting; drain and reconcile confirmed groups before rotating. Never re-POST an ambiguous or confirmed group to work around a missing poll.

`spillAt` is computed in `src/batch/spill.ts` (pure function, table-tested). The scheduler tick and clamp constants live beside it; there is no environment knob.

## Result holding

Submitting a batch is the **explicit opt-in** to result holding ([adr/0004](adr/0004_batch_result_holding.md), the bounded exception to [adr/0003](adr/0003-metadata-analytics-without-transcripts.md)):

- The store persists **both durable input bodies and result rows** — `BATCH_RESULTS_DIR` overrides it; unset, the wiring derives `dirname(SQLITE_PATH)/batch-content` (Compose: `/var/lib/llm-router/batch-content` on the existing `sqlite-data` volume; native: `./data/batch-content`). The `data/batch-results` constant in `src/batch/results.ts` is only the unwired library fallback for a no-option embedder — production never sees it. **Neither prompts nor completions ever enter `control.sqlite`** (the metadata store stays metadata-only), never Analytics, never joinable from the requests ledger.
- **Per-key access only**: the submitting key retrieves; no other key and no admin surface reads rows.
- **Retry-safe reads**: `GET` returns the rows without destroying them; you can poll until you have them.
- **Retention**: an explicit terminal `DELETE` purges results (retrieval acknowledgement); otherwise the local TTL deletes them **24 h after the job reaches a terminal status**.
- **Budgets**: 64 MiB per job, 256 MiB per key — enforced when writing rows.

Prompts and completions therefore still **never** enter the metadata database or Analytics. Batch content (input bodies and results) touches disk only in this dedicated store — it is opt-in, bounded, per-key, and short-lived.

## Accounting

The accounting identity is unchanged: **unknown ≠ zero, everywhere.**

| Level                                   | What is recorded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per item, **local dispatch**            | Finalizes into the requests ledger like any routed request: observed usage and **actual configured COGS** through the existing accounting — no special case.                                                                                                                                                                                                                                                                                                                                                                                        |
| Per item, **remote (spilled) dispatch** | Finalizes into the requests ledger with tokens parsed **defensively** from the result body's `usage` (per-item usage in upstream chat batch bodies is unconfirmed — absent means unknown, not zero). **Cost is always unknown** for remote rows → `unknownCostCount`. The batch discount is batch-level only; never prorated across rows, never estimated as 0.                                                                                                                                                                                     |
| Per job                                 | `usage` = provider-reported actual: `{prompt_tokens, completion_tokens, total_tokens, cost, is_byok}` with `cost`/`is_byok` nullable — recorded only when a spill actually happened, and **aggregated once per remote group from its stored terminal facts** (a status poll never re-adds spend). `cost` is what the provider charges for the whole batch; `is_byok: true` means that `cost` covers only the BYOK/platform fee — attribute accordingly. Missing or partially reported usage makes the whole `usage` null rather than a partial sum. |

Batch pricing is typically a discount on per-token rates, but the page/model price is the source of truth; job-level `cost` is the only batch-spend figure this system asserts.

## Divergences from OpenRouter

| Topic                        | OpenRouter                                                                                                                                                     | Ours                                                                                                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cancel semantics             | `cancelling`/`cancelled` exist but **no cancel endpoint is documented**; `DELETE` is a terminal-only purge (in-flight → `409`, "deletion is not cancellation") | `DELETE` **also cancels**: undispatched → `cancelled`, in-flight finish, results purged — deliberate, documented divergence                                                                                                                   |
| Result retention             | Inputs + results kept **30 days** upstream, then deleted; `DELETE` purges provider-side                                                                        | Retry-safe reads like upstream, but the held copy is local only: terminal `DELETE` purges (retrieval acknowledgement), otherwise our local TTL of 24 h after terminal; job metadata retained. Upstream's own 30-day clock is theirs, not ours |
| After-delete visibility      | Later `GET`/`DELETE` → `404` once cleaned up                                                                                                                   | Job record retained: later `GET` returns `200` (results purged), repeat `DELETE` is a no-op `200`                                                                                                                                             |
| Duplicate / ambiguous submit | **No idempotency key** — duplicate submits undetectable from the API                                                                                           | Same absence, handled our way: durable submit intent persisted first; an ambiguous outcome is marked submit-unknown and reconciled only from a provider id proven to be ours — never attributed by list/model/count/time similarity           |
| Webhooks                     | **None upstream** — completion is poll-only                                                                                                                    | Same: poll `GET /:id`; no webhooks                                                                                                                                                                                                            |
| Status vocabulary            | Eight states, no queued wait state                                                                                                                             | We add `queued` for the deferred lane (nine job statuses); items also gain `interrupted` for work possibly executed when the process stopped                                                                                                  |
| Scope                        | Workspace-scoped — every workspace key sees the same list                                                                                                      | **Key-scoped**: only the submitting key sees its jobs and results                                                                                                                                                                             |
| Limits                       | None published (no items/payload cap documented)                                                                                                               | Our published table above (1000 / 512 KiB / 32 MiB / 4 in-flight)                                                                                                                                                                             |
| Provider routing             | `provider.only` accepted; wrong pin → `404`, no fallback                                                                                                       | Same mapping — deployment `providerRestriction` becomes `provider.only`, unsupported pins fail clearly, never silently omitted                                                                                                                |

Upstream facts and open questions behind this table: [research/openrouter-batch.md](research/openrouter-batch.md).

## ToS posture

Batch is **our own compute spilling to our own OpenRouter account** — usage we consume, not access we resell.

- Presenting OpenRouter batch as relayed/resold API access sits at [OpenRouter ToS §7](https://openrouter.ai/terms) ("reselling API access to Models or otherwise developing a competing service") — **the binding constraint on this seam**.
- No UI, endpoint copy, or response wording may present batch as resold or relayed OpenRouter access. Clients submit to _our_ batch surface with _our_ keys; they never see, hold, or are billed against OpenRouter credentials.
- Because end users do not touch OpenRouter directly, §5.2 flow-down is not engaged by this path; §6.3(b) is the provider's storage basis for our own submissions upstream.

This is a documented legal reading of the ToS, flagged for humans. It is **not** a legal permission grant: describing batch as our own compute does not make any resale or relay lawful. A commercial relay offering would require terms review and provider permission first — the internal-use posture is exactly that, an internal-use posture.
