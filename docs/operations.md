# Operations

## Topology and process ownership

Run **one gateway process** with local SQLite. Session pins, model permits and priority queues are process-local. Do not run replicas, PM2 clusters, serverless ephemeral disks or NFS SQLite and expect shared capacity/session correctness.

The gateway is one Node process: `server/main.ts` (an Effect `HttpServer`, bundled to `dist/server/main.mjs`) maps every route in `server/routes.ts` to the `src/http/*` handlers and owns admission leases, capacity pools, session routing, health state and disposal. The console is a static Next export (`out/`) that calls `/api/*` from the browser; on Fly Caddy serves it from disk, elsewhere the API server serves it when `CONSOLE_DIR` is set. There is no Next server at runtime. A production HTTP regression holds a generation open while SIGTERM arrives, rejects new work, and checks that the admitted response and SQLite finalization complete before exit. Restart the process after server-code or catalogue changes rather than hot-swapping live ownership.

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

## Fly.io

Production runs on Fly.io: app `llm-router`, region `lhr`, one `shared-cpu-1x` machine with 256 MB (plus 512 MB swap) and a 1 GB volume at `/var/lib/llm-router`. Never scale past one machine (see Topology). `fly.toml` and `deploy/fly/` hold the whole runtime:

- `deploy/fly/entrypoint.sh` brings up kernel WireGuard (`wg-quick`), then supervises the API server (as `node`, on `127.0.0.1:3000`) and Caddy, and exits non-zero (Fly restarts the machine) if either dies. On SIGTERM it drains the API server first, then stops Caddy, then WireGuard. Fly's `kill_timeout` maximum is 300 s, so a deploy cuts work still running after 5 minutes.
- `deploy/fly/Caddyfile`: the public site (`:8080`, Fly terminates TLS for `llm.dylans.link`) serves only `/v1/*` and `/health/ready`, everything else is 404. The private site binds the WireGuard address `192.168.5.4:3000` and serves the static console plus `/api/*`, `/v1/*` and `/health/*`; internal Caddy (`llm-router.internal.dylans.link`, Authentik-gated) is its only caller. SSE is flushed immediately, responses have no wall-clock limit (12-minute header timeout), and body caps mirror the router's.
- WireGuard: the machine is CCR2004 peer `192.168.5.4`. The CCR firewall lets it reach only Gufo `192.168.6.62:8000`, and lets only internal Caddy reach `:3000` and the k3s nodes reach metrics `:9464` (`METRICS_HOST` binds the WireGuard address). A tunnel blackhole would make Gufo's readiness probe time out, which the router reads as "busy, still up"; so each homelab address has an `unreachable` fallback route and the entrypoint withdraws Gufo's tunnel route after three failed 10-second probes. Gufo then reads as down at once and cloud-enabled keys fail over; the route comes back on the first good probe.
- Secrets (`fly secrets`): `API_KEY_PEPPER`, `GUFO_API_KEY`, `OPENROUTER_API_KEY`, `WG_PRIVATE_KEY`. Import with `fly secrets import -a llm-router` from stdin, never argv.
- Catalogues are the owner's infra repo (`dymoo/dylans-infra` `k8s/apps/llm-router/{catalog,auxiliary}.json`), shipped as Fly `[[files]]` from a checkout at `./.infra`. **A catalogue change deploys** by merging it in dylans-infra, then `gh workflow run deploy-fly -R dymoo/llm-router -f sha=<deployed SHA>` (the current `SOURCE_COMMIT` from `fly machine list -a llm-router --json`).

### Deploys

After `ci` succeeds on `main`, `deploy-fly` (hosted runner) checks out that exact commit, clones the infra catalogue, builds the `fly` image target, audits every layer (`scripts/audit-image.sh`), pushes `registry.fly.io/llm-router:<full SHA>`, and runs `fly deploy --image` with `SOURCE_COMMIT=<SHA>`. The `ready` check in `fly.toml` gates the deploy, and the workflow then checks that `https://llm.dylans.link/health/ready` is 200 and `/api/admin/keys` is 404 there. `workflow_dispatch` takes a full `sha` and `allow_migration` (default `false`).

The migration gate compares the running machine's `SOURCE_COMMIT` with the new SHA. If it is unknown or `git diff --name-only PREV..SHA -- migrations/ src/db/` is non-empty, the automatic run stops; dispatch it with `allow_migration=true`, which first takes an operator backup on the volume (`/opt/ops/backup.mjs`). The gateway also takes its own verified pre-migration copy (see Backup and restore). An older binary refuses a newer schema, so never roll it back onto a migrated database. A failed deploy without a migration is rolled back by redeploying the previous image. Secrets are never synced from this repository or the image. `FLY_API_TOKEN` is an app-scoped deploy token (`fly tokens create deploy -a llm-router`); `DEPLOY_SSH_KEY` clones dylans-infra.

### Backups and restore

The volume is the only copy of `control.sqlite`. Fly snapshots it daily and keeps each snapshot 5 days (`snapshot_retention` in `fly.toml`); batch content rides along in the same snapshot. Keep `API_KEY_PEPPER` with the backups: a restored database is useless without it.

