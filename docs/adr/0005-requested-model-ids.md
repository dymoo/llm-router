# Requested model: `auto`, `cheap` or a pinned model id

Until now `model` had to be `auto`: the router chose the deployment from the key's policy alone. Callers that know what they want (an abliterated variant for a red-team task, the cheapest path for bulk work, a cloud model for a long context) had no way to say so except calling Gufo or OpenRouter directly, outside accounting and policy. `model` now takes three kinds of value, and `GET /v1/models` lists them all: `auto`, `cheap`, then every catalogued model id and variant (then the System One deployments).

- **`auto`** (and `llm-router/auto`, the provider-prefixed spelling some clients send): today's policy routing, unchanged.
- **`cheap`**: the lowest catalogue price (input + output USD per million) among deployments the key may use, that can serve the request and are up. It then routes as if that deployment were pinned. Catalogue prices are notional for Gufo (an OpenRouter rate card) and advertised for cloud; `cheap` follows the catalogue, not a bill.
- **A model id** (a deployment's `modelId`, or one of its `variants`): that deployment only. The request bypasses the choice and keeps everything else: priority, wait budgets, reserved slots, rate and concurrency limits, accounting. Two consequences are deliberate:
  - A pinned **cloud** model with a cloud-off key, or with a low/flex request (which never use cloud), is refused with **403 `forbidden`** and a message naming the reason. It is never silently rerouted to Gufo, which would answer with a different model than the caller asked for.
  - A pinned **local** model never fails over to cloud, not even when Gufo is down (503 `local_overloaded`): the caller asked for that model, and the outage failover of `auto` would hand back another one.
- **Variants** (`variants` in a catalogue deployment) are extra model ids one runtime process serves from the same weights, sessions and batches, such as Gufo's `qwen3.8-flash-next-abliterated` steering adapter. They are not separate deployments: they share the deployment's capacity pool, health, prices and sessions, and only the upstream `model` differs. A second catalogue entry would double-count Gufo's 24 sessions.

Unknown ids are 400 `invalid`. Model ids and variants must be unique across the catalogue and may not be `auto` or `cheap`. Batch keeps its own batch-catalogue `model` and is unchanged.

**Status:** accepted (2026-10-04)

**Considered options:** (1) keep `auto` only and let callers go direct for special models: rejected, it bypasses keys, accounting and the Gufo capacity pool; (2) router-invented aliases (`local`, `cloud`, `abliterated`): rejected, one canonical name per behaviour, and the upstream id is what clients and logs already show; (3) a variant as its own deployment: rejected, it would double-count capacity and split health; (4) pinning that silently falls back when the pinned model is unavailable: rejected, a caller that names a model must get that model or a clear error.

**Consequences:** `GET /v1/models` lists more than `auto`, so OpenAI-style model pickers (Open WebUI) can offer the pinned ids. A catalogue rename of a `modelId` is now a client-visible API change for anyone pinning it. Session stickiness records the pinned deployment like any other, so a later `auto` turn in the same session prefers it.
