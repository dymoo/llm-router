# Deployment catalogues

`MODEL_CATALOG` selects the chat catalogue. `AUXILIARY_CATALOG` optionally selects explicit NPU embedding/transcription deployments. Catalogues contain endpoint/model facts and ranking/accounting configuration, never provider secrets. Restart the gateway after changing them; catalogue content hashes invalidate assessment reuse.

## Local chat

The raw `catalog.example.json` intentionally retains unresolved model sentinels. `setup.mjs --runtime llamacpp|halogen|llamacpp-native|cloud` generates a usable-shaped catalogue from explicit runtime settings, including model alias, endpoint, slots and context. This does not verify installed weights or measured quality. The gateway still refuses unresolved sentinels rather than silently bypassing a broken local entry.

After starting the selected runtime, confirm its API identity and limits. For the native llama.cpp path:

```bash
docker compose exec gateway node /opt/ops/discover-local.mjs http://host.docker.internal:8080
```

Use `/v1/models` for the actual model ID and the running server's configuration for context, output, tools/JSON and reasoning controls. The endpoint is `http://host.docker.internal:8080/v1`, transport `llamacpp`. Runtime health and slot probes correctly use root `/health` and `/slots`.

The model path is a runtime setting, not a gateway deployment field. llama.cpp starts with one slot; Halogen uses its configured runtime slot count. Slot changes must be reflected in both the runtime and catalogue. [Runtime selection](runtime-selection.md) covers matching profiles and safe switching without resetting API-key secrets.

## OpenRouter GLM-5.3-Flash

The selected cloud model is exactly **`z-ai/glm-5.3-flash`**, not base GLM-5.3 or another provider/model substitution. Endpoint `https://openrouter.ai/api/v1`, credential variable `OPENROUTER_API_KEY`.

The example pins `sail-research/fp8` with fallbacks disabled and `require_parameters=true`. Public endpoint metadata inspected on 2026-09-20 advertised:

- Context 1,048,576; maximum completion 131,072.
- Tools including forced tool choice, JSON/structured output and reasoning controls.
- USD per million: input **0.1425**, cached input **0.0285**, output **0.475**.
- `supports_implicit_caching: false`. A cached-input price is not a cache-hit guarantee.

Source: [OpenRouter endpoint catalogue](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints). Prices and endpoint availability can change; refresh them before relying on a spend estimate. No paid completion was used to verify these facts.

Reasoning is configured as binary thinking-on/off, because exact graded backend semantics were not independently established. The gateway reports applied `on`, not an invented high/xhigh execution level. Reasoning-token counts in the catalogue are estimates for ranking, not measured usage.

Cloud quality and latency numbers are explicitly labelled **operator bootstrap priors**, not benchmarks or calibrated success probabilities. `node scripts/setup.mjs --runtime cloud` selects that cloud entry on a fresh installation; it never overwrites an existing catalogue.

## Local accounting and unknown values

The local example's price provenance is `unknown`. Its numeric zeros are not configured COGS. Set input, cached-input and output rates with a meaningful source/date before treating local accounting as known. Explicit configured zero is supported; absent accounting remains null.

Accounting uses observed token counts. Reasoning tokens are already part of completion tokens and are not added twice. Missing cached counts prevent a discount calculation unless cached/uncached rates are equal, in which case the known total does not imply a cache hit. Session affinity and provider pinning are never cache evidence.

A `maxEstimatedUsd` ceiling fails closed when candidate pricing is unknown. Ranking estimates are not invoices and exclude classifier/tool spend.

## Optional NPU catalogue

`catalog.auxiliary.example.json` names `npu-embedding-gemma` and `npu-whisper-turbo`, both sharing `resourceId: strix-halo-npu`. They use the same one-slot admission pool without occupying a GPU permit. Their explicit IDs participate in key allowlists.

The embedding `inputUsdPerMillion` and transcription `requestUsd` accounting rates default to null. The latter is a fixed internal request rate, not an audio-minute price. See [AI hub boundaries](ai-hub.md) for FastFlowLM's placeholder token usage, cancellation and logging limitations.
