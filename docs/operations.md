# Operations

## Topology and process ownership

Run **one gateway process** with local SQLite. Session pins, model permits and priority queues are process-local. Do not run replicas, PM2 clusters, serverless ephemeral disks or NFS SQLite and expect shared capacity/session correctness.

The gateway's resource registry is process-owned so Next instrumentation and route bundles share admission leases, capacity pools, session routing, health state and disposal. A production HTTP regression holds a generation open while SIGTERM arrives, rejects new work, and checks that the admitted response and SQLite finalization complete before exit. Restart the process after server-code or catalogue changes rather than hot-swapping live ownership.

Compose always provides `gateway` and CPU `laya`; choose either `llamacpp` or `halogen` as the GPU profile, or run optimized native llama.cpp through `host.docker.internal`. Optional profiles are `npu` (FastFlowLM) and `webui`. Only gateway and WebUI publish ports, both loopback by default. See [runtime selection](runtime-selection.md) before changing engines.

## Storage and privacy

| Volume | Contents |
| --- | --- |
| `sqlite-data` | Keys, policy versions, admission leases, metadata usage and audit |
| `laya-cache` | Local classifier weights and optional ONNX artifacts |
| `fastflowlm-models` | Optional NPU model downloads |
| `webui-data` | Open WebUI conversations and document state — separate from gateway metadata |
| `LLAMACPP_MODELS_DIR` bind | GGUF weights and SSD-backed PLE table |
| `HALOGEN_MODELS_DIR`, `HALOGEN_CACHE_DIR_HOST` binds | HGN weights/quality overlay and sensitive derived prompt-cache state |

Catalogues are read-only bind mounts. Secrets live in private `.env` files, not images or the repository. Keep `API_KEY_PEPPER` stable: changing it invalidates stored key authentication. The gateway never stores prompts/completions. Open WebUI does store conversations by design. FastFlowLM v1.0.6 prints inputs/transcripts, so the supplied profile disables Docker log persistence.

Request metadata retention is 30 days; audit retention is 90 days. Maintenance runs on repository activity. These defaults are not a compliance policy.

## Backup and restore

Do not copy only a live SQLite main file while ignoring its WAL.

```bash
node scripts/backup.mjs --compose
node scripts/restore.mjs --compose --replace ./data/backups/control-….sqlite
docker compose up -d --no-deps gateway
```

Native backup uses `SQLITE_PATH=... node scripts/backup.mjs`. Preserve the matching pepper separately. Test restores on an isolated copy before replacing a live database. Current migrations upgrade the identified v1 schema through v4 in a locked transaction and preserve existing keys; arbitrary older/foreign databases are rejected, not guessed.

Native restore requires stopping the gateway and passing `--replace --offline`. Restore validates the source, stages a private complete snapshot, retains the previous database, and replaces the destination only after verification. Compose restore uses an actual helper container mounted on the gateway volume; a failed copy is an error, never a success message. Backup refuses to overwrite an existing destination.

Pins do not survive a restart or restore. Clients must start a new task or declare a checkpoint. Abandoned leases recover through the normal repository maintenance/admission path.

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
