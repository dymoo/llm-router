# Choose llama.cpp or Halogen

Both runtimes are supported through the same gateway API, key policies, task sessions and accounting. Choosing one does not change the cloud tier: OpenRouter `z-ai/glm-5.3-flash` remains configured. No runtime is selected based on a benchmark claim inside the router.

## Supported layouts

| Choice | Generator location | Gateway endpoint | Setup |
| --- | --- | --- | --- |
| `llamacpp` | Compose `llamacpp` profile | `http://llamacpp:8080/v1` | Container compatibility lane |
| `halogen` | Compose `halogen` profile | `http://halogen:8731/v1` | Official HGN + required quality overlay |
| `llamacpp-native` | Native optimized host process | `http://host.docker.internal:8080/v1` | Existing pwilkin isolated-prefix flow |
| `cloud` | No local generator | OpenRouter | Explicit cloud-only configuration |

**Run one full-size GPU runtime at a time on the Strix Halo host.** The profiles are alternatives, not a recommendation to load both large models simultaneously. Laya stays in its own process. NPU/WebUI profiles may be added, subject to shared RAM/bandwidth headroom. Keep IOMMU enabled when using the NPU.

The native gateway (`--native`) uses loopback runtime endpoints by default and a separate `catalog.native.json`; a container's private service DNS is not reachable from the host. If combining a native gateway with containerized Halogen, deliberately publish Halogen's API on loopback or configure a reachable `HALOGEN_ENDPOINT`. Do not expose the unauthenticated engine port.

## Fresh setup: Halogen

```bash
node scripts/setup.mjs --runtime halogen
# Review .env, especially HALOGEN_MODELS_DIR and HALOGEN_CACHE_DIR_HOST.
docker compose up -d --build
```

Setup writes `COMPOSE_PROFILES=halogen` and a matching `catalog.json`. The unmodified `0.12.1` image is pinned by digest. Its first start can download about **118 GiB** into the model directory; set `HALOGEN_DOWNLOAD=` explicitly to disable downloads when supplying weights yourself.

The profile pins `HALOGEN_CK_OVERLAY` to the **quality** sidecar path. The official entrypoint then refuses a missing overlay before starting the engine, instead of silently serving the degraded bare checkpoint. Its model alias, context, slot count and output cap are reflected in the generated catalogue.

```bash
node scripts/halogen-preflight.mjs --compose
docker compose exec gateway node /opt/ops/discover-halogen.mjs http://halogen:8731
```

The preflight checks the checkpoint, tokenizer and current quality-sidecar header. It is not a model-quality or checksum benchmark. A partially completed first download that already left the base checkpoint can require fetching the missing sidecar explicitly; the upstream downloader does not re-download a complete base checkpoint merely because another file is absent.

Relevant settings:

- `HALOGEN_MODEL_ID`: API model ID; default `halogen-qwen3.8-flash-next`.
- `HALOGEN_CTX`: per-request context; default 262,144.
- `HALOGEN_KV_SLOTS`: runtime slots; default 4, mirrored by gateway capacity.
- `HALOGEN_MAX_TOKENS_CAP`: maximum generation request; default 65,536. Per-key caps remain separate.
- `HALOGEN_KV_POOL_POSITIONS`, `HALOGEN_MAX_TOK`: memory/prefill sizing. The pool is shared; slot count does not multiply a complete KV cache per slot. For a co-resident hub, inspect memory headroom before raising limits; `HALOGEN_MAX_TOK=16384` is the documented lower-memory option.
- `HALOGEN_TEMPERATURE=1.0`, `HALOGEN_TOP_P=0.95`, `HALOGEN_TOP_K=20`: documented thinking-mode sampling defaults. A client-supplied temperature, including zero for diagnostics, still wins.

The runtime's active weights and live KV remain in RAM; its large n-gram lookup table is file-backed on local SSD. The optional persistent prompt-cache directory contains sensitive user-derived model state, despite the gateway itself logging metadata only.

## Fresh setup: containerized llama.cpp

```bash
node scripts/setup.mjs --runtime llamacpp
# Set LLAMACPP_MODELS_DIR and LLAMACPP_MODEL_FILE in .env.
docker compose up -d --build
```

The provided image is upstream **b11058**, revision `f072b103714dfa1eee531f80b24512faf38e3dd2`, an AMD64 Vulkan build pinned by digest. This is a reproducible **compatibility lane**, not a claim that it matches the optimized pwilkin/EngramHalo forks' performance. The image and its actual `--help` interface were inspected; no GPU generation was run on this Mac.

`LLAMACPP_IMAGE` and `LLAMACPP_SERVER_BIN` can select a compatible optimized server image. It must provide a POSIX shell and the standard `LLAMA_ARG_*` environment interface. Do not assume another image uses `/app/llama-server`; set the executable explicitly when needed. The already approved optimized native-prefix route remains available without repackaging those builds.

