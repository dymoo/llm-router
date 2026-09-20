# Optional NPU services and Open WebUI

## Topology and decision

The gateway owns API keys, admission, priority, model permissions, request metadata and accounting. Clients never receive provider credentials or call the model runtimes directly.

- Chat: `POST /v1/chat/completions`, `model: "auto"`, routed to the native llama.cpp deployment or explicitly configured OpenRouter GLM-5.3-Flash.
- Discovery: authenticated `GET /v1/models`; lists `auto` when a chat deployment is allowed and permitted configured auxiliary model IDs. Discovery does not consume an inference admission.
- Embeddings: `POST /v1/embeddings`, explicit `npu-embedding-gemma`.
- Speech-to-text: multipart `POST /v1/audio/transcriptions`, explicit `npu-whisper-turbo`.

Auxiliary requests do not need semantic classification. Their modality and explicit model determine the route. They still use the same SQLite key admission, expiry/revocation checks, allowlists, concurrent/RPM limits, estimate ceilings, priority queue, status polling and metadata analytics. They never spill to GPU or cloud.

The two auxiliary deployments share a single `resourceId` and a one-permit NPU pool. This conservatively serializes embedding/transcription work until the incoming machine is measured. They can run alongside GPU chat, but all processors share RAM and memory bandwidth. Independent compute engines do not imply independent memory budgets.

## FastFlowLM runtime

