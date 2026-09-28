# LLM Router

A self-hosted, key-controlled inference gateway for coding agents and internal chat. Effect 4 owns routing and execution, Drizzle manages SQLite metadata, and Next.js provides the API and administration console.

## What it does

- Routes by one small key policy: `priority` (high, medium, low) and a `cloud` switch, plus rate and concurrency limits. High and medium run on Gufo first and wait a short budget (5 s / 30 s); keys with `cloud` then fall back to OpenRouter, others get `503 local_overloaded`.
- Routes chat to **Gufo** (the owner's private GPU inference server, Qwen3.8 Flash-Next) and **OpenRouter `z-ai/glm-5.3-flash`**. Gufo is reached over HTTP with a bearer key; it is not part of this repository. A generic `openai-compatible` transport covers another local OpenAI server.
- Keeps a session on the deployment its last turn used (best effort) and holds capacity until streaming finishes or is cancelled.
- Low-priority keys (and `service_tier: "flex"`) run as Gufo **flex**: idle local compute only, never cloud, queued FIFO by the router for up to 10 minutes. Queues are bounded and non-preemptive; keys rotate and revoke.
- Records metadata analytics: provider-reported cost, token estimates, configured local COGS, observed cache use, route decisions, queue/TTFT/decode metrics, errors and cancellation. The gateway does **not** store prompts or completions.
- Proxies TypeSafe **System One** (`POST /v1/systemone`) to Kev on Gufo or TypeSafe's cloud Jev, and serves an optional **Open WebUI** frontend. Every client request still goes through gateway policy and accounting.

## Start the console

Node 22.16+; Node 24 is used in the deployment image. From a fresh checkout:

```bash
npm ci
node scripts/setup.mjs --native --gufo-endpoint https://gufo.example/v1
node --env-file=.env.native node_modules/next/dist/bin/next dev --hostname 127.0.0.1
```

Open `http://127.0.0.1:3000`. Setup creates private configuration, a random API-key pepper and a catalogue with the Gufo and OpenRouter deployments; it refuses to overwrite existing files. Without `--gufo-endpoint` the catalogue keeps `REPLACE_GUFO_ENDPOINT`, and the router refuses inference until it is replaced. Set `GUFO_API_KEY` and `OPENROUTER_API_KEY` in the environment file. The console remains usable while model dependencies are unavailable.

For Compose:

```bash
node scripts/setup.mjs --gufo-endpoint https://gufo.example/v1
docker compose up -d --build gateway
```

Compose runs the gateway, plus Open WebUI behind the `webui` profile. Gufo is not a Compose service. See [setup](docs/setup.md) and [Open WebUI and System One](docs/ai-hub.md).

For a cloud-only installation, delete the Gufo entry from the generated catalogue, configure `OPENROUTER_API_KEY`, and give keys `cloud: true`. Only keys with `cloud` ever reach a paid provider; no paid readiness probe is performed.

## API

| Endpoint                                 | Purpose                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /v1/models`                         | Authenticated discovery: `auto` and the System One deployments                     |
| `POST /v1/chat/completions`              | Routed chat, `model: "auto"`, streaming or JSON                                    |
| `POST /v1/systemone`                     | TypeSafe System One, answered by a named Kev or Jev deployment                     |
| `GET /v1/requests/:id`                   | Key-scoped admission/queue/terminal status                                         |
| `POST /v1/batches`                       | Low-priority batch submit (deferred lane, local-first with OpenRouter Batch spill) |
| `GET /v1/batches/:id`, `GET /v1/batches` | Batch status with retry-safe inline results; key-scoped list                       |
| `DELETE /v1/batches/:id`                 | Cancel undispatched batch items and purge held results                             |
| `GET /health/live`                       | Process liveness, no model calls                                                   |
| `GET /health/ready`                      | Cached dependency readiness, 503 when chat is unavailable                          |
| `GET /api/health`                        | Detailed dependency snapshot for the console                                       |

Inference requires a gateway `jrv_…` Bearer key. The console has no login/session system; network access is administration. Keep it on loopback, or put an authenticating proxy such as Authentik forward auth in front of everything except `/v1` and `/health`. Admin mutations additionally require exact Origin and `X-Jev-Admin: 1`.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run test:production
```

Tests cover public HTTP contracts, real SQLite migrations/admission/analytics, routing tiers/wait budgets/flex queue/stickiness, fragmented streams, accounting, batch spill, System One and dependency health transitions. Local protocol fixtures are not evidence of Gufo model quality or speed. Public OpenRouter model metadata was inspected; no paid inference benchmark was run.

## Read next

- [Operator documentation](docs/index.md)
- [Routing policy](docs/routing-policy.md) and [domain vocabulary](CONTEXT.md)
- [Batch surface](docs/batch.md) — deferred lane, spill rule, result holding
- [Open WebUI and System One](docs/ai-hub.md)

Run one gateway process per SQLite database. Capacity, queues and sessions are process-local; replicas are not supported.
