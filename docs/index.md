# Operator documentation

Compose runs the gateway and CPU Laya, plus explicitly selected `llamacpp` or `halogen` GPU profiles. The optimized native pwilkin route is also supported. Optional `npu` and `webui` profiles extend the hub. Runtime ports stay private; only gateway and WebUI publish loopback ports by default.

| Document | Use |
| --- | --- |
| [setup.md](setup.md) | Secrets, binds and gateway setup |
| [runtime-selection.md](runtime-selection.md) | llama.cpp/Halogen profiles, matching catalogues and safe switching |
| [llamacpp.md](llamacpp.md) | Pinned guide fetch, check-only, install, launch, discovery |
| [routing-policy.md](routing-policy.md) | Locality bias, priority, hard limits (authoritative) |
| [halogen.md](halogen.md) | Official image, mandatory quality overlay and runtime health |
| [npu.md](npu.md) | Optional Ryzen AI 1.8 NPU (not default) |
| [catalogue.md](catalogue.md) | Filling `catalog.json` without invented model IDs or prices |
| [clients.md](clients.md) | OMP / coding-agent session metadata |
| [operations.md](operations.md) | Backup, drain, gateway upgrade, analytics, unverified limits |
| [ai-hub.md](ai-hub.md) | FastFlowLM NPU services, Open WebUI, API boundaries and privacy |
| [research/engram-halo.md](research/engram-halo.md) | SSD-backed PLE, EngramHalo pins and caveats |
| [research/strix-concurrency-comparison.md](research/strix-concurrency-comparison.md) | Toolbox variants, attributed benchmarks and on-box matrix |
| [research/laya-routing-validation.md](research/laya-routing-validation.md) | Actual CPU diagnostics and the outstanding classifier-quality gate |

AMD generation/NPU performance and paid cloud completions are **unverified** here. Identified SQLite v1→v4 migrations, software contracts and local protocol paths are exercised independently of hardware.
