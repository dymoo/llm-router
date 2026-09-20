# Halogen runtime

Halogen is a first-class alternative to llama.cpp. Choose it explicitly with `node scripts/setup.mjs --runtime halogen`; the resulting Compose profile and catalogue agree on endpoint, model alias, capacity and limits. [Runtime selection and switching](runtime-selection.md) is the operational entry point.

## Pinned distribution

- Unmodified image: `ghcr.io/peonist-ai/halogen-flash-server:0.12.1@sha256:85ff8c1b2c506c28965cccb5655c07fd111bcf35872f860fcac78bb191897004`.
- Official model repository: `peonist-ai/halogen-qwen3.8-flash-next`.
- Required files: `qwen38-flash-next-w4b.hgn`, `qwen38-flash-next-w4b.overlay.hgn`, and `tokenizer.json`.
- The overlay must be the matching **QUALITY** sidecar, not a throughput-only or stale pre-0.6 sidecar. The preflight checks for current draft projections (`mtp.fc_hidden.weight`) in its header.

The licence permits commercial use and unmodified redistribution; do not publish a modified combined Halogen/router image. Compose references the upstream image unchanged. Gateway rebuilds do not reload it. This restriction is specific to Halogen, not llama.cpp.

Compose sets `HALOGEN_CK_OVERLAY` explicitly. The upstream entrypoint treats a missing explicitly configured overlay as fatal before starting the engine. Do not remove this setting to get past an incomplete download: the bare checkpoint is not the approved quality configuration.

Models bind from `HALOGEN_MODELS_DIR`, caches from `HALOGEN_CACHE_DIR_HOST`. Use local SSD, with adequate space for the approximately 118 GiB initial download and runtime cache. `HALOGEN_DOWNLOAD=` disables automatic downloads; an unset variable selects the documented official repository. Never silently point at a different checkpoint.

## Readiness, slots and accounting

The gateway probes `/health` at the API root, not `/v1/health`. Healthy means HTTP success, `status: "ok"`, and `engine.responds: true`. The upstream health endpoint performs an engine PONG with a 30-second deadline, so the gateway and container allow 35 seconds. Treating a slow PONG as dead after two seconds would incorrectly remove a busy working engine.

`busy` is the runtime's **admission semaphore locked** signal. It means all runtime permits are taken; `in_flight > 0` alone does not prove saturation. The adapter shares a short cached health snapshot between readiness and saturation reads. This is distinct from the gateway's own queue/permit counters.

The adapter sends exactly one token budget, preserves tool calls and response-format constraints, and explicitly sets `enable_thinking` instead of relying on a server default. Applied `high` maps to Halogen `xhigh`. Streaming requests include `stream_options.include_usage`; detached final usage frames remain valid OpenAI SSE with `choices: []`, followed by `[DONE]`. Completion/reasoning counts are not charged twice. Cache counts come from observed usage/timings, including a reported zero, never session affinity.

```bash
node scripts/halogen-preflight.mjs --compose
docker compose exec gateway node /opt/ops/discover-halogen.mjs http://halogen:8731
```

The preflight starts only a short file-inspection process using the service's actual mounts. It does not launch another model engine. Discovery accepts either root or `/v1` URLs, checks both health and model listing, and exits nonzero when either is unusable. Inspect `slot_ctx`, `slots`, and `max_tokens_cap` from live health before admitting production work. The configured four slots are not a guarantee that every four maximum-context requests fit the shared KV pool.

## Host and memory boundaries

The large n-gram table is SSD-backed by the runtime; this is not swap or complete model offload. Hot weights/live KV remain resident. Persistent prompt-cache files are sensitive derived user data even though the gateway stores no transcripts.

Both GPU runtimes require AMD device access on the target Linux host. Compose uses numeric video/render group IDs because the inspected upstream image has no named `render` group. Check them against `/dev/dri` and `/dev/kfd` on the actual host.

Keep IOMMU enabled for the optional FastFlowLM NPU. Historical IOMMU-off prefill tuning disables that NPU path; this repository does not change boot settings automatically. Laya remains a separate CPU classifier unless explicitly configured otherwise.

## Verification boundary

The official image, entrypoint, API implementation and CLI metadata were inspected. HTTP adapter tests exercise Halogen's request/response shapes, health/saturation, tools, reasoning, streamed terminal usage and local accounting. They do **not** establish GPU model quality or throughput. Actual gfx1151 generation, multi-slot fairness/cancellation, SSD behaviour and co-tenancy await the AMD machine.

Sources: [v0.12.1 README](https://github.com/peonist-ai/halogen-flash-server/blob/v0.12.1/README.md), [entrypoint](https://github.com/peonist-ai/halogen-flash-server/blob/v0.12.1/deploy/entrypoint.sh), [licence](https://github.com/peonist-ai/halogen-flash-server/blob/v0.12.1/LICENSE).