- `LLAMACPP_MODEL_FILE` is a GGUF path relative to `LLAMACPP_MODELS_DIR`; all split shards must be present.
- The model directory must be on local SSD, not tmpfs/network storage.
- `LLAMACPP_MODEL_ID` becomes the explicit server alias (`local-llamacpp` by default).
- `LLAMACPP_CONTEXT` is the server's **total** context; the catalogue conservatively uses `floor(context / slots)` per request.
- `LLAMACPP_SLOTS` starts at 1. Increase only after multi-request correctness/memory validation.
- The standard image uses `LLAMACPP_LOAD_MODE=mmap`, `LLAMACPP_LAZY_MODE=on` for on-demand PLE table reads. A compatible optimized fork may use `none/on-direct`; upstream b11058 does not implement `on-direct`.
- Speculation is explicitly off in the generic container lane until a compatible draft is configured. `LLAMACPP_SPEC_TYPE` and `LLAMACPP_DRAFT_MODEL` expose that choice; draft paths are container paths. The native pwilkin recipe retains its own validated launch defaults.

The launcher refuses a missing model and refuses settings that disable the required SSD-table mode. It does not download a model or silently change a bad configuration. Runtime web UI, outbound model download and built-in agent tools are not enabled; user traffic belongs on the gateway.

```bash
docker compose exec gateway node /opt/ops/discover-local.mjs http://llamacpp:8080
```

## Native optimized llama.cpp

```bash
node scripts/setup.mjs --runtime llamacpp-native
# Install the pinned host prefixes using docs/llamacpp.md.
qwen3.8-strix-halo-server --host 0.0.0.0 --port 8080 --alias local-llamacpp
docker compose up -d --build
```

Firewall 8080 to the private gateway path. For a native gateway too, use `node scripts/setup.mjs --native --runtime llamacpp-native` and load `.env.native`. Native and Compose setup do not overwrite each other's catalogue or secrets.

## Safe switching without resetting keys

`configure-runtime.mjs` prepares a **new** catalogue and refuses to overwrite one. It does not touch the active `.env`, API-key pepper, SQLite database or existing catalogue.

```bash
# Edit the selected runtime's limits/paths in .env first.
node scripts/configure-runtime.mjs halogen --out catalog.halogen.json
# Or:
node scripts/configure-runtime.mjs llamacpp --out catalog.llamacpp.json
```

Then:

1. Drain the gateway: `node scripts/drain.mjs --compose`.
2. Stop the old GPU runtime. For a Compose runtime: `docker compose stop llamacpp` or `docker compose stop halogen`. Stop a native generator explicitly on its host. Wait for GPU memory to be released before loading the other full-size model.
3. Set `MODEL_CATALOG_FILE=./catalog.halogen.json` (or the llama.cpp file) and set **one** GPU profile in `COMPOSE_PROFILES`. Preserve any deliberately enabled `npu,webui` profiles.
4. Start the selected runtime and gateway with `docker compose up -d --build`.
5. Verify its discovery output, `/health/ready`, and one real generation. Existing sessions need a new task/checkpoint after the gateway restart; no live tool trajectory is silently moved between engines.

The deployment IDs are deliberately distinct: `local-halogen` and `local-llamacpp`. If a key has an explicit allowlist, include the intended runtime ID (or both if switching is allowed). An unset allowlist permits configured deployments; an empty list denies all.

Generated quality/latency values are labelled bootstrap priors. Local accounting prices remain unknown until configured. Preserve each runtime's measured rates/priors in its own catalogue; refresh the cloud price snapshot when switching after a long interval.

## Host groups and validation boundaries

Both inspected images have a `video` group but **no named `render` group**. Compose uses numeric `GPU_VIDEO_GID`/`GPU_RENDER_GID` instead. Setup reads device group IDs when run on Linux with the devices present; otherwise the example values must be checked on the AMD host. This avoids Docker failing before the runtime starts because a container group name does not exist.

Adapter HTTP contract tests cover both runtimes: reasoning enabled explicitly, tool calls preserved, token/cache counts normalized, local cost arithmetic, terminal usage exactly once with empty `choices`, and finish reasons retained. Halogen readiness verifies engine PONG, and saturation reads its own admission semaphore rather than gateway counts. Its probe budget accommodates the upstream 30-second PONG deadline. llama.cpp readiness and slot telemetry stay distinct.

**Still hardware-gated:** actual gfx1151 generation, quant/template quality, SSD-table residency/performance, kernel/driver compatibility, and measured concurrency. Do not present protocol fixtures or CLI help output as GPU benchmark results.

Sources: [Halogen v0.12.1 entrypoint](https://github.com/peonist-ai/halogen-flash-server/blob/v0.12.1/deploy/entrypoint.sh), [Halogen README](https://github.com/peonist-ai/halogen-flash-server/blob/v0.12.1/README.md), [llama.cpp container documentation](https://github.com/ggml-org/llama.cpp/blob/f072b103714dfa1eee531f80b24512faf38e3dd2/docs/docker.md).
