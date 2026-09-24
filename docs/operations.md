# Operations

## Topology and process ownership

Run **one gateway process** with local SQLite. Session pins, model permits and priority queues are process-local. Do not run replicas, PM2 clusters, serverless ephemeral disks or NFS SQLite and expect shared capacity/session correctness.

The gateway's resource registry is process-owned so Next instrumentation and route bundles share admission leases, capacity pools, session routing, health state and disposal. A production HTTP regression holds a generation open while SIGTERM arrives, rejects new work, and checks that the admitted response and SQLite finalization complete before exit. Restart the process after server-code or catalogue changes rather than hot-swapping live ownership.

Compose always provides `gateway` and CPU `laya`; choose either `llamacpp` or `halogen` as the GPU profile, or run optimized native llama.cpp through `host.docker.internal`. Optional profiles are `npu` (FastFlowLM) and `webui`. Only gateway and WebUI publish ports, both loopback by default. See [runtime selection](runtime-selection.md) before changing engines.

## Storage and privacy

| Volume | Contents |
| --- | --- |
| `sqlite-data` | Keys, policy versions, admission leases, metadata usage and audit; opt-in batch inputs/results in a separate private content store |
| `laya-cache` | Local classifier weights and optional ONNX artifacts |
| `fastflowlm-models` | Optional NPU model downloads |
| `webui-data` | Open WebUI conversations and document state — separate from gateway metadata |
| `LLAMACPP_MODELS_DIR` bind | GGUF weights and SSD-backed PLE table |
| `HALOGEN_MODELS_DIR`, `HALOGEN_CACHE_DIR_HOST` binds | HGN weights/quality overlay and sensitive derived prompt-cache state |