Pinned release: [ROCm/FastFlowLM v1.0.6](https://github.com/ROCm/FastFlowLM/releases/tag/v1.0.6). `Dockerfile.fastflowlm` installs the official Ubuntu 24.04 AMD64 package with SHA-256 verification and the AMD XRT packages from the upstream-documented Lemonade PPA. The upstream Dockerfile is a build environment, not a ready-to-serve inference image; this repository supplies the runtime packaging.

The image was built locally and its `flm help` command executed under AMD64 emulation. **NPU inference and device passthrough have not been verified: the AMD host has not arrived.** A successful image build is not hardware acceptance.

Host requirements from [the pinned Linux guide](https://github.com/ROCm/FastFlowLM/blob/v1.0.6/docs/docs/install_lin.md):

- AMD XDNA2, including Strix Halo / Ryzen AI Max 300.
- IOMMU **enabled**. Do not apply the historical `amd_iommu=off` GPU benchmark setting to this NPU-enabled hub.
- Kernel 7.0+ with `amdxdna`, or the appropriate `amdxdna-dkms` stack.
- Firmware 1.1.0.0 or later, XRT and the AMD XDNA plugin.
- `/dev/accel/accel0` accessible; unlimited memlock.
- Both `flm validate` and `xrt-smi examine` must work. The former tests the DRM path; it does not establish XRT visibility.

Compose passes only `/dev/accel/accel0`, not `/dev/kfd` or GPU render devices. The container runs its NPU services on the private Compose network, with no host-published runtime port. No bootloader, firmware, kernel or host driver changes are performed by this project.

`flm serve -e 1 -a 1 --host 0.0.0.0 --port 52625 --q-len 1 --cors 0 --quiet` starts the two auxiliary model types without a chat model. The dedicated Whisper documentation and the v1.0.6 server constructor support standalone ASR; an older paragraph in the general CLI guide still says an LLM is required. Prefer the pinned implementation and modality-specific docs over that stale paragraph.

Powered by FastFlowLM. Review the upstream [runtime license](https://github.com/ROCm/FastFlowLM/blob/v1.0.6/LICENSE_RUNTIME.txt), [terms](https://github.com/ROCm/FastFlowLM/blob/v1.0.6/TERMS.md), and model licenses before redistribution or commercial deployment; the orchestration and distributed NPU binaries do not all have identical licensing.

### Enable on the AMD host

1. Complete host driver/firmware validation. Keep the native GPU runtime in its isolated prefix.
2. Copy `catalog.auxiliary.example.json` to `catalog.auxiliary.json` if changing endpoint limits or internal accounting rates. Set `AUXILIARY_CATALOG_FILE=catalog.auxiliary.json` in `.env`; otherwise the unchanged example is mounted.
3. Set `AUXILIARY_CATALOG=/etc/llm-router/auxiliary.json` in `.env`.
4. Run `docker compose --profile npu up -d --build fastflowlm gateway`.
5. Wait for the runtime to download/load EmbeddingGemma and Whisper. Inspect `/api/health`; run one embedding and one short known transcription through the gateway with a dedicated key.

Disable the catalogue environment variable as well as the profile when removing the NPU services. A configured but unavailable auxiliary endpoint is visible as degraded, without making healthy chat unavailable.

## Model and API boundaries

### EmbeddingGemma

`embed-gemma:300m` is the upstream EmbeddingGemma 300M deployment. Gateway input accepts one nonempty string or an array of strings, with float output. Token arrays, base64 output and dimension overrides are rejected rather than silently ignored.

The configured runtime limit is 2,048 tokens per item. Without a published FLM tokenizer endpoint, admission uses a conservative UTF-8-byte bound plus special-token reserve. This can reject text that the tokenizer would fit; it never deliberately truncates it. Split documents into smaller chunks. The example limits batches to 16; Open WebUI uses batch size 1 and 400-character chunks.

Pinned-source caveats from [`handle_embeddings`](https://github.com/ROCm/FastFlowLM/blob/v1.0.6/src/server/rest_handler.cpp):

- FLM hardcodes `prompt_tokens: 0` and `total_tokens: 0` even for nonempty embedding input. The gateway treats that as **unknown**, not a measured free request. Unknown token fields and cost remain null.
- The handler calls the embedding engine with its query task type. Retrieval quality with document/query asymmetry must be evaluated before relying on this backend for a large corpus.
- FLM prints embedding inputs to stdout. This profile uses Docker's `logging.driver: none` so those inputs are not retained in container logs. Do not override logging without accepting transcript/data capture.

### Whisper Turbo

`whisper-v3:turbo` is the selected transcription backend. Input is bounded multipart audio, at most 25 MiB. Responses support `json` and `text`. The pinned FLM handler auto-detects language and does not implement forced-language, prompt, temperature or verbose-timestamp options; unsupported controls receive 400 rather than being silently discarded.

The handler does not report trustworthy audio/token usage and does not observe its cancellation token during transcription. Therefore:

- Token counts stay unknown. The optional `requestUsd` is an explicitly configured **per-request internal accounting rate**, not an audio-minute price or provider charge. Leave it null if no such rate is wanted.
- Once dispatched, the gateway retains the NPU permit until FLM responds or the bounded upstream deadline expires, even if the client disconnects. Cancelling a queued request prevents dispatch. Runtime queue length is bounded separately.
- FLM prints transcript text. The same no-container-log policy applies.

### Why not Gemma4 E4B for ordinary transcription?

Ordinary Gemma4 E4B supports audio understanding as well as text/images and can be evaluated for semantic audio tasks. That does not establish matched transcription quality against Whisper Turbo on this NPU. The Flash Gemma variant is especially unsuitable as the default: its documented 1K context and 30-second audio truncation limit differ materially from the ordinary model, and tool support is restricted. No matched NPU quality benchmark was run here. Keep Whisper for STT; treat Gemma audio understanding as a separate future model evaluation, not a silent replacement.

Sources: [Whisper](https://fastflowlm.com/docs/models/whisper/), [EmbeddingGemma](https://fastflowlm.com/docs/models/embeddinggemma/), [Gemma variants](https://fastflowlm.com/docs/models/gemma/).

## Open WebUI

Optional profile `webui`, pinned image `ghcr.io/open-webui/open-webui:v0.11.3`, default URL `http://127.0.0.1:3001`.

1. Create a dedicated inference key in the gateway console. A medium-priority policy is a reasonable starting point. Its allowlist must include the intended chat deployment IDs and both NPU IDs for RAG/STT.
2. Put that key in `.env` as `WEBUI_GATEWAY_KEY`. **Never use the OpenRouter key.** `scripts/setup.mjs` generates `WEBUI_SECRET_KEY`; existing installations can generate a fresh stable value locally using a cryptographic random generator.
3. Run `docker compose --profile webui up -d open-webui`. Add `--profile npu` when using local RAG/STT.

All three Open WebUI connections point to `http://gateway:3000/v1`. Ollama and browser-direct connections are disabled. Environment configuration remains authoritative (`ENABLE_PERSISTENT_CONFIG=False`), avoiding a stale database connection silently bypassing the gateway after a restart. The chat model picker exposes `auto`, not embedding or ASR models.

The profile uses **no Open WebUI login** and binds to loopback, matching this internal single-user deployment. Anyone with network access to it can use its configured gateway key and read its stored conversations. `ADMIN_BASIC_AUTH` protects the gateway console, not Open WebUI. Put authentication/TLS in front of either service before exposing it beyond a trusted network.

### Continuity and privacy

The connection forwards only `X-OpenWebUI-Chat-Id` through per-connection templating; user name/email/role headers are not enabled. The gateway namespaces that advisory chat ID by the authenticated key. A first turn starts a task; subsequent assistant-history turns continue the pinned route. Explicit `routing` metadata takes precedence.

When changing the WebUI bind/port, set `WEBUI_ORIGIN` to the exact browser origin as well. The supplied profile restricts CORS to that origin rather than using `*`.

Automatic title/tag/follow-up generation is disabled so background helper prompts do not contend for or replace the same trajectory pin. Changed tools/system instructions or an expired pin fail with an explicit boundary/session error; they do not silently migrate a live task. Start a new chat after a gateway restart. A very large initial task still needs an explicit classifier brief or an explicitly selected classifier that can fit it; no history is silently shortened.

Open WebUI intentionally stores conversations and uploaded-document state in its separate `webui-data` volume. **The gateway still stores metadata only.** These are distinct retention and backup domains. One configured WebUI key means all WebUI activity shares that key's limits and analytics; individual-user billing is not claimed.

Configuration source: [Open WebUI environment reference](https://docs.openwebui.com/reference/env-configuration/).
