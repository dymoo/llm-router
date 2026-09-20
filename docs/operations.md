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

Probe rounds are coalesced and cached for five seconds. Runtime HTTP probes have bounded deadlines. Laya's actual revision must match the configured pin. llama.cpp uses its root `/health`, not `/v1/health`. Its `/slots` telemetry is the evidence for saturation; gateway permit counts and an absent runtime are not equivalent to saturation.

Cloud health uses non-generating metadata/account endpoints. Jev has no documented free authenticated readiness probe, so its status explicitly says `configuration-only`; it does not claim that a classification call succeeded. NPU model-list reachability establishes service availability, not measured inference quality or hardware performance.

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

Classifier costs are separately estimated for fresh pinned Jev-1.13.0 input at its published rate. Exact-cache and session reuse incur no new classifier call. Completed-result classifier caching is tenant/model/schema/state/catalogue scoped and bounded; there is no in-flight request coalescing or fuzzy cache.

`maxEstimatedUsd` is a cold-cache generation estimate ceiling, not a monthly budget or provider invoice guarantee. It excludes classifier/tool charges. Auxiliary unknown pricing also fails closed when a ceiling is configured.

HTTP success is not task success. Full capture and a task-outcome evaluator remain a future, explicit, per-key opt-in design with access control, retention, redaction and a separate spend budget. Neither is enabled here.

## Hardware acceptance still required

No AMD host is available in this session. Validate live llama.cpp/Halogen generation, NPU device passthrough and inference, SSD-backed PLE behavior, RAM headroom, correctness under concurrency and mixed GPU/NPU load on the incoming machine. No paid OpenRouter completion has been run. Public IDs/prices and local software protocol tests are not hardware benchmarks.

The runtime comparison protocol is in [research/strix-concurrency-comparison.md](research/strix-concurrency-comparison.md). Keep IOMMU enabled for the NPU-enabled topology and record that difference from historical IOMMU-off GPU benchmarks.