Catalogues are read-only bind mounts. Secrets live in private `.env` files, not images or the repository. Keep `API_KEY_PEPPER` stable: changing it invalidates stored key authentication. Ordinary inference stores request metadata, not prompts/completions; submitting a batch explicitly stores its inputs and results in a bounded private store beside `control.sqlite`, outside Analytics, until acknowledgement or the 24 h post-terminal TTL ([batch.md](batch.md#result-holding)). Open WebUI stores conversations by design. FastFlowLM v1.0.6 prints inputs/transcripts, so the supplied profile disables Docker log persistence.

Request metadata retention is 30 days; audit retention is 90 days. Maintenance runs on repository activity. These defaults are not a compliance policy.

## Backup and restore

Do not copy only a live SQLite main file while ignoring its WAL.

```bash
node scripts/backup.mjs --compose
node scripts/restore.mjs --compose --replace ./data/backups/control-….sqlite
docker compose up -d --no-deps gateway
```

Native backup uses `SQLITE_PATH=... node scripts/backup.mjs`. Preserve the matching pepper separately. Test restores on an isolated copy before replacing a live database. Both scripts validate against the same `migrations/` directory that `src/db/migrate.ts` consumes (currently v5, the batch ledger): the control-plane identity must match, `settings.schema_version` must equal `PRAGMA user_version`, and the version must sit inside the supported range. Identified older schemas (v1–v4) are accepted and upgraded in a locked transaction on the next gateway start, preserving existing keys; foreign, corrupt, inconsistent or newer-than-supported databases are refused, not guessed.

Native restore requires stopping the gateway and passing `--replace --offline`. Restore validates the source, stages a private complete snapshot, retains the previous database, and replaces the destination only after verification. Compose restore uses an actual helper container mounted on the gateway volume; a failed copy is an error, never a success message. Backup refuses to overwrite an existing destination.

Before upgrading an existing identified control-plane database, gateway startup automatically makes a WAL-aware, verified copy in `dirname(SQLITE_PATH)/backups/control-pre-v<target>-<UTC timestamp>.sqlite` (directory mode `0700`, file mode `0600`). It keeps the five newest automatic copies for that target version without touching other backups; if the copy cannot be created or verified, startup refuses the migration and leaves the old schema intact. Fresh and already-current databases do not get a pre-migration copy.

Restore quarantines batch state; an ordinary restart does not. On a normal restart the ledger leaves never-dispatched queued items untouched, interrupts only locally in-flight running work, and re-polls confirmed remote groups by their proven upstream ids — durable inputs keep queued work recoverable. A restore is a different safety case: a snapshot cannot prove that a queued or locally-running item was not executed after the snapshot was taken. Before the staged copy replaces the destination, restore terminalizes pending batch items with the explicit `restore_review_required` outcome, finalizes the running request rows linked to those items as `abandoned` (spend metadata preserved — deferred remote requests skip ordinary lease recovery and would otherwise stay running forever), marks unconfirmed submit intents `unknown` (no new POST is ever derived from them), and closes non-terminal jobs that own no pending confirmed remote — jobs still holding an unharvested confirmed remote stay nonterminal, and their running items and linked requests stay running, so the proven id can re-poll and finish normally. The original backup file is never modified; quarantined rows need review before the restored database is used.

Batch content is backed up separately, or not at all. `backup.mjs` copies only `control.sqlite`: the sensitive content store (request bodies and result rows under `dirname(SQLITE_PATH)/batch-content`, or `BATCH_RESULTS_DIR`) lives outside the database, is bounded by the 24-hour post-terminal TTL and the per-job/per-key budgets, and is never silently added to metadata backups. To keep it deliberately, copy the directory separately with its own retention — ad-hoc copies must not outlive the TTL bounds that keep this store short-lived.

Pins do not survive a restart or restore. Clients must start a new task or declare a checkpoint. Abandoned leases recover through the normal repository maintenance/admission path.

## Automatic redeploys

After `ci` succeeds for a push to `main`, `deploy-k3s` checks out that exact commit, builds the linux/amd64 gateway image, audits every saved image layer for environment files, SQLite files and private data, and pushes `ghcr.io/dymoo/llm-router:<full source SHA>`. It records the **pushed digest**, not the mutable tag, in the infra overlay. The workflow also accepts `workflow_dispatch` with a required full `sha` and `allow_migration` (default `false`). Only successful push-triggered CI runs auto-deploy; PR CI does not. Deployments serialize rather than cancel each other.

The deployer reads `# source-commit: <full 40-character SHA>` from `dymoo/dylans-infra/k8s/apps/llm-router/kustomization.yaml`. If that commit is missing or unknown, or `git diff --name-only PREV..SHA -- migrations/ src/db/` has changes, it treats the release as a **possible forward-only migration**. The automatic run stops and tells the operator to dispatch `deploy-k3s` manually with the exact `sha` and `allow_migration=true`. On startup the new gateway takes its own verified pre-migration copy (see Backup and restore) and refuses to migrate if that copy fails; an extra operator backup beforehand is still recommended. Preserve the matching `API_KEY_PEPPER` outside the image. An older binary refuses a newer schema, so never roll it back onto a migrated database. On rollout failure without a migration, the workflow runs `kubectl rollout undo`, reverts its infra write-back commit and pushes that revert, then fails. Aft…

Deployment restarts the single gateway process. `Recreate` drains the old pod (up to the 780-second termination grace period); active or locally running work may be interrupted and clients should retry or resume from a checkpoint. Never treat a restart as a restored snapshot: queued/recoverable batch work follows the normal restart behavior above. Secrets are **not synced** from the router repository or the image; provision and rotate runtime Kubernetes Secrets out of band.

Infra contract for `dymoo/dylans-infra`:

- Namespace `llm-router`, overlay `k8s/apps/llm-router/`; `kustomization.yaml` must contain exactly one `# source-commit: <full SHA>` line and one `images` entry named `ghcr.io/dymoo/llm-router` with exactly one `digest: sha256:<64 lowercase hex>` line. The workflow changes only those two lines, commits `deploy(llm-router): <short SHA>` to infra `main` and applies `infra/k8s/apps/llm-router`.
- A Deployment named `llm-router` with one replica, `Recreate`, `terminationGracePeriodSeconds: 780`, PVC mounted at `/var/lib/llm-router`, and private GHCR image pinned by digest. Runtime secrets remain out of band.
- GitHub App runner scale set label `llm-router-deploy-runners`; repository secrets `GHCR_PAT` (registry push only; checkout uses the default repository access), `DEPLOY_SSH_KEY` (infra `main` write-back) and `KUBECONFIG_B64` (cluster access). The `GHCR_PAT` publisher logs in as `dymoo`, matching the established infra pipeline. `secrets.GITHUB_TOKEN` is empty on these runners. GitHub SSH host key is pinned, with strict verification, not learned at runtime.
- Kubernetes deployer credentials need only the resource verbs required to apply the overlay and to read/watch deployment rollout status and undo the Deployment. They must have **no Secret verbs**; out-of-band administrators own Secret creation and updates.

## Health

- `/health/live`: 200 while the HTTP process is alive. No inference, classifier or provider call.
- `/health/ready`: cached readiness; 200 only when persistence, the selected classifier, and at least one non-optional chat deployment are ready. Otherwise 503.
- `/api/health`: the same detailed snapshot with HTTP 200 for the console, including degraded optional deployments.

Probe rounds are coalesced and cached for five seconds. Runtime HTTP probes have bounded deadlines. The Classifier module owns backend readiness: Laya readiness and uncached classification both require HTTP `200`, `ok: true`, `ready: true`, and a model revision matching the configured pin. The readiness probe has a separate two-second budget that includes reading the response body. Readiness probes do not populate the Assessment exact cache.

llama.cpp uses its root `/health`, not `/v1/health`. Its `/slots` telemetry is the evidence for saturation; gateway permit counts and an absent runtime are not equivalent to saturation.

Cloud health uses non-generating metadata/account endpoints. Jev has no documented free authenticated readiness probe, so its status explicitly says `configuration-only`; it does not claim that a classification call succeeded. NPU model-list reachability establishes service availability, not measured inference quality or hardware performance.

## Classifier qualification

Assessment is gated on the selected Classifier's qualification record (`CLASSIFIER_QUALIFICATION`): measured Calibration per question, a `pass` verdict, and sourced token rates for exactly the selected backend, model revision and question schema. For each question, record `cases` (labelled cases), `errors` (wrong answers), and, whenever `maxFalsePositiveRate` is non-null, `negativeCases` (labelled negative opportunities, greater than zero) and `falsePositives` (incorrect positive answers among those negatives). Total error rate is `errors / cases`; FPR is `falsePositives / negativeCases`, not the fraction of all cases or all errors. `negativeCases` must not exceed `cases`, and `falsePositives` must not exceed `negativeCases` or `errors`. `localSufficiency` and `trivialChat` require non-null FPR bounds. `maxErrorRate` and `maxFalsePositiveRate` are policy thresholds chosen and justified separately from the measured counts, not measured rates or defaults supplied by this repo. The gate re-checks measured metrics against those bounds — a `pass` verdict alone is not evidence — before the exact cache and before any backend call. Without a matching record the Router fails closed: readiness reports `unqualified`, chat returns `503 classifier_unqualified`, and no backend is contacted. `REPLACE_` placeholder records are rejected. See `classifier-qualification.example.json` for the shape; it is deliberately unusable as evidence.

On Compose the record is a host file mounted read-only at `/etc/llm-router/classifier-qualification.json`, selected by `CLASSIFIER_QUALIFICATION_FILE` (a host path consumed by Docker); native deployments set `CLASSIFIER_QUALIFICATION` to a local file path read by the gateway process itself. The JSON shape is identical, the path semantics are not: Compose always reads the pinned container path and ignores any `CLASSIFIER_QUALIFICATION` value in `.env`, so never copy one form into the other environment. The shipped example's single-case counts and zero bounds are synthetic schema-only sentinels, **not** measurements or endorsed policy; its `REPLACE_` source/date fields and `fail` verdict intentionally leave it unqualified. Leaving the default mount in place keeps routing fail-closed while `/health/live` can still report process liveness. Before attempting real qualification, replace all illustrative counts and bounds with a labelled evaluation set, its label source and as-of date, measurement date and method, per-question negative opportunities for every bounded FPR, justified operator-selected limits, and rate provenance. Never treat a test fixture or the shipped example as calibration evidence.

Classifier spend accounting follows the same evidence rules: exact-cache and session reuse are real zero (no call was made), while missing token counts, an unmatched backend or revision, or rates that cannot cover the persisted usage stay unknown and are counted as such. Only input token counts are persisted, so a backend with a non-zero output rate cannot be priced. The previously hardcoded Jev rate in Analytics is gone; rates come from the qualification record with their provenance.

## Drain and upgrades

The production image sets `NEXT_MANUAL_SIG_HANDLE=true`. Its Next instrumentation hook validates environment configuration and registers SIGTERM/SIGINT handling. Shutdown stops new inference admissions, marks readiness false, lets admitted work finish for up to eleven minutes, disposes the Effect runtime, and closes SQLite. Compose allows twelve minutes before forced termination.

```bash
node scripts/drain.mjs --compose
node scripts/upgrade-gateway.mjs
```

Gateway-only upgrades do not restart the native generator, Laya, FastFlowLM, or optional Halogen. Full Compose stop is a deliberate separate operation. Native `next start` deployments that want this drain handler must also set `NEXT_MANUAL_SIG_HANDLE=true`.

| Bound | Default |
| --- | --- |
| JSON body read | 15 seconds |
| Classifier total | 2.5 seconds |
| Key-controlled capacity wait | up to 30 seconds |
| Generation | 10 minutes |
| Overall inference deadline | 11 minutes |
| Durable request lease | 12 minutes |

There is no lease heartbeat or crash-resume of generation. FastFlowLM's pinned ASR handler ignores cancellation during execution; its resource permit is retained through response/deadline instead of pretending the NPU is immediately idle.

## Accounting and analytics

Analytics queries use Drizzle SQL over a bounded date window (up to 31 days), bounded breakdown groups and paginated request metadata. Filters include key, priority and deployment. Time buckets cover gaps explicitly; missing measurements remain null.

The console separates:

- Provider-reported cloud `usage.cost` from catalogue-based token estimates and configured local accounting costs.
- Observed cached generation tokens from exact classifier-cache hits and session reuse.
- P50/P95 queue, TTFT and generation latency; observed decode throughput; HTTP errors, abandonment and saturation.
- Task/modality, requested effort, difficulty, route-selection reasons, excluded candidates and metadata drilldown.

Local chat returns OpenRouter-shaped nested usage details and `usage.cost` on JSON and the final SSE usage event. Reasoning tokens already included in completion tokens are not charged twice. Unknown cached-token counts prevent a cache-discount calculation; equal configured cached/uncached rates can still produce a known total without claiming a cache hit. Price provenance `unknown` yields unknown accounting, not a zero bill.

Classifier costs are priced from the selected Classifier's qualification record for fresh classified rows, with unknown rates left unknown rather than estimated. Exact-cache and session reuse incur no new classifier call and are recorded as real zero. Completed-result classifier caching is tenant/model/schema/state/catalogue scoped and bounded; there is no in-flight request coalescing or fuzzy cache.

`maxEstimatedUsd` is a cold-cache generation estimate ceiling, not a monthly budget or provider invoice guarantee. It excludes classifier/tool charges. Auxiliary unknown pricing also fails closed when a ceiling is configured.

HTTP success is not task success. Full capture and a task-outcome evaluator remain a future, explicit, per-key opt-in design with access control, retention, redaction and a separate spend budget. Neither is enabled here.

## Hardware acceptance still required

No AMD host is available in this session. Validate live llama.cpp/Halogen generation, NPU device passthrough and inference, SSD-backed PLE behavior, RAM headroom, correctness under concurrency and mixed GPU/NPU load on the incoming machine. No paid OpenRouter completion has been run. Public IDs/prices and local software protocol tests are not hardware benchmarks.

The runtime comparison protocol is in [research/strix-concurrency-comparison.md](research/strix-concurrency-comparison.md). Keep IOMMU enabled for the NPU-enabled topology and record that difference from historical IOMMU-off GPU benchmarks.
