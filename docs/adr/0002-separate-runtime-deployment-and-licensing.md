# Adapter-based local generation: llama.cpp and Halogen

**Status:** accepted; updated to make both runtimes first-class choices.

The router is not a model runtime. llama.cpp and Halogen run in separate processes, have independently selected adapters and catalogues, and can be deployed through mutually alternative Compose profiles. The optimized pwilkin llama.cpp/isolated ROCr-HIP host installation remains supported. The pinned upstream Vulkan container is a compatibility option, not a performance substitute for optimized forks.

This supersedes both “Halogen required by default” and the later “llama.cpp primary, Halogen merely optional” direction. The operator can choose either without changing gateway API or key/accounting semantics. Selection is explicit, never a silent fallback between local engines. Cloud routing remains an independent policy decision.

Halogen uses the unmodified official image, official HGN checkpoint and matching quality overlay. Its redistribution restriction applies to that image only. HGN weights are not portable to llama.cpp. Neither runtime belongs inside the gateway image: gateway upgrades must not force a large model reload.

For both runtimes the large PLE/n-gram table stays SSD-backed while hot weights and live KV remain in RAM. Keep IOMMU enabled for optional XDNA2 services. No bootloader changes or AMD hardware benchmark claims are made by this repository.

**Consequences:** runtime limits and catalogue capacity must agree; switching drains requests and stops the previous GPU engine before loading the other. Full-size engines are not co-loaded by default. Actual hardware/model quality remains an on-box acceptance gate. Procedures: [runtime selection](../runtime-selection.md), [llama.cpp](../llamacpp.md), [Halogen](../halogen.md), [NPU](../npu.md), [operations](../operations.md).
