# Setup

## What runs

| Service      | Image                                   | Published             | Role                                           |
| ------------ | --------------------------------------- | --------------------- | ---------------------------------------------- |
| `gateway`    | built from `Dockerfile`                 | `127.0.0.1:3000` only | API server + static console (`runner` target)  |
| `open-webui` | `ghcr.io/open-webui/open-webui:v0.11.3` | `127.0.0.1:3001`      | optional `webui` profile; chat through gateway |

The model runtime is Gufo on the owner's GPU host. It is reached over HTTP with a bearer key and is not a Compose service. Gufo host operations live in the owner's infra repository.

There is **no UI login**. Reachability grants administration; gate the console with an authenticating reverse proxy (for example Authentik forward auth) when it leaves loopback. Inference still requires `jrv_` API keys. Default binds are loopback. Mutations require exact `APP_ORIGIN` and `X-Jev-Admin: 1`.

## Compose

Needs Docker, Node 22.16+, and this tree.

```bash
node scripts/setup.mjs --gufo-endpoint https://gufo.example/v1
docker compose up -d --build gateway
docker compose ps
```

`scripts/setup.mjs` writes mode-0600 `.env` with a generated `API_KEY_PEPPER` and `WEBUI_SECRET_KEY`, and `catalog.json` from `catalog.example.json`: Gufo (24 permits, 4 reserved for high keys) plus OpenRouter `cloud-glm`. It refuses to overwrite either file and creates `./data` mode 0700. `--gufo-endpoint` must be an HTTP(S) URL without credentials, query or fragment; setup appends `/v1` when missing. Without it the catalogue keeps `REPLACE_GUFO_ENDPOINT`, and the router refuses inference until the endpoint is set. Compose catalogues are readable metadata (0644), never secret stores.

Then set `GUFO_API_KEY` (Gufo's `--api-key-file` value) and `OPENROUTER_API_KEY` in `.env`. The console loads without them; readiness needs persistence and at least one healthy chat deployment. For a cloud-only install, delete the Gufo entry from `catalog.json`.

Gufo must advertise the catalogued model ID on its authenticated `GET /v1/models`; see [catalogue.md](catalogue.md#gufo-chat).

Routing needs no further configuration: each key's `priority` and `cloud` decide it ([routing-policy.md](routing-policy.md)). Only keys with `cloud` ever reach OpenRouter.

## Native (no Docker)

```bash
node scripts/setup.mjs --native --gufo-endpoint https://gufo.example/v1
set -a && . ./.env.native && set +a
```

`.env.native` uses `SQLITE_PATH=./data/control.sqlite`, `MODEL_CATALOG=./catalog.native.json` and `BATCH_CATALOG=./catalog.batch.example.json`. It does not overwrite Compose configuration.

## Binding the UI

| Intent                      | `GATEWAY_BIND` | `APP_ORIGIN`                    |
| --------------------------- | -------------- | ------------------------------- |
| This machine only (default) | `127.0.0.1`    | `http://127.0.0.1:3000`         |
| Private LAN                 | the LAN IP     | `http://<that-ip>:3000` exactly |

Never publish `0.0.0.0` on a public interface. LAN reachability is admin access: expose only `/v1` and `/health` directly and put everything else behind an authenticating proxy. Enable HTTPS if the hop is not a trusted private network.

## Environment

| Name                                    | Role                                                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_ORIGIN`                            | Exact UI origin for CSRF / same-origin checks                                                                                                                                                                                        |
| `API_KEY_PEPPER`                        | HMAC pepper for inference API keys; generated                                                                                                                                                                                        |
| `SQLITE_PATH`                           | Control-plane SQLite                                                                                                                                                                                                                 |
| `MODEL_CATALOG`                         | Chat catalogue path                                                                                                                                                                                                                  |
| `MODEL_CATALOG_FILE`                    | Host file bound into the Compose gateway as its chat catalogue                                                                                                                                                                       |
| `COMPOSE_PROFILES`                      | `webui` to add Open WebUI; empty for the gateway alone                                                                                                                                                                               |
| `GUFO_API_KEY`                          | Gufo bearer key, named by the Gufo chat and Kev deployments' `credentialEnvVar`                                                                                                                                                      |
| Catalogue `credentialEnvVar`            | Secret variable name, e.g. `GUFO_API_KEY` or `OPENROUTER_API_KEY`; never put the credential itself in a catalogue                                                                                                                    |
| `AUXILIARY_CATALOG`                     | Optional System One catalogue (Kev on Gufo, Jev on TypeSafe); absent disables `/v1/systemone`. `/etc/llm-router/auxiliary.json` on Compose                                                                                           |
| `AUXILIARY_CATALOG_FILE`                | Host file, relative to the checkout, bound read-only at `/etc/llm-router/auxiliary.json` (default `catalog.auxiliary.example.json`)                                                                                                  |
| `BATCH_RESULTS_DIR`                     | Optional batch result-holding directory override; unset defaults to `dirname(SQLITE_PATH)/batch-content` beside the metadata DB — dedicated store outside `control.sqlite`/Analytics, see [batch.md](batch.md)                       |
| `BATCH_CATALOG`                         | In-gateway path of the batch-only deployment catalogue (`/etc/llm-router/batch-catalog.json` on Compose, `./catalog.batch.example.json` native; `cloud-glm-batch` → `z-ai/glm-5.3-flash` via `deepinfra/fp4`) — [batch.md](batch.md) |
| `BATCH_CATALOG_FILE`                    | Host file bound read-only into the gateway as the batch catalogue (`${BATCH_CATALOG_FILE:-./catalog.batch.example.json}:/etc/llm-router/batch-catalog.json:ro`); never merged into the synchronous chat catalogue                    |
| Batch limits (no env)                   | Fixed code constants: 1000 items/job, 512 KiB/item, 32 MiB/job, 4 in-flight jobs/key, `deadline_at` = spill + 24 h provider window, 24 h result TTL after terminal, 64/256 MiB result budgets — [batch.md](batch.md)                 |
| `WEBUI_GATEWAY_KEY`, `WEBUI_SECRET_KEY` | Dedicated inference credential and stable WebUI secret                                                                                                                                                                               |

## Open WebUI and System One

Follow [ai-hub.md](ai-hub.md) for Open WebUI configuration, its separate conversation retention, and enabling System One.

## Local verification

`npm run format && npm run check-all` and `docker compose --profile webui config --quiet` validate software and configuration. Neither measures Gufo.
