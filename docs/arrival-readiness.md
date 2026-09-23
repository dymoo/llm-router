# Arrival readiness: first-boot and acceptance handoff

Prepared 2026-09-22 for the Strix Halo machine arriving 2026-09-23 before 13:00. Targets: a verified **workable software handoff by 10:00** and an **improved handoff by 13:00**, both local on arrival day. These are outcome targets for *this document's checks*, not delivery guarantees: every line below is marked from observed output only — `PASS` (command ran, output captured here or in a linked artifact) or `NOT RUN` (named prerequisite missing). Nothing is assumed green.

**No GPU execution, no paid Jev classification, and no paid OpenRouter call is verified as of writing.** There is no SSH target yet, so every on-box gate starts `NOT RUN`. Existing verification boundaries: [operations.md](operations.md#hardware-acceptance-still-required), [runtime-selection.md](runtime-selection.md), [halogen.md](halogen.md).

## Blockers (real, unresolved)

| Blocker | Consequence | Explicitly separate from |
| --- | --- | --- |
| Hardware not present; SSH target unavailable | All Section B gates stay `NOT RUN` until the machine is on the network | Section A software checks are runnable today, on-box or on the dev machine |
| Classifier qualification record missing (Compose: `CLASSIFIER_QUALIFICATION_FILE` still on the deliberately-invalid example default; native: `CLASSIFIER_QUALIFICATION` absent) | Production routing stays fail-closed: readiness reports `unqualified`, chat returns `503 classifier_unqualified`, no backend is contacted | **Operational readiness.** Liveness, runtime discovery, a real generation against the runtime, and the batch surface accepting jobs can all be healthy while routing is unqualified. Closing this needs a real labelled evaluation for the exact backend/revision/question schema — never a weakened gate, never `REPLACE_` placeholders ([operations.md](operations.md#classifier-qualification)) |
| No spending approval recorded | DeepInfra batch end-to-end test (Step 7) and any paid Jev calls stay `NOT RUN` | All free/local checks; batch job *acceptance* and idle behavior need no spend |

The separate batch catalogue wiring is present: `BATCH_CATALOG`, its Compose mount and `catalog.batch.example.json` with `cloud-glm-batch`; only the batch scheduler loads it. The software evidence is recorded below. `BATCH_CATALOG` is optional by design — absent ⇒ spill disabled. Synchronous Sail FP8 chat stays untouched throughout.

## Section A — Already software-testable (no hardware, no spend)

All commands exist today; see [setup.md](setup.md#local-verification) and [batch.md](batch.md).

1. **Static/software validation:** `npm run format && npm run check-all`, the Python service tests, and `docker compose --profile llamacpp --profile halogen --profile npu --profile webui config --quiet`. The compose command is syntax-only — never launch both full-size GPU profiles together.
2. **Clean-machine boot (CPU classifier, no GPU):** `node scripts/setup.mjs` (refuses to overwrite; writes mode-0600 `.env`, a matching catalogue, `./data` mode 0700), then `docker compose up -d gateway laya` and `docker compose ps`. Gateway must start even while Laya pulls weights.
3. **Liveness:** `curl -fsS http://127.0.0.1:3000/health/live` → `200` (no inference, classifier or provider call). `curl -fsS http://127.0.0.1:3000/api/health` → `200` detailed snapshot.
4. **Expected fail-closed state today (correct, not a defect):** `/health/ready` → `503` with the classifier `unqualified`; `POST /v1/chat/completions` with a `jrv_` key → `503 classifier_unqualified`. Record this as the observed baseline; it only changes after Step 4 produces real calibration evidence.
5. **Batch surface, idle and free:** submit the [batch.md](batch.md#submit) example job → `202` with `status: "validating"` settling to `"queued"`; `local_wait_until` equals `spillAt`, `deadline_at` equals `spillAt + 24h` (the documented clamp on `localityBias`). Verify key scoping (foreign id → `404 not_found`), `GET` retry-safety (reading never destroys `results`), the in-flight cap (`409` at ≥ 4 non-terminal jobs), and a `400 invalid` limit row (e.g. > 1000 items). **Idle assertion:** run under a high-`localityBias` key so the local-only window covers the whole observation — no upstream submission may occur before `local_wait_until`, and while the classifier is unqualified no item may reach any backend. No spill, no spend.
6. **Backup round-trip (software side):** `node scripts/backup.mjs --compose` produces a WAL-aware copy under `./data/backups`; a trial `node scripts/restore.mjs --compose --replace <copy>` on an isolated path validates the schema (v1→v5, keys preserved) before it is ever needed ([operations.md](operations.md#backup-and-restore)).

## Section B — Physical on-box gates (require the machine + SSH)

### B0 — First-boot configuration gates

- **Choose exactly ONE full-size GPU runtime.** Never two large models at once.

  | Choice | Command |
  | --- | --- |
  | Native optimized llama.cpp (default flow) | `node scripts/setup.mjs --runtime llamacpp-native` + host prefixes per [llamacpp.md](llamacpp.md) |
  | Halogen | `node scripts/setup.mjs --runtime halogen` |
  | Containerized llama.cpp (compatibility lane) | `node scripts/setup.mjs --runtime llamacpp` |

  Switching later follows the drain-then-swap sequence in [runtime-selection.md](runtime-selection.md#safe-switching-without-resetting-keys); `scripts/configure-runtime.mjs` prepares a new catalogue and refuses to overwrite an existing one.
- **Model paths on local SSD, quality overlay present.** Check `LLAMACPP_MODELS_DIR`/`LLAMACPP_MODEL_FILE`, `HALOGEN_MODELS_DIR`, `HALOGEN_CACHE_DIR_HOST` (and `$HOME/.models` for the native flow) with `findmnt -T <path>` — must be a local block device, not tmpfs/network storage; budget ~110 GiB free (native install) or ~118 GiB first download (Halogen). For Halogen the **quality** sidecar must accompany the checkpoint: `node scripts/halogen-preflight.mjs --compose` checks checkpoint, tokenizer and current sidecar header (`mtp.fc_hidden.weight`). A bare checkpoint is not the approved configuration — the entrypoint refuses it. `HALOGEN_DOWNLOAD=` disables auto-download when supplying weights.
- **Numeric device groups.** `stat -c '%g' /dev/kfd /dev/dri/card0` on the host → set `GPU_RENDER_GID` (from `/dev/kfd`) and `GPU_VIDEO_GID` (from `/dev/dri/card0`) in `.env`; Compose defaults are `109`/`44` and must match the host (both inspected images have a `video` group but no named `render` group — that is why the ids are numeric). Mismatched groups fail *before* the runtime starts.
- **IOMMU stays enabled — light check only at B0.** A GPU-only launch does **not** need XRT, Ryzen AI packages, or `scripts/npu-verify.sh`; full NPU driver verification belongs exclusively to optional Step 6. Here, confirm the kernel command line carries no IOMMU-off flag: `grep -Eq 'amd_iommu=off|iommu=off' /proc/cmdline` must match nothing (exit 1). Keeping IOMMU on preserves the NPU option and matches this hub's default; this tree never edits the bootloader, and historical IOMMU-off GPU benchmarks are not a requirement ([npu.md](npu.md)).

### B1 — Smoke order (run strictly in this order; a failure stops the sequence)

1. **Liveness:** `curl -fsS http://127.0.0.1:3000/health/live` → `200`.
2. **Runtime identity/health:** discovery from inside the gateway network —
   native: `docker compose exec gateway node /opt/ops/discover-local.mjs http://host.docker.internal:8080`;
   container llama.cpp: same script with `http://llamacpp:8080`;
   Halogen: `docker compose exec gateway node /opt/ops/discover-halogen.mjs http://halogen:8731`.
   Expected: exit 0, health **and** model listing both usable, served alias/context/cap matching the generated catalogue. `/api/health` shows the runtime healthy (Halogen: `status: "ok"`, `engine.responds: true` within the 35 s PONG budget; llama.cpp: root `/health`, slot telemetry from `/slots` — never `/v1/health`).
3. **Real generation (first possible GPU evidence).** A bare `curl` with no method/body sends a GET and generates nothing — POST JSON explicitly, with the served alias and a small token budget.

   Native host path (alias from `--alias local-llamacpp`, on the firewalled private bind):

   ```bash
   curl -fsS http://127.0.0.1:8080/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"local-llamacpp","messages":[{"role":"user","content":"Reply with the single word READY."}],"max_tokens":32,"temperature":0,"chat_template_kwargs":{"enable_thinking":false}}'
   ```

   Containerized runtimes publish no host port; POST from the gateway container (it has `node`). Container llama.cpp:

   ```bash
   docker compose exec -T gateway node -e 'fetch(process.argv[1],{method:"POST",headers:{"content-type":"application/json"},body:process.argv[2]}).then(r=>r.text()).then(console.log)' \
     http://llamacpp:8080/v1/chat/completions \
     '{"model":"local-llamacpp","messages":[{"role":"user","content":"Reply with the single word READY."}],"max_tokens":32,"temperature":0,"chat_template_kwargs":{"enable_thinking":false}}'
   ```

   Halogen:

   ```bash
   docker compose exec -T gateway node -e 'fetch(process.argv[1],{method:"POST",headers:{"content-type":"application/json"},body:process.argv[2]}).then(r=>r.text()).then(console.log)' \
     http://halogen:8731/v1/chat/completions \
     '{"model":"halogen-qwen3.8-flash-next","messages":[{"role":"user","content":"Reply with the single word READY."}],"max_tokens":32,"temperature":0,"enable_thinking":false}'
   ```

   Thinking is switched off explicitly in every request — llama.cpp via `chat_template_kwargs: {"enable_thinking": false}` (the field the router adapter itself sends, `src/router/adapters/llamacpp.ts`), Halogen via its documented top-level `enable_thinking:false` — rather than trusting a server default; without it a 32-token budget could be consumed entirely by reasoning and a healthy model would fail the visible-content check. `max_tokens: 32` sits far inside every cap (Halogen cap 65,536).

   **A 200 with non-empty text is not GPU evidence by itself.** The evidence pair is (a) the response — `choices[0].message.content` non-empty, a `finish_reason`, usage counts — **and** (b) the runtime's own startup/offload log naming the physical AMD device: native `gfx_target_version` / `gfx1151` (`110501`, already required by `--check-only`), or the device line from `docker compose logs llamacpp` / `docker compose logs halogen` — with **no** software-rasterizer (llvmpipe/SwiftShader) or CPU fallback line. Missing the device log → step 3 stays `NOT RUN` as GPU evidence. If either half fails, everything downstream is `NOT RUN` — do not record later steps as passing.
4. **Classifier labelled evaluation / qualification:** run the selected backend (`laya` default; `jev` only with explicit spend approval — no automatic paid fallback exists) against a representative labelled evaluation set, then write a qualification record in the shape of `classifier-qualification.example.json` with **measured** metrics, a `pass` verdict, and sourced rates for the exact backend, model revision and question schema — no `REPLACE_` placeholders; records are never generated, only measured. **Selecting it differs by layout:** Compose operators set `CLASSIFIER_QUALIFICATION_FILE` in `.env` to their real host record (the gateway environment pins `CLASSIFIER_QUALIFICATION` to the mounted `/etc/llm-router/classifier-qualification.json`, overriding any `.env` value for it; the shipped `classifier-qualification.example.json` default is deliberately invalid evidence — `verdict: "fail"` + `REPLACE_` — so it can never pass). Native operators set a local `CLASSIFIER_QUALIFICATION` path (absent by default = fail-closed `unqualified`). Restart the gateway either way — the record is process-cached. Expected: `/health/ready` → `200` (no longer `unqualified`), then one routed generation through the gateway with a `jrv_` key (`model: "auto"`) → `200` with OpenRouter-shaped `usage`. If no evaluation was run, the gate stays closed and that state is recorded as such — the gate is never relaxed to turn readiness green ([research/laya-routing-validation.md](research/laya-routing-validation.md)).
5. **Local batch idle behavior (on-box, qualified):** with interactive queues empty and a high-`localityBias` key, submit a small job → items dispatch locally through the ordinary routed path, the job reaches a terminal status, results are readable repeatedly (`GET` never destroys them) and are held in the dedicated content store. No provider `usage`/`cost` may appear (nothing spilled), and no upstream batch may exist. Purge with a terminal `DELETE` (acknowledgement path) or let the 24 h post-terminal TTL run; job metadata is retained either way ([batch.md](batch.md#result-holding)).
6. **Optional NPU (skip freely):** `scripts/npu-verify.sh` PASS (IOMMU on), then `flm validate`, `xrt-smi examine` → device with architecture `aie2p`, then `docker compose --profile npu up -d --build fastflowlm gateway`; check `/api/health`; run one embedding and one short known transcription through the gateway with a dedicated key. Laya stays `LAYA_BACKEND=cpu` until its own VitisAI assignment reports ≥ 0.95 ([ai-hub.md](ai-hub.md), [npu.md](npu.md)). FastFlowLM keeps `logging.driver: none` — it prints inputs.
7. **Explicit DeepInfra batch end-to-end — ONLY with recorded spending approval:** first confirm `BATCH_CATALOG` is set in the deployment's `.env` (it ships in `.env.example` pointing at the mounted batch-only catalogue, separate from `MODEL_CATALOG` and loaded only by the scheduler — absent ⇒ spill disabled, in which case this step is `NOT RUN`), resolving to deployment `cloud-glm-batch` → model `z-ai/glm-5.3-flash`, transport `openrouter`, `providerRestriction: deepinfra/fp4`, context 1,048,576, max output 131,072 — synchronous Sail FP8 chat untouched. Trigger a spill honestly via a hard-constraint local ineligibility (context/allowlist per [batch.md](batch.md#spill-rule)) — never by relaxing a constraint — as a 1-item job. Expected: the job records the upstream submission and reaches a terminal status with result rows (`response` XOR `error`), job-level `usage.cost` provider-reported (absent → unknown, never 0), per-row cost unknown-not-zero, results re-readable until terminal `DELETE` or the local 24 h TTL; upstream retention is 30 days unless our terminal `DELETE` succeeds. The pinned rates (input $0.06, cached $0.012, output $0.20 per Mtok, read 2026-09-22 from the live `:batch` endpoints record) are dated catalogue metadata for `maxEstimatedUsd` math only — **quality and latency remain unmeasured bootstrap priors**; one tiny billed job is still spend, hence the approval gate.

## Arrival-day targets (outcome-based)

- **10:00 minimum (workable software handoff):** this document reviewed and current; every Section A check either executed with captured output or explicitly `NOT RUN` with its reason; blockers table accurate; Section B fully queued so the smoke order starts the moment SSH is reachable. No hardware claim attached to any of it.
- **13:00 improved (contingent on arrival + access before 1pm):** as much of Section B as the elapsed on-box time honestly allows — realistically B0 plus Steps 1–3 (liveness, runtime identity/health, first real generation) — each marked `PASS` only where command output is actually captured. Steps 4–7 are explicitly **not** promised by 13:00: qualification needs a real labelled evaluation to exist, NPU needs an IOMMU-on boot plus the Ryzen AI stack, Step 7 needs spend approval. Unreached steps stay `NOT RUN`.

## Rollback and recovery

- **Before any on-box change:** `node scripts/backup.mjs --compose` (WAL-aware; never copy a live main file without its WAL) and preserve `API_KEY_PEPPER` separately — rotating it invalidates every stored key.
- **Gateway rollback/upgrade:** `node scripts/drain.mjs --compose` (stops new admissions, lets admitted work finish up to 11 minutes, Compose allows 12) then `node scripts/upgrade-gateway.mjs`; restore a known-good database with `node scripts/restore.mjs --compose --replace <backup>` + `docker compose up -d --no-deps gateway`, after testing that restore on an isolated copy. Pins do not survive restart/restore — clients start a new task or declare a checkpoint.
- **Runtime switch/rollback:** drain → stop the old GPU runtime → wait for GPU/RAM release → flip the single GPU profile and `MODEL_CATALOG_FILE` → up → re-run discovery and one generation ([runtime-selection.md](runtime-selection.md#safe-switching-without-resetting-keys)). The distinct deployment ids (`local-halogen` vs `local-llamacpp`) make the previous state recoverable by swapping back.
- **Restart/recovery and spend safety:** on gateway/scheduler restart, already-confirmed upstream batch groups resume by re-polling the proven `remoteBatchId` and their stored group facts — never by re-running grouping, classification or spill, and never by re-POSTing a confirmed submission — so recovery and rollback cannot double-spend ([batch.md](batch.md#submit): reconciliation proceeds only from a provider id proven to be ours).
- **First-boot failure modes:** `setup.mjs` refuses to overwrite `.env`/catalogues — edit in place rather than regenerating (secrets must stay stable). A Halogen download that completed the base checkpoint but missed the sidecar needs the sidecar fetched explicitly; `HALOGEN_DOWNLOAD=` freezes downloads while you supply files. A malformed `ADMIN_BASIC_AUTH` refuses startup by design.

## Durable content and backup

- **Job metadata** is durable in `control.sqlite` (approved migration `0005_batch_ledger`, schema v5, locked transaction) — covered by the WAL-aware backup above; prompts, completions and reasoning text never enter it.
- **Batch content** (request bodies + result rows) lives in the dedicated store selected by `BATCH_RESULTS_DIR` (optional override). Confirmed resolution chain: unset env → `server/batch.ts` derives `dirname(SQLITE_PATH)/batch-content`, so under Compose it lands beside `control.sqlite` **on the existing `sqlite-data` volume** (native: `./data/batch-content`) and persists across container recreation; the `data/batch-results` constant in `src/batch/results.ts` is only a library-level fallback for direct `createBatchResultStore` calls (tests/embedders) and never applies to production wiring. It is the bounded, opt-in exception of [adr/0004](adr/0004_batch_result_holding.md): per-key access only, retry-safe reads, 64 MiB/job and 256 MiB/key budgets, purge by terminal `DELETE` or 24 h post-terminal TTL; upstream keeps its own 30-day clock unless our terminal `DELETE` succeeds. Treat any `BATCH_RESULTS_DIR` override as a deliberate persistence+backup decision — an unpersisted override would silently lose held results on host loss.
- **Backup content policy:** the metadata database is always backed up; the content store is sensitive, short-lived by design (TTL) and should be included in backups only deliberately, never joined into Analytics.

## Evidence — software-only, 2026-09-22

| Scope | Observed result |
| --- | --- |
| Repository checks | **PASS:** `npm run format && npm run check-all`: TypeScript green, 290 unit tests, sanitized Next build, 12 production tests. Python Laya tests: 37/37 PASS. |
| Compose and qualification mount | **PASS:** `docker compose --profile llamacpp --profile halogen --profile npu --profile webui config --quiet` after the long-bind fix. A private host qualification record is mountable via `CLASSIFIER_QUALIFICATION_FILE`; mountability is not semantic qualification. |
| Packaging | **PASS:** clean standalone output contains no env/data; private route NFT references: 0. `.dockerignore` preguard passed; 12 image layers audited with 0 sensitive paths. Isolated smoke used local `llm-router-gateway:arrival-20260923` (`linux/amd64`, image ID `sha256:4771d91b1700ea7d6ce8bbb8c9af22af0f237aab8d82ae3a32e50cbd6c1cd0af`). |
| Isolated container HTTP | **PASS in `--network none`, with no host port:** `/health/live` 200; `/health/ready` 503 `classifier_unqualified`; chat 503 `classifier_unqualified`. These 503s are the expected fail-closed baseline, not qualified routing or a generation result. |
| Isolated batch surface | **PASS:** unauthenticated request 401; key-scoped list 200; submit 202; repeated owner `GET` 200; foreign-key id 404; list shows only owner jobs. The submitted job later **failed as expected** under the unqualified classifier — this is not a completed local batch or a provider result. |
| Isolated persistence | **PASS:** SQLite schema v5; private batch input file mode 0600 outside the database; input marker absent from the database; separate batch and synchronous catalogues mounted. The container, temporary env and archive were removed after the smoke; the local image was retained. |
| Database backup | **PASS:** pre-migration live SQLite v4 backup was created and verified at `data/backups/control-pre-batch-v5-20260922T2019Z.sqlite`. An isolated restore trial is **NOT RUN**; do not infer restore success from the backup check. |

**Still NOT RUN / unqualified:** hardware and SSH access; the B0 on-box SSD/device-group/IOMMU checks; actual gfx1151 device/offload logs and real GPU generation; representative labelled classifier calibration and a passing production qualification record; qualified local batch completion/idle co-tenancy; optional NPU execution; paid Jev classification and DeepInfra batch inference (no spending approval). The clean-machine `setup.mjs` flow and an isolated restore trial have not been separately observed in this evidence. No Section B physical acceptance step is marked PASS. The 10:00 and 13:00 sections remain outcome targets, not claims of delivery or on-box validation.

### Checkpoint evidence — 2026-09-23 (local, software-only)

This is a later checkpoint, **not a correction to the dated 2026-09-22 observations above**. The local `checkpoint/router-batch-20260923` branch contains prerequisite commit `74726f0` and batch commit `f90d544`; it has not been pushed, merged or deployed. The checkpoint worktree was clean.

| Scope | Observed checkpoint result |
| --- | --- |
| Repository checks | **PASS:** `npm run format && npm run check-all` — TypeScript and build green, 309 unit tests and 14 production tests. These are the later checkpoint counts, not replacements for the 2026-09-22 counts. |
| Native setup, isolated temporary path | **PASS:** `node scripts/setup.mjs` produced `.env` mode 0600, catalogue mode 0644 and data directory mode 0700; the qualification example remained deliberately invalid/fail-closed; a second run refused to overwrite. **NOT RUN:** actual Compose boot from this setup. |
| Native WAL backup/restore, isolated temporary path | **PASS:** round-trip preserved SQLite v5 schema, identity and keys; an invalid source was rejected without mutating the destination; the temporary path was removed. **NOT RUN:** live/on-box or Compose restore. This does not retroactively change the 2026-09-22 restore status. |
| Newer local image and packaging | **PASS:** locally built `llm-router-gateway:checkpoint-20260923` (`linux/amd64`, image ID `sha256:d1fe8431cf795633ab97e27c061d0366281e4599ba397efb0eba8c8e12623c6c`); 12 layers / 9,881 paths audited, 0 sensitive paths. This image is **newer than** the 2026-09-22 `arrival-20260923` image above; neither image is evidence of a push or deployment. |
| Newer isolated container smoke | **PASS:** `--network none`, no published ports, node/tmpfs: `/health/live` 200, `/health/ready` 503 `classifier_unqualified`, chat 503 `classifier_unqualified`; batch unauthenticated 401, key-scoped list/GET, submit 202. SQLite v5; private batch input file mode 0600 outside the database. This is an unqualified, local-only smoke, **not** qualified completion or paid-provider inference. |

**Still NOT RUN at this checkpoint:** actual Compose boot or restore; all B0/B1 on-box gates, including SSD/device groups/IOMMU, runtime discovery/served alias, GPU/offload logs and real generation; representative labelled classifier evaluation and a passing qualification record; qualified local batch completion/idle co-tenancy; optional NPU; paid Jev or DeepInfra inference (no spending approval). Host discovery only: Mimo Lab documentation identifies a `pve4` management host, but the host key, LXC/runtime/model endpoint and served alias are unverified. No SSH, HTTP or GPU call was made; other repositories own bring-up. No Section B physical acceptance has been established.

Command references: [setup.md](setup.md), [runtime-selection.md](runtime-selection.md), [llamacpp.md](llamacpp.md), [halogen.md](halogen.md), [npu.md](npu.md), [ai-hub.md](ai-hub.md), [batch.md](batch.md), [operations.md](operations.md), and the scripts named in those guides.
