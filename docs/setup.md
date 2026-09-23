# Setup

## What runs

| Service | Image | Published | Default backend |
| --- | --- | --- | --- |
| `gateway` | built from `Dockerfile` | `127.0.0.1:3000` only | Next.js standalone |
| `laya` | built from `Dockerfile.laya` (`python -m laya_service`) | none | CPU (`LAYA_BACKEND=cpu`) |
| `llamacpp` | selected `COMPOSE_PROFILES=llamacpp`, pinned Vulkan compatibility image | none | alternative to the optimized native host path |
| `halogen` | selected `COMPOSE_PROFILES=halogen`, unmodified pinned image | none | official HGN + required quality overlay |
| `fastflowlm` | optional `COMPOSE_PROFILES=npu` | none | NPU embeddings + Whisper |
| `open-webui` | optional `COMPOSE_PROFILES=webui` | `127.0.0.1:3001` | chat/RAG/STT through gateway |

Do not bake a generator into the gateway image. Select one GPU runtime with [runtime selection](runtime-selection.md); the optimized native host route remains supported.

There is **no UI login**. Reachability grants administration unless `ADMIN_BASIC_AUTH` is configured. Inference still requires `jrv_` API keys. Default binds are loopback. Mutations require exact `APP_ORIGIN` and `X-Jev-Admin: 1`.

## Clean machine (CPU classifier, no local generator)

Needs Docker, Node 22.16+, and this tree. Does **not** need AMD GPU, NPU, or paid keys.

```bash
node scripts/setup.mjs
docker compose up -d gateway laya
docker compose ps
```

Gateway starts even if Laya is still pulling weights or is down. The console should load; inference reports not-ready until Laya answers `/healthz`.

`scripts/setup.mjs` writes mode-0600 `.env` with generated secrets and a matching catalogue, refuses overwrite, and creates `./data` mode 0700. Compose catalogues are readable metadata (0644), never secret stores. Use `--runtime cloud` for an explicit cloud-only catalogue and configure an OpenRouter key before inference.

The no-argument default retains the native llama.cpp layout without starting a GPU container. Use `--runtime halogen` or `--runtime llamacpp` when the AMD host and corresponding model files are ready. Generated aliases/limits must match the running engine; bootstrap quality/latency values are not measurements.

## Native (no Docker)

```bash
node scripts/setup.mjs --native
set -a && . ./.env.native && set +a
```

`.env.native` uses `SQLITE_PATH=./data/control.sqlite`, `MODEL_CATALOG=./catalog.native.json`, and `LAYA_URL=http://127.0.0.1:8090`. It does not overwrite Compose configuration. Laya root checkpoint max_len is 512 / head 192; see the [classifier quality gate](research/laya-routing-validation.md) before production routing.

## Strix Halo host (after guide install)

Hardware + pwilkin prefixes first ([llamacpp.md](llamacpp.md)). Then:

```bash
qwen3.8-strix-halo-server --host 0.0.0.0 --port 8080 --alias local-llamacpp   # private bind + firewall
node scripts/setup.mjs --runtime llamacpp-native
docker compose up -d
docker compose exec gateway node /opt/ops/discover-local.mjs http://host.docker.internal:8080
```

This tree does not change bootloaders. Keep IOMMU enabled when using FastFlowLM/XDNA2. Historical IOMMU-off GPU benchmarks are not a requirement for this hub.

## Binding the UI

| Intent | `GATEWAY_BIND` | `APP_ORIGIN` |
| --- | --- | --- |
| This machine only (default) | `127.0.0.1` | `http://127.0.0.1:3000` |
| Private LAN | the LAN IP | `http://<that-ip>:3000` exactly |

Never publish `0.0.0.0` on a public interface. LAN reachability is admin access unless `ADMIN_BASIC_AUTH` is set. The browser shows a native Basic challenge; there is no login form. Enable HTTPS if the hop is not a trusted private network.

## Environment

| Name | Role |
| --- | --- |
| `APP_ORIGIN` | Exact UI origin for CSRF / same-origin checks |
| `API_KEY_PEPPER` | HMAC pepper for inference API keys; generated |
| `ADMIN_BASIC_AUTH` | Optional `username:password` for UI+admin API only; absent = no gate; malformed = refuse startup |
| `SQLITE_PATH` | Control-plane SQLite |
| `MODEL_CATALOG` | Runtime catalogue path |
| `MODEL_CATALOG_FILE` | Host file bound into the Compose gateway as its chat catalogue |
| `COMPOSE_PROFILES` | Selected GPU runtime and optional `npu,webui` services |
| `LAYA_URL` | `http://laya:8090` on Compose; `http://127.0.0.1:8090` native |
| `CLASSIFIER_MODE` | `laya` or `jev` only. No automatic fallback. |
| `CLASSIFIER_QUALIFICATION_FILE` | Host selector for the qualification record bound read-only into the gateway (default `./classifier-qualification.example.json` — keep the `./` prefix in short syntax; the mount itself is long-syntax bind, so bare-relative or absolute paths are safe). The shipped example has `verdict: fail` + `REPLACE_` placeholders so the default can never pass the gate. A real record is never generated: keep it outside the repository or under the ignored `./data/` directory, verify the chosen path is excluded from Git and the Docker build context, and never stage it. Only the literal root `classifier-qualification.json` is ignored by default; an arbitrary custom path is **not** automatically excluded |
| `CLASSIFIER_QUALIFICATION` | Native-only local path to the qualification records; absent by default = no evidence, fail-closed `unqualified` routing. On Compose the gateway instead uses the pinned container path `/etc/llm-router/classifier-qualification.json` (same precedence as `MODEL_CATALOG`, overrides any `.env` value), mounted `:ro` from `CLASSIFIER_QUALIFICATION_FILE` |
| `TYPESAFE_API_KEY` | Required only for `jev` |
| `LAYA_MODEL_REVISION` | Pinned snapshot `1c5edc17a7acd8701df6fc341c0d179f1c62c982` |
| `HALOGEN_DOWNLOAD` | First-boot weights repo; passed into the unmodified Halogen image |
| Catalogue `credentialEnvVar` | Secret variable name, e.g. `OPENROUTER_API_KEY`; never put the credential itself in a catalogue |
| `AUXILIARY_CATALOG` | Optional NPU deployment catalogue; absent disables modality deployments |
| `WEBUI_GATEWAY_KEY`, `WEBUI_SECRET_KEY` | Dedicated inference credential and stable WebUI secret |

## Optional AI hub services

Follow [ai-hub.md](ai-hub.md) for FastFlowLM host prerequisites, NPU profile activation, supported embedding/transcription formats, Open WebUI configuration and separate conversation retention.

## Local verification

`npm run format && npm run check-all`, Python service tests, and `docker compose --profile llamacpp --profile halogen --profile npu --profile webui config --quiet` validate software/configuration. The last command validates syntax only: do not launch both full-size GPU profiles together. Build the gateway and optional FastFlowLM image separately. Hardware acceptance remains on-box after the AMD machine arrives.
