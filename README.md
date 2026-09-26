# LLM Router / AI Hub

A self-hosted, key-controlled inference gateway for coding agents and internal chat. Effect 4 owns routing and execution, Drizzle manages SQLite metadata, and Next.js provides the API and administration console.

## What it does

- Routes with explicit classifier-free **Rules** mode, or qualified local **Laya** / **TypeSafe Jev** assessment, using the same deterministic capability, context, budget and locality policy.
- Routes chat to **llama.cpp or Halogen** and **OpenRouter `z-ai/glm-5.3-flash`**. Both local runtimes have supported adapters and selectable Compose configurations.
- Keeps task sessions pinned through tool turns and holds capacity/session ownership until streaming finishes or is cancelled.
- Provides per-key priority and locality/cost/quality/latency controls, bounded non-preemptive queues, API-key rotation/revocation and optional admin HTTP Basic authentication.
- Records metadata analytics: provider-reported cost, token estimates, configured local COGS, observed cache use, classifier reuse, route decisions, queue/TTFT/decode metrics, errors and cancellation. The gateway does **not** store prompts or completions.
- Optionally exposes **NPU embeddings and transcription** with FastFlowLM and an **Open WebUI** frontend. Every client request still goes through gateway policy and accounting.

## Start the console

Node 22.16+; Node 24 is used in the deployment image. From a fresh checkout:

```bash
npm ci
node scripts/setup.mjs --native
node --env-file=.env.native node_modules/next/dist/bin/next dev --hostname 127.0.0.1
```

Open `http://127.0.0.1:3000`. Setup creates private configuration and a random API-key pepper; it refuses to overwrite existing files. The console remains usable while model dependencies are unavailable. Generated runtime settings must match the actual model and launch configuration.

For Compose:

```bash
node scripts/setup.mjs --runtime halogen   # or llamacpp / llamacpp-native
docker compose up -d --build
```

Choose `halogen`, containerized `llamacpp`, or the optimized native `llamacpp-native` path. The gateway defaults to Rules routing without a classifier. CPU Laya is an explicit `laya` Compose profile, separate from the generator; select `CLASSIFIER_MODE=laya` and qualifying evidence when opting in. Optional `npu` and `webui` profiles extend the hub. See [runtime selection and safe switching](docs/runtime-selection.md), [setup](docs/setup.md), and [AI hub services](docs/ai-hub.md). Full-size GPU profiles are alternatives; do not load both simultaneously.

For an explicitly cloud-only fresh installation, use `--runtime cloud` and configure `OPENROUTER_API_KEY`. Ranking priors are not measured success probabilities. No paid fallback or paid readiness probe is performed.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/models` | Authenticated discovery filtered by key permissions |
| `POST /v1/chat/completions` | Routed chat, `model: "auto"`, streaming or JSON |
| `POST /v1/embeddings` | Explicit configured embedding deployment |
| `POST /v1/audio/transcriptions` | Multipart audio to configured STT deployment |
| `GET /v1/requests/:id` | Key-scoped admission/queue/terminal status |
| `POST /v1/batches` | Low-priority batch submit (deferred lane, local-first with OpenRouter Batch spill) |
| `GET /v1/batches/:id`, `GET /v1/batches` | Batch status with retry-safe inline results; key-scoped list |
| `DELETE /v1/batches/:id` | Cancel undispatched batch items and purge held results |
| `GET /health/live` | Process liveness, no model calls |
| `GET /health/ready` | Cached dependency readiness, 503 when chat is unavailable |
| `GET /api/health` | Detailed dependency snapshot for the console |

Inference requires a gateway `jrv_…` Bearer key. The console has no login/session system; network access is administration unless `ADMIN_BASIC_AUTH=username:password` is configured. Keep it on loopback or a trusted private network. Admin mutations additionally require exact Origin and `X-Jev-Admin: 1`.

## Verification

```bash
npm run typecheck
npm test
npm run build
PYTHONPATH=services/laya python -m unittest discover -s services/laya/tests
npm run test:production
```

Tests cover public HTTP contracts, real SQLite migrations/admission/analytics, classifier budgets/caching/cancellation, real Jev SDK HTTP integration, routing/priority/affinity, fragmented streams, accounting, optional modalities and dependency health transitions. Local protocol fixtures are not evidence of GPU/NPU model quality or speed.

The AMD machine has not arrived. Live gfx1151 generation, physical NPU execution, SSD-table performance and hardware concurrency remain on-box acceptance gates. Public OpenRouter model metadata was inspected; no paid inference benchmark was run.

**Classifier quality gate:** real CPU Laya smoke tests exposed misclassification and low local-sufficiency judgments for simple tasks with deployment metadata. The assessment gate remains fail-closed; it was not weakened to hide this. [Diagnostic findings](docs/research/laya-routing-validation.md) are recorded separately. Use explicit [Rules mode](docs/routing-policy.md#rules-mode) without semantic assessment for now, or qualify Laya/Jev before choosing an assessed mode.

**Classifier qualification gate:** Laya/Jev assessment use requires a qualification record with measured per-question Calibration and sourced token rates for the exact backend revision and question schema ([operations](docs/operations.md#classifier-qualification)). Missing or unqualified evidence keeps those modes unready and chat returns `503 classifier_unqualified`. Rules mode constructs no classifier and ignores qualification records; readiness requires persistence and a ready chat deployment. The [assumptions audit](docs/research/classifier-economics-and-gates.md) remains background for assessed modes.

## Read next

- [Operator documentation](docs/index.md)
- [Routing policy](docs/routing-policy.md) and [domain vocabulary](CONTEXT.md)
- [Batch surface](docs/batch.md) — deferred lane, spill rule, result holding
- [Choose llama.cpp or Halogen](docs/runtime-selection.md)
- [Native llama.cpp setup](docs/llamacpp.md)
- [AI hub / Open WebUI](docs/ai-hub.md)
- [EngramHalo research](docs/research/engram-halo.md) and [runtime/concurrency comparison](docs/research/strix-concurrency-comparison.md)
- [Jev assessment design](docs/research/jev-routing.md)

Run one gateway process per SQLite database. Capacity, queue and session ownership are process-local; replicas are not supported.
