# Open WebUI and System One

## Topology

The gateway owns API keys, admission, priority, model permissions, request metadata and accounting. Clients never receive provider credentials or call the model runtime directly.

- Chat: `POST /v1/chat/completions`, `model: "auto"`, routed to Gufo or OpenRouter GLM-5.3-Flash.
- Discovery: authenticated `GET /v1/models`; lists `auto` when a chat deployment is allowed, plus permitted System One deployment IDs. It also returns a TypeSafe `models` list for TypeSafe SDKs. Discovery does not consume an inference admission.
- System One: `POST /v1/systemone`, answered by a named Kev or Jev deployment.

## System One

`POST /v1/systemone` takes TypeSafe System One requests unchanged: a `state` and 1–128 typed `questions`. A TypeSafe SDK works with its base URL set to the router and a router key as its API key. `model` names a System One deployment, `kev-latest` or `jev-latest`; it defaults to `kev-latest`. The router never substitutes Kev for Jev or the reverse.

System One requests are not assessed. Their explicit model determines the route. They still use the same key admission, expiry/revocation checks, allowlists, concurrent/RPM limits, cost ceilings, priority queue, status polling and metadata analytics. They never fall back to chat or another deployment. Deployments with the same `resourceId` share one permit pool.

To enable it:

1. Copy `catalog.auxiliary.example.json` to a private file in the checkout and replace `REPLACE_GUFO_ENDPOINT` with Gufo's `/v1` base. Add a Jev entry if wanted; see [catalogue.md](catalogue.md#system-one-kev-and-jev).
2. In `.env`, set `AUXILIARY_CATALOG_FILE` to that file and `AUXILIARY_CATALOG=/etc/llm-router/auxiliary.json`. Native installs set `AUXILIARY_CATALOG` to the file path.
3. Make sure `GUFO_API_KEY` (and `TYPESAFE_API_KEY` for Jev) is set, then restart the gateway.

System One deployments are optional in health: an unreachable one shows as degraded without making chat unready. `CLASSIFIER_MODE=kev` reuses the Kev deployment as the Classifier; see [operations](operations.md#routing-mode-configuration).

## Open WebUI

Optional profile `webui`, pinned image `ghcr.io/open-webui/open-webui:v0.11.3`, default URL `http://127.0.0.1:3001`.

1. Create a dedicated inference key in the gateway console. A medium-priority policy is a reasonable starting point. Its allowlist must include the intended chat deployment IDs.
2. Put that key in `.env` as `WEBUI_GATEWAY_KEY`. **Never use the OpenRouter key.** `scripts/setup.mjs` generates `WEBUI_SECRET_KEY`; existing installations can generate a fresh stable value locally using a cryptographic random generator.
3. Run `docker compose --profile webui up -d open-webui`.

The Open WebUI connection points to `http://gateway:3000/v1`. Ollama and browser-direct connections are disabled. Environment configuration remains authoritative (`ENABLE_PERSISTENT_CONFIG=False`), avoiding a stale database connection silently bypassing the gateway after a restart. The model picker exposes `auto`. The gateway serves no embedding or speech-to-text model, so the profile sets `BYPASS_EMBEDDING_AND_RETRIEVAL=True`.

The profile uses **no Open WebUI login** and binds to loopback, matching this internal single-user deployment. Anyone with network access to it can use its configured gateway key and read its stored conversations. Put authentication/TLS in front of either service before exposing it beyond a trusted network.

### Continuity and privacy

The connection forwards only `X-OpenWebUI-Chat-Id` through per-connection templating; user name/email/role headers are not enabled. The gateway namespaces that advisory chat ID by the authenticated key. A first turn starts a task; subsequent assistant-history turns continue the pinned route. Explicit `routing` metadata takes precedence.

When changing the WebUI bind/port, set `WEBUI_ORIGIN` to the exact browser origin as well. The supplied profile restricts CORS to that origin rather than using `*`.

Automatic title/tag/follow-up generation is disabled so background helper prompts do not contend for or replace the same trajectory pin. Pins live in gateway memory. After a restart, pin expiry, or changed tools/system instructions, the next Open WebUI turn routes afresh at a checkpoint instead of failing. In Kev/Jev modes, a very large initial task still needs an explicit classifier brief; no history is silently shortened.

Open WebUI intentionally stores conversations and uploaded-document state in its separate `webui-data` volume. **The gateway still stores metadata only.** These are distinct retention and backup domains. One configured WebUI key means all WebUI activity shares that key's limits and analytics; individual-user billing is not claimed.

Configuration source: [Open WebUI environment reference](https://docs.openwebui.com/reference/env-configuration/).
