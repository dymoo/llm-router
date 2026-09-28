# Operations

## Topology and process ownership

Run **one gateway process** with local SQLite. Session pins, model permits and priority queues are process-local. Do not run replicas, PM2 clusters, serverless ephemeral disks or NFS SQLite and expect shared capacity/session correctness.

The gateway's resource registry is process-owned so Next instrumentation and route bundles share admission leases, capacity pools, session routing, health state and disposal. A production HTTP regression holds a generation open while SIGTERM arrives, rejects new work, and checks that the admitted response and SQLite finalization complete before exit. Restart the process after server-code or catalogue changes rather than hot-swapping live ownership.

Compose defaults to `gateway` with Rules routing; the optional `webui` profile adds Open WebUI. Gufo, the local model runtime, runs on the owner's GPU host outside Compose and is operated from the owner's infra repository. Only gateway and WebUI publish ports, both loopback by default.

## Storage and privacy

| Volume        | Contents                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `sqlite-data` | Keys, policy versions, admission leases, metadata usage and audit; opt-in batch inputs/results in a separate private content store |
| `webui-data`  | Open WebUI conversations and document state — separate from gateway metadata                                                       |

Catalogues are read-only bind mounts. Secrets live in private `.env` files, not images or the repository. Keep `API_KEY_PEPPER` stable: changing it invalidates stored key authentication. Ordinary inference stores request metadata, not prompts/completions; submitting a batch explicitly stores its inputs and results in a bounded private store beside `control.sqlite`, outside Analytics, until acknowledgement or the 24 h post-terminal TTL ([batch.md](batch.md#result-holding)). Open WebUI stores conversations by design.

Request metadata retention is 30 days; audit retention is 90 days. Maintenance runs on repository activity. These defaults are not a compliance policy.

## Backup and restore

Do not copy only a live SQLite main file while ignoring its WAL.

```bash
node scripts/backup.mjs --compose
node scripts/restore.mjs --compose --replace ./data/backups/control-….sqlite
docker compose up -d --no-deps gateway
```

Native backup uses `SQLITE_PATH=... node scripts/backup.mjs`. Preserve the matching pepper separately. Test restores on an isolated copy before replacing a live database. Both scripts validate against the same `migrations/` directory that `src/db/migrate.ts` consumes (currently v7, the simple key policy): the control-plane identity must match, `settings.schema_version` must equal `PRAGMA user_version`, and the version must sit inside the supported range. Identified older schemas (v1–v5) are accepted and upgraded in a locked transaction on the next gateway start, preserving existing keys; foreign, corrupt, inconsistent or newer-than-supported databases are refused, not guessed.

Native restore requires stopping the gateway and passing `--replace --offline`. Restore validates the source, stages a private complete snapshot, retains the previous database, and replaces the destination only after verification. Compose restore uses an actual helper container mounted on the gateway volume; a failed copy is an error, never a success message. Backup refuses to overwrite an existing destination.

Before upgrading an existing identified control-plane database, gateway startup automatically makes a WAL-aware, verified copy in `dirname(SQLITE_PATH)/backups/control-pre-v<target>-<UTC timestamp>.sqlite` (directory mode `0700`, file mode `0600`). It keeps the five newest automatic copies for that target version without touching other backups; if the copy cannot be created or verified, startup refuses the migration and leaves the old schema intact. Fresh and already-current databases do not get a pre-migration copy.

Restore quarantines batch state; an ordinary restart does not. On a normal restart the ledger leaves never-dispatched queued items untouched, interrupts only locally in-flight running work, and re-polls confirmed remote groups by their proven upstream ids — durable inputs keep queued work recoverable. A restore is a different safety case: a snapshot cannot prove that a queued or locally-running item was not executed after the snapshot was taken. Before the staged copy replaces the destination, restore terminalizes pending batch items with the explicit `restore_review_required` outcome, finalizes the running request rows linked to those items as `abandoned` (spend metadata preserved — deferred remote requests skip ordinary lease recovery and would otherwise stay running forever), marks unconfirmed submit intents `unknown` (no new POST is ever derived from them), and closes non-terminal jobs that own no pending confirmed remote — jobs still holding an unharvested confirmed remote stay nonterminal, and their running items and linked requests stay running, so the proven id can re-poll and finish normally. The original backup file is never modified; quarantined rows need review before the restored database is used.

Batch content is backed up separately, or not at all. `backup.mjs` copies only `control.sqlite`: the sensitive content store (request bodies and result rows under `dirname(SQLITE_PATH)/batch-content`, or `BATCH_RESULTS_DIR`) lives outside the database, is bounded by the 24-hour post-terminal TTL and the per-job/per-key budgets, and is never silently added to metadata backups. To keep it deliberately, copy the directory separately with its own retention — ad-hoc copies must not outlive the TTL bounds that keep this store short-lived.

Sessions do not survive a restart or restore; the next turn just routes normally. Migration 7 rewrites every stored key policy to `{ priority, cloud, requestsPerMinute, maxConcurrent }` with `cloud` true exactly where `overloadAction` was `failover`. Abandoned leases recover through the normal repository maintenance/admission path.

## Automatic redeploys

After `ci` succeeds for a push to `main`, `deploy-k3s` checks out that exact commit, builds the linux/amd64 gateway image, audits every saved image layer for environment files, SQLite files and private data, and pushes `ghcr.io/dymoo/llm-router:<full source SHA>`. It records the **pushed digest**, not the mutable tag, in the infra overlay. The workflow also accepts `workflow_dispatch` with a required full `sha` and `allow_migration` (default `false`). Only successful push-triggered CI runs auto-deploy; PR CI does not. Deployments serialize rather than cancel each other.

The deployer reads `# source-commit: <full 40-character SHA>` from `dymoo/dylans-infra/k8s/apps/llm-router/kustomization.yaml`. If that commit is missing or unknown, or `git diff --name-only PREV..SHA -- migrations/ src/db/` has changes, it treats the release as a **possible forward-only migration**. The automatic run stops and tells the operator to dispatch `deploy-k3s` manually with the exact `sha` and `allow_migration=true`. On startup the new gateway takes its own verified pre-migration copy (see Backup and restore) and refuses to migrate if that copy fails; an extra operator backup beforehand is still recommended. Preserve the matching `API_KEY_PEPPER` outside the image. An older binary refuses a newer schema, so never roll it back onto a migrated database. On rollout failure without a migration, the workflow runs `kubectl rollout undo`, reverts its infra write-back commit and pushes that revert, then fails. Aft…

Deployment restarts the single gateway process. `Recreate` drains the old pod (up to the 780-second termination grace period); active or locally running work may be interrupted and clients should retry. Never treat a restart as a restored snapshot: queued/recoverable batch work follows the normal restart behavior above. Secrets are **not synced** from the router repository or the image; provision and rotate runtime Kubernetes Secrets out of band.

Infra contract for `dymoo/dylans-infra`:

- Namespace `llm-router`, overlay `k8s/apps/llm-router/`; `kustomization.yaml` must contain exactly one `# source-commit: <full SHA>` line and one `images` entry named `ghcr.io/dymoo/llm-router` with exactly one `digest: sha256:<64 lowercase hex>` line. The workflow changes only those two lines, commits `deploy(llm-router): <short SHA>` to infra `main` and applies `infra/k8s/apps/llm-router`.
- A Deployment named `llm-router` with one replica, `Recreate`, `terminationGracePeriodSeconds: 780`, PVC mounted at `/var/lib/llm-router`, and private GHCR image pinned by digest. Runtime secrets remain out of band.
- GitHub App runner scale set label `llm-router-deploy-runners`; repository secrets `GHCR_PAT` (registry push only; checkout uses the default repository access), `DEPLOY_SSH_KEY` (infra `main` write-back) and `KUBECONFIG_B64` (cluster access). The `GHCR_PAT` publisher logs in as `dymoo`, matching the established infra pipeline. `secrets.GITHUB_TOKEN` is empty on these runners. GitHub SSH host key is pinned, with strict verification, not learned at runtime.
- Kubernetes deployer credentials need only the resource verbs required to apply the overlay and to read/watch deployment rollout status and undo the Deployment. They must have **no Secret verbs**; out-of-band administrators own Secret creation and updates.

## Health

- `/health/live`: 200 while the HTTP process is alive. No inference or provider call.
- `/health/ready`: cached readiness; 200 only when persistence and at least one non-optional chat deployment are ready. Otherwise 503. The snapshot keeps a fixed `classifier` section (`{backend:"rules", ready:true, local:true, evidence:"configuration-only"}`) for the current console; there is no classifier.
- `/api/health`: the same detailed snapshot with HTTP 200 for the console, including degraded optional deployments.

Probe rounds are coalesced and cached for five seconds. Runtime HTTP probes have bounded deadlines.

Gufo readiness is an authenticated `GET /v1/models` that must list the catalogued model ID, within 1.5 seconds. Its `GET /v1/runtime` `sessions.flex_limit` (contract version 1) sets how many flex requests the Router dispatches at once, read at most every 30 seconds per deployment; 2 when unknown.

Cloud health uses non-generating metadata/account endpoints. System One deployments are optional: an authenticated model-list probe (bearer from `credentialEnvVar`) marks each one ready or degraded without affecting chat readiness, and establishes reachability only, not answer quality.

## Metrics

Set `METRICS_PORT` to an integer from 1–65535, different from the application `PORT` (default 3000), to enable the dedicated Prometheus listener. Unset disables it. Only `GET /metrics` is served there; the application port never serves metrics. Expose the metrics port solely to Prometheus via Kubernetes NetworkPolicy; do not route it through Caddy/Authentik or publish it publicly. The listener stops during graceful shutdown. `SOURCE_COMMIT` in the image supplies the build label, or `unknown` when absent.

The `llm_router_` families export build/process and scrape timing; cached readiness; terminal admissions, request duration and concurrency; queue/capacity and routing decisions; stream outcomes; known token and separate cost categories; cache observations; and read-only SQLite counts for key and batch state. Histograms use fixed buckets and seconds; counters end in `_total`. Missing usage from a dispatched request increments `usage_unknown_total` rather than fabricating a zero token count. The current Gufo adapter does not decode draft acceptance counts, so no draft-token metric is emitted.

For OpenRouter, `llm_router_provider_pin_total{deployment,result="match|mismatch|unknown"}`
counts post-completion generation-metadata checks only for cloud deployments
with a provider restriction; unpinned and non-cloud requests do not emit this metric. A single delayed, bounded
`GET /api/v1/generation?id=…` reads the documented `data.provider_name`; no
extra inference is purchased and client responses never wait on the check.
Alert when mismatch increases; investigate unknown lookups separately. Lookups
are skipped during shutdown. Provider names are never metric labels.
Cache request counts remain
`llm_router_cache_observations_total{deployment,result="hit|miss|unknown"}`.
`llm_router_cache_eligible_prompt_tokens_total{deployment}` counts prompt tokens
only when the same request has known cached-token usage. The token-weighted hit
fraction, under the deployment selection, is
`sum by(deployment)(rate(llm_router_tokens_total{kind="cached",deployment=~"${deployment:regex}"}[$__rate_interval])) / sum by(deployment)(rate(llm_router_cache_eligible_prompt_tokens_total{deployment=~"${deployment:regex}"}[$__rate_interval]))`.
Known zero cached tokens publish a zero-valued cached-token series (0%); requests
with missing cached-token usage are excluded from the denominator, not counted
as misses. No cloud
`llm_router_cost_usd_total{kind="cache_savings"}` series is fabricated:
OpenRouter's `cache_discount` does not explicitly document a USD unit, and
rate-card estimates are not provider-reported savings. The dashboard savings
panel stays empty until an explicit provider-reported USD amount is available.

Only a validated UUID `key_id` labels per-key request, token and cost series; `key_info` exposes the active key name (truncated to 64 characters), priority and `cloud` alongside its policy limits. Never use API key prefixes, digests, secrets, prompts, completions, session/request/correlation/job/item IDs or free-text details as labels or metric values. Unknown enum/catalogue labels collapse to `other`, and unrouted requests use deployment and location `none`. Restrict access to this port because active key names and UUIDs are operational metadata.

The Grafana dashboard JSON lives at `deploy/grafana/llm-router.json` and uses the `prometheus` datasource UID.

## Routing

Keys route by `priority` and `cloud` only; see [routing-policy.md](routing-policy.md) and [clients.md](clients.md) for wire behavior. Before giving a key `cloud`, remember it lets high and medium work reach paid OpenRouter whenever Gufo is down, busy past the 5 s / 30 s budget, or cannot serve the request. Planned Gufo downtime needs no configuration: keys without `cloud` get `503 local_overloaded`, flex work waits up to 10 minutes.

## Drain and upgrades

The production image sets `NEXT_MANUAL_SIG_HANDLE=true`. Its Next instrumentation hook validates environment configuration and registers SIGTERM/SIGINT handling. Shutdown stops new inference admissions, marks readiness false, lets admitted work finish for up to eleven minutes, disposes the Effect runtime, and closes SQLite. Compose allows twelve minutes before forced termination.

```bash
node scripts/drain.mjs --compose
node scripts/upgrade-gateway.mjs
```

Gateway-only upgrades do not restart Gufo or Open WebUI. Full Compose stop is a deliberate separate operation. Native `next start` deployments that want this drain handler must also set `NEXT_MANUAL_SIG_HANDLE=true`.

| Bound                      | Default        |
| -------------------------- | -------------- |
| JSON body read             | 15 seconds     |
| High / medium local wait   | 5 / 30 seconds |
| Flex wait                  | 10 minutes     |
| Generation                 | 10 minutes     |
| Overall inference deadline | 11 minutes     |
| Durable request lease      | 12 minutes     |

The overall chat deadline applies through the end of a streamed response, not merely until its headers are sent. Its timer is cancelled once chat work settles, including completed, failed, and cancelled requests; a completed request does not retain an eleven-minute timer. There is no lease heartbeat or crash-resume of generation. A dispatched System One request keeps its resource permit until the upstream answers or its ten-minute deadline passes, even if the client disconnects, because the upstream keeps working on it.

## Accounting and analytics

Analytics queries use Drizzle SQL over a bounded date window (up to 31 days), bounded breakdown groups and paginated request metadata. Filters include key, priority and deployment. Time buckets cover gaps explicitly; missing measurements remain null.

The console separates:

- Provider-reported cloud `usage.cost` from catalogue-based token estimates and configured local accounting costs.
- Observed cached generation tokens.
- P50/P95 queue, TTFT and generation latency; observed decode throughput; HTTP errors and abandonment.
- Requested effort, route decision reasons and metadata drilldown. Task, difficulty, classifier and exclusion breakdowns remain in the response for historical rows only.

Local chat returns OpenRouter-shaped nested usage details and `usage.cost` on JSON and the final SSE usage event. Reasoning tokens already included in completion tokens are not charged twice. Unknown cached-token counts prevent a cache-discount calculation; equal configured cached/uncached rates can still produce a known total without claiming a cache hit. Price provenance `unknown` yields unknown accounting, not a zero bill.

HTTP success is not task success. Full capture and a task-outcome evaluator remain a future, explicit, per-key opt-in design with access control, retention, redaction and a separate spend budget. Neither is enabled here.

## Unverified here

This repository does not measure Gufo quality or throughput, and no paid OpenRouter completion has been run. Public IDs/prices and local protocol tests are not benchmarks.
