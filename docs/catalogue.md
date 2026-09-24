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

## Optional local Gufo chat

The standalone `catalog.gufo.example.json` is a **schema-decodable template, not an active deployment**. It is not selected by `setup.mjs` or the default `MODEL_CATALOG`. After approval, an operator must merge its entry into the private chat catalogue, replace `REPLACE_GUFO_ENDPOINT` with the approved reachable `/v1` base URL, and inject `GUFO_API_KEY` as a secret environment variable. Never commit the private endpoint or credential. The unresolved sentinel is rejected for inference; a missing credential makes the selected Gufo deployment unavailable rather than silently sending unauthenticated requests. No Gufo deployment or live model-quality qualification is implied by this template.

The deployment ID is `gufo-qwen3.8-flash-next`; the **exact provider model alias** is `qwen3.8-flash-next-gufo` with transport `gufo`, not `llamacpp`, `halogen` or generic `openai-compatible`. Gufo's authenticated `GET /v1/models` must advertise that exact ID; a different alias is not acceptable. Gufo does not inherit llama.cpp root `/health` or `/slots` probes. Context 131,072 and maximum output 8,192 tokens are **provisional catalogue limits** to verify against the approved deployment, not measurements. The adapter caps output with `max_tokens`.

Catalogue `capacity.maxParallel: 2` is a **router admission permit cap**, not evidence of two GPU slots or verified runtime saturation; `reservedInteractiveSlots: 1` caps concurrent medium/low-priority admissions at one, retaining room for high-priority work under the existing gate. It is not a physical GPU lane. Do not infer four slots, machine fullness, or a failover decision from gateway permit occupancy. Gufo advertises tools, but not JSON mode or vision: `capabilities: { tools: true, json: false, vision: false }`. Tool fields are only sent for tool requests. No cache or disk-cache capability is claimed.

Gufo exposes graded `reasoning_effort` `off`, `low`, `medium`, `xhigh`: catalogue `reasoning.levels` are `none`, `low`, `medium`, `xhigh`; `none` maps to `off`. There is no native `high` level (a requested `high` maps upward to `xhigh` under existing effort routing), and no `enable_thinking` switch. Reasoning-token estimates are provisional ranking allowances, not observed usage. The template's quality and latency values are explicitly **unmeasured operator bootstrap priors**, not benchmarks or calibrated task-success probabilities. All three numeric price fields are zero only as schema-compatible placeholders with `prices.provenance.source: "unknown"`: these are **not** a claim of zero operating cost. A key's non-null `maxEstimatedUsd` rejects this candidate until meaningful rates with provenance are configured.

Direct CT134 checks on 2026-09-24, after the backend finished loading, observed: unauthenticated `GET /v1/models` 401; authenticated 200 with only `qwen3.8-flash-next-gufo`; an unknown model 404 `model_not_found`; exact-alias non-streaming and SSE responses reporting that model with final usage; and tool calls with `tool_choice` `auto` or `required`. Gufo rejects OpenAI's named `{type:"function",function:{name}}` form with 400 `invalid_tools`, so the adapter sends exactly the named tool with `tool_choice: "required"`, which is equivalent. During an earlier restart window, the same address briefly returned responses labelled `qwen2.5-0.5b-vulkan-2k`; the adapter therefore rejects any response whose `model` differs from the catalogued alias. The live process had 4 × 131,072 sessions configured at that time; the router still permits two until four-client headroom is verified. These are protocol checks, not quality, latency, or router-routed evidence.

Infra confirmed on 2026-09-24 that the four-session setting was a trial and has been reverted. The live launch is `--sessions 2 --context 131072 --speculative mtp --cache-disk /mnt/ai/gufo-cache`. Four sessions with MTP speculation failed the pve4 memory-headroom gate (7.7 GiB free against an 8 GiB minimum); four without speculation is untested under load. Keep `maxParallel: 2` and `reservedInteractiveSlots: 1` until infra verifies more. The disk-cache flag is set but its benefit is not verified. Open WebUI and the workstation OMP provider also call CT134 directly, so the router's permits cannot see all load on the model. The brief `qwen2.5-0.5b-vulkan-2k` responses came from an infra model-switch restart; the key proxy does not check the served model name, so the router's model check remains necessary.

The synchronous Sail OpenRouter entry remains in `catalog.example.json`, and the DeepInfra batch entry remains in `catalog.batch.example.json`. Neither is replaced by this optional Gufo chat entry.

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