After any key change (mint, rotate, revoke, policy edit), take a snapshot:

```bash
fly volumes snapshots create $(fly volumes list -a llm-router --json | jq -r '.[0].id')
```

Restore, one of:

- **From a snapshot**, onto a new volume: find the snapshot with `fly volumes snapshots list <vol>`, then `fly volumes create llm_router_data --snapshot-id <vs_…> -r lhr -a llm-router`, then `fly machine stop <machine>` and `fly machine clone <machine> --attach-volume <new vol>:/var/lib/llm-router -a llm-router`. Check the clone (`/health/ready`, a known key on `/v1/models`), then `fly machine destroy <old machine>`, and keep the old volume until you are sure. The clone boots on the files as they were at the snapshot.
- **From a `backup.mjs` copy** (the deploy workflow's pre-migration copies under `/var/lib/llm-router/backups/`, or a copy you took and kept off the volume):

```bash
fly ssh console -a llm-router -C "touch /var/lib/llm-router/MAINTENANCE" && fly machine restart -a llm-router
# upload the file if it is not on the volume: fly ssh sftp shell -a llm-router, then put <file> /tmp/restore.sqlite
fly ssh console -a llm-router -C "setpriv --reuid=node --regid=node --init-groups env SQLITE_PATH=/var/lib/llm-router/control.sqlite node /opt/ops/restore.mjs --replace --offline /tmp/restore.sqlite"
fly ssh console -a llm-router -C "rm /var/lib/llm-router/MAINTENANCE" && fly machine restart -a llm-router
```

To take a copy off the volume: `fly ssh console -a llm-router -C "setpriv --reuid=node --regid=node --init-groups env SQLITE_PATH=/var/lib/llm-router/control.sqlite node /opt/ops/backup.mjs /var/lib/llm-router/backups/control-<date>.sqlite"`, then `fly ssh console -a llm-router -C "cat /var/lib/llm-router/backups/control-<date>.sqlite" > control-<date>.sqlite` into a mode-600 location.

### Admin API from a terminal

The admin API is reachable only on the private site, so agents mint keys from inside the machine. `fly ssh console` needs the owner's Fly login, which plays the role kubectl RBAC used to. The console is deliberately not on Fly's private 6PN network: other apps in the org share it.

```bash
umask 077; R=$(mktemp)
fly ssh console -a llm-router -q -C "curl -sS -X POST http://127.0.0.1:3000/api/admin/keys -H 'Origin: https://llm-router.internal.dylans.link' -H 'x-jev-admin: 1' -H 'content-type: application/json' -d '{\"name\":\"<project>-<env>\",\"expiresAt\":null,\"policy\":{\"priority\":\"medium\",\"cloud\":true,\"requestsPerMinute\":0,\"maxConcurrent\":0}}'" > "$R"
jq -r '.key | [.id, .name, .prefix] | @tsv' "$R"; jq -r .secret "$R" | <store-from-stdin>; rm -f "$R"
```

## Health

- `/health/live`: 200 while the HTTP process is alive. No inference or provider call.
- `/health/ready`: cached readiness; 200 only when persistence and at least one non-optional chat deployment are ready. Otherwise 503. The snapshot keeps a fixed `classifier` section (`{backend:"rules", ready:true, local:true, evidence:"configuration-only"}`) for the current console; there is no classifier.
- `/api/health`: the same detailed snapshot with HTTP 200 for the console, including degraded optional deployments.

Probe rounds are coalesced and cached for five seconds. Runtime HTTP probes have bounded deadlines.

Gufo readiness is an authenticated `GET /v1/models` that must list the catalogued model ID, within 1.5 seconds. Its `GET /v1/runtime` `sessions.flex_limit` (contract version 1) sets how many flex requests the Router dispatches at once, read at most every 30 seconds per deployment; 2 when unknown.

Cloud health uses non-generating metadata/account endpoints. System One deployments are optional: an authenticated model-list probe (bearer from `credentialEnvVar`) marks each one ready or degraded without affecting chat readiness, and establishes reachability only, not answer quality.

## Metrics

Set `METRICS_PORT` to an integer from 1–65535, different from the application `PORT` (default 3000), to enable the dedicated Prometheus listener. Unset disables it. Only `GET /metrics` is served there; the application port never serves metrics. `METRICS_HOST` (default `0.0.0.0`) chooses its bind address; on Fly it is the WireGuard address. Expose the metrics port solely to Prometheus (the CCR firewall on Fly, NetworkPolicy on Kubernetes); do not route it through Caddy/Authentik or publish it publicly. The listener stops during graceful shutdown. `SOURCE_COMMIT` in the image supplies the build label, or `unknown` when absent.

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

The API server validates environment configuration at start and handles SIGTERM/SIGINT itself: the listener keeps answering (503 for new work, readiness false) while shutdown stops new inference admissions, marks readiness false, lets admitted work finish for up to eleven minutes, disposes the Effect runtime, and closes SQLite. Compose allows twelve minutes before forced termination.

```bash
node scripts/drain.mjs --compose
node scripts/upgrade-gateway.mjs
```

Gateway-only upgrades do not restart Gufo or Open WebUI. Full Compose stop is a deliberate separate operation.

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
