# Strix Halo llama.cpp runtimes (gfx1151)

**Date:** 2026-09-20  
**Scope:** Primary-source inventory for an adapter-based gateway. No application/deployment edits. No install, hardware benchmarks, tests, or paid calls. GitHub files via `gh file_read`.  
**Operator decision (this conversation):** follow the pwilkin Flash-Next guide, not pick a winner among forks. Main owns packaging (native prefixes vs reproduce-container). Do not author a new runtime.

Facts, recommendations, and unknowns are separated. Throughput numbers are quoted with their published conditions; they are not measurements of this repo.

---

## Answer

**Yes.** There are maintained gfx1151 performance forks of llama.cpp, plus upstream HIP/Vulkan builds, plus toolbox/installer packaging. They are not interchangeable.

**Follow (operator-approved):** [`pwilkin/llama.cpp`](https://github.com/pwilkin/llama.cpp) branch `strix-halo` at the pin in [`pwilkin/strix-halo`](https://github.com/pwilkin/strix-halo) `install-flash-next.sh` → `install.sh` `STRIX_PROFILE=flash-next`. That is a **HIP/ROCm engine fork** plus a **native installer** (packaging), not a container image.

**Current model on that pin:** Hugging Face [`ilintar/qwen3.8-flash-next-gguf-strix-halo`](https://huggingface.co/ilintar/qwen3.8-flash-next-gguf-strix-halo) — architecture `qwen4exp` (Qwen3.8-Flash-Next), **IQ4_NL PROJFIX**, not NGQ4, not Q6_K, not the dense Qwen3.8-27B profile.

**NGQ4:** a *quant recipe* (IQ4_XS bulk + Q6_K lm_head + Q4_0 PLE), not a GGUF tensor type. Zero hits for `NGQ4` in `pwilkin/llama.cpp` and `ggml-org/llama.cpp` code search. Do not swap the pinned IQ4_NL weights for NGQ4 without a new evaluation.

No deployment selection is implemented here.

---

## Follow this stack (pwilkin Flash-Next)

Primary docs:

| What | URL |
| --- | --- |
| Lab landing (three layers: retained-PM4 HIP, llama.cpp, two Qwen3.8 models) | https://pwilkin.github.io/strix-halo/ |
| Prefill journey (commit-by-commit, protocol stated) | https://pwilkin.github.io/strix-halo/journey.html |
| Installer repo | https://github.com/pwilkin/strix-halo |
| Flash-Next wrapper | https://github.com/pwilkin/strix-halo/blob/main/install-flash-next.sh |
| Shared installer (pins + launchers) | https://github.com/pwilkin/strix-halo/blob/main/install.sh |
| Engine fork | https://github.com/pwilkin/llama.cpp (branch `strix-halo`) |
| Retained-PM4 ROCr/HIP | https://github.com/pwilkin/rocm-systems/tree/ilintar-experiments |
| Flash-Next GGUF card | https://huggingface.co/ilintar/qwen3.8-flash-next-gguf-strix-halo |

`install-flash-next.sh` only sets `STRIX_PROFILE=flash-next` and execs `install.sh`. It does not pin a different engine.

### Pinned revisions (from `install.sh`, inspected 2026-09-20)

| Component | Pin |
| --- | --- |
| ROCr/HIP source | `https://github.com/pwilkin/rocm-systems.git` branch `ilintar-experiments` commit `7dda3ac6cfe6bbe0b7f08c23a67cfa118d8641a1` |
| llama.cpp | `https://github.com/pwilkin/llama.cpp.git` branch `strix-halo` commit `b0f31f5876ef3856b55f5bb88072cc96e5effafe` |
| Weights | HF `ilintar/qwen3.8-flash-next-gguf-strix-halo` |
| Target shards | `Qwen3.8-Flash-Next-IQ4_NL-PROJFIX-00001-of-00009.gguf` … `00009-of-00009.gguf` (SHA-256s in `install.sh`) |
| MTP draft | `mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf` |
| Vision | **none** (text only; 27B profile has a Bartowski mmproj, Flash-Next does not) |
| Disk | installer requires ~110 GiB free for this profile |
| Install root | `$HOME/.local/share/qwen3.8-strix-halo` (override `STRIX_HALO_INSTALL_ROOT`) |
| Model dir | default `~/.models` |
| System ROCm | **not replaced**; custom HIP/ROCr stay under install root. Never writes `/opt/rocm`. |

`PROJFIX` is a re-export that corrects projection tensor layout; earlier local IQ4_NL builds without it are not interchangeable ([HF card](https://huggingface.co/ilintar/qwen3.8-flash-next-gguf-strix-halo)).

### Hardware prechecks (always run, including `--check-only`)

`verify_driver` then `detect_rocm_root` / `verify_rocm_sdk` run **before** the `--check-only` exit. The installer **cannot** complete, even as a dry-run, without:

- Linux, `x86_64`
- `amdgpu` loaded
- `/dev/kfd` present and r/w for the current user (`render`/`video` groups)
- at least one `/dev/dri/renderD*` r/w
- KFD `gfx_target_version` **110501** (gfx1151)
- a complete **system** ROCm SDK: `hipcc`, `$ROCM_ROOT/lib/llvm/bin/{clang++,llvm-mc}`, CMake packages `hip`, `hipblas`, `rocblas`, `amd_comgr`, `rocprofiler-register`
- HIP **6.1 or newer**

`pkg-config` modules `libdrm`, `libdrm_amdgpu`, `libelf` required.

### Native package dependencies (when `--skip-packages` is not set)

Debian/Ubuntu (`apt-get`): `build-essential ca-certificates cmake curl git libcurl4-openssl-dev libdrm-dev libdw-dev libelf-dev libgl-dev libnuma-dev libpciaccess-dev libssl-dev libudev-dev libzstd-dev ninja-build pciutils pkg-config python3 python3-pip python3-venv xxd zlib1g-dev`.

Fedora/RHEL and Arch lists are in the same `install.sh`. Python venv then installs `CppHeaderParser==2.7.4` and `huggingface_hub[hf_xet]>=0.36.0`.

### llama.cpp CMake (gfx1151 HIP only)

```
-DGGML_HIP=ON
-DGPU_TARGETS=gfx1151
-DGGML_HIP_GRAPHS=ON
-DGGML_HIP_NO_VMM=ON
-DGGML_HIP_MMQ_MFMA=ON
-DGGML_HIP_RCCL=OFF
-DGGML_CUDA_FA=ON
-DGGML_CUDA_FA_ALL_QUANTS=OFF
-DGGML_VULKAN=OFF
-DLLAMA_BUILD_TESTS=ON
```

Build targets: `llama-server`, `llama-bench`, `test-backend-sched-ring`. The installer then **runs** `test-backend-sched-ring`. `ldd` must resolve `libamdhip64` and `libhsa-runtime64` through the custom prefixes.

### Runtime library path and env (generic wrapper)

`LD_LIBRARY_PATH` = custom `$install_root/runtime/hip/lib` + `$install_root/runtime/rocr/lib` + system `$ROCM_ROOT/{lib,lib64,lib/llvm/lib}` + llama build `bin`.

| Env | Default |
| --- | --- |
| `HSA_OVERRIDE_GFX_VERSION` | `11.5.1` |
| `GGML_HIP_ENABLE_UNIFIED_MEMORY` | `1` |
| `ENABLE_RETAINED_PM4` | `1` → `DEBUG_HIP_GRAPH_PM4=1`, graphs enabled |
| `ENABLE_RETAINED_PM4=0` | `GGML_CUDA_DISABLE_GRAPHS=1` |

Config file: `$install_root/config.sh`. Launchers: `~/.local/bin/qwen3.8-strix-halo-server` and `~/.local/bin/llama-server-strix-halo`. Extra `llama-server` args append last.

### Installed Flash-Next server options

Defaults from the `flash-next` launcher (overridable via env, then extra argv):

| Flag / env | Value |
| --- | --- |
| `-m` | IQ4_NL PROJFIX shard `00001` |
| `-dev` | `ROCm0` |
| `-ngl` | `999` |
| `-fa` | `on` |
| `-fit` | `off` |
| `--load-mode` | `none` |
| `--lazy-mode` | `on-direct` |
| `-ctk` / `-ctv` | `f16` (not quantized KV) |
| `-c` / `CTX_SIZE` | `65536` |
| `-b` / `BATCH_SIZE` | `16384` |
| `-ub` / `UBATCH_SIZE` | `16384` |
| `--parallel` / `PARALLEL` | `1` |
| `--jinja` | on |
| `--spec-type` | `draft-mtp` |
| `--spec-draft-model` | shared Q8_0 MTP sidecar |
| `--spec-draft-device` | `ROCm0` |
| `--spec-draft-ngl` | `99` |
| `--spec-draft-n-max` / `MTP_N_MAX` | `3` |

`--load-mode none --lazy-mode on-direct` is required so the ~27.5 GiB per-layer-embedding table is `pread()` on demand and does not double-map under UMA ([HF card](https://huggingface.co/ilintar/qwen3.8-flash-next-gguf-strix-halo); installer comments).

OpenAI-compatible `llama-server` is the process (`/v1/chat/completions`, tools via `--jinja`, slots via `--parallel`, prompt cache via `--cache-ram` / idle-slot flags from upstream server docs). This launcher does **not** pass `--reasoning`, `--cache-ram`, or `--parallel > 1`.

### Container without device access

**Not with the published installer.** `verify_driver` is unconditional. A container that lacks `/dev/kfd`, writable render nodes, and KFD 110501 fails before compile. Reproducing the CMake/prefix layout in CI without a gfx1151 device would be a **new packaging path**; Main decides native prefixes vs reproduce-container. Do not invent a container of `curl|bash`.

Host-side Docker/Podman *after* a native install, passing `/dev/kfd` and `/dev/dri`, is also not specified by this installer (it is a user-prefix Linux build).

License: installer MIT; llama.cpp MIT; Qwen weights per the HF card (`apache-2.0` tag on `ilintar/qwen3.8-flash-next-gguf-strix-halo`; Qwen Community License still applies to the base model in other Flash-Next cards).

---

## Two Qwen3.8 models (do not mix)

The pwilkin lab is explicit: two different models, different stress, different installers.

| Profile | Arch | Weights | Draft | Installer |
| --- | --- | --- | --- | --- |
| `qwen38-27b` (stable) | dense-ish 27B | IQ4_XS + Q8 out | DFlash2 IQ4_XS | `install.sh` default |
| `flash-next` (experimental) | `qwen4exp` hybrid ~177B | IQ4_NL PROJFIX ~93 GiB | shared MTP Q8_0 ~2.6–2.8 GiB | `install-flash-next.sh` |

Flash-Next: gated delta-net + lightning-indexer sparse attention + per-layer embeddings. 27B: DFlash2 + vision projector. Throughput from one does not transfer to the other ([landing page](https://pwilkin.github.io/strix-halo/)).

`qwen4exp` **architecture** is in upstream `ggml-org/llama.cpp` (`src/models/qwen4exp.cpp`). The pwilkin **kernels** (tiled GDN, sparse selected attention, `--lazy-mode on-direct`, UMA scheduler ring, retained-PM4 HIP graphs) are **not** claimed to be in mainline. The HF card: “This model uses architecture support and ROCm kernels that are **not in upstream llama.cpp**.” Upstream also cannot prefill the 24576 ubatch on gfx1151 (`mm_ids_helper` LDS assert) — journey start.

---

## Published pwilkin numbers (not this repo)

Landing page, Flash-Next, retained-PM4 ROCm 10.0, 16384 batch/ubatch (installer default):

| Depth | pp16384 | tg128 |
| --- | ---: | ---: |
| 0 | 1204.31 ± 2.31 | 26.28 ± 0.29 |
| 40 000 | 1086.29 ± 0.96 | 16.63 ± 0.14 |

HF card (same stack, `-b 24576 -ub 24576 -p 16384 -n 128 -r 3`): d0 1151.77 ± 8.12 pp / 24.13 ± 0.29 tg; d40k 1059.82 ± 4.46 / 15.43 ± 1.77. Prefill holds ~90–92% at 40k. Decode is called the weaker half (~8% short of an out-of-tree reference). Journey: 150 300-token planted-fact check answered verbatim; 947.2 t/s prefill over that prompt, 6.9 t/s generation with context filled.

27B matched reproduction on one 8060S (31 497-token prompt, 256 gen, IQ4_XS + DFlash2): 256.84 pp / 26.256 tg. Do not rank Flash-Next against 27B or against Vulkan/ROCmFP4 rows from that table.

Retained PM4: decode-graph replay; **does not engage on Flash-Next prefill** (each chunk shape once per request).

---

## OpenAI server / tools / reasoning / slots / cache

Upstream `llama-server` ([tools/server/README.md](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)): OpenAI chat completions, `--jinja` function calling, `--parallel` slots, continuous batching, `--cache-ram` / idle-slot prompt cache.

[Function calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md): native handlers list Qwen **2.5**, not Qwen3.8-Flash-Next. Unknown templates fall back to Generic. Extreme KV quants (`-ctk q4_0`) “can substantially degrade … tool calling”; pwilkin Flash-Next launcher keeps **f16 KV**.

**Unknown on this pin (must measure before gateway cutover):** native vs Generic tool format for `qwen4exp`; `--reasoning` / reasoning-budget; MTP + `--parallel > 1`; prefix-cache hit rate for coding sessions; tool-call quality vs Halogen.

---

## Packaging distinction (for Main)

| Kind | What | Role here |
| --- | --- | --- |
| **(a) Engine fork** | `pwilkin/llama.cpp:strix-halo` | Follow. HIP, gfx1151 kernels, UMA ring. |
| **(a) Runtime fork** | `pwilkin/rocm-systems:ilintar-experiments` | Follow. Retained-PM4 HIP graphs. Experimental, env-gated, not an AMD proposal. |
| **(c) Native installer** | `pwilkin/strix-halo` `install-flash-next.sh` | Follow. Pins above. User prefixes. |
| **(b) Upstream llama.cpp** | `ggml-org/llama.cpp` HIP `GPU_TARGETS=gfx1151` / Vulkan RADV | Architecture yes; Flash-Next kernels and 16k ubatch **no** per pwilkin. |
| **(c) Toolbox packaging** | [`kyuz0/amd-strix-halo-toolboxes`](https://github.com/kyuz0/amd-strix-halo-toolboxes) | Containers wrapping **other** trees (`vulkan-radv` upstream; `rocm-10.0-strix-llama` = halo-box + pwilkin ROCr). Not this pin. |
| Closed-source optional | Halogen `ghcr.io/peonist-ai/halogen-flash-server:0.12.1` + `.hgn` | Not llama.cpp; already in `docs/halogen.md`. |

---

## Secondary candidates (not the follow target)

Keep for later adapter slots. Do not treat as drop-in replacements for the pin.

| Candidate | Kind | Backend | Qwen3.8-Flash-Next | Notes |
| --- | --- | --- | --- | --- |
| [`halo-box/strix-llama.cpp`](https://github.com/halo-box/strix-llama.cpp) | fork | Vulkan-first; HIP with `HIP_LAUNCH_BLOCKING=1` correctness caveat | kyuz0 packages it; pwilkin points here as community Vulkan fork | MIT. Updated 2026-09-20. |
| [`Nathanw1014/llama.cpp`](https://github.com/Nathanw1014/llama.cpp) + [toolbox](https://github.com/Nathanw1014/strix-halo-llamacpp) | fork + portable Mesa tarball | Vulkan default | mmap PLE notes, MTP caveats, QSA pool cache | Different base/quant/context than pwilkin IQ4_NL HIP. |
| [`Aristo94/EngramHalo.cpp`](https://github.com/Aristo94/EngramHalo.cpp) `strix-halo-qwen4exp` | fork | HIP only | Yes (IQ3/IQ4_XS + MTP sidecar) | SSD mmap engram; multi-slot+MTP not validated; Vulkan reported net loss. |
| [`drluoto/llama.cpp`](https://github.com/drluoto/llama.cpp) `strix-halo-vulkan` | fork | **Vulkan now**; ROCm abandoned | Yes (AgenticRequant Q5K) | Author: ROCm silent wrong logits (PPL 84.8 vs Vulkan 13.8). Different weights. |
| [`ROCmFPX/ROCmFPX`](https://github.com/ROCmFPX/ROCmFPX) | fork | HIP + Vulkan + custom types | Custom ROCmFP4/FPX, **not** NGQ4/IQ4_NL | Experimental formats. |
| [`ikawrakow/ik_llama.cpp`](https://github.com/ikawrakow/ik_llama.cpp) | fork | **CPU + CUDA only** | PR 2365 arch support | README: do not file ROCm/Vulkan issues. **Not a gfx1151 runtime.** |
| kyuz0 `vulkan-radv` / `rocm-10.0` | packaging of upstream | Vulkan / ROCm 10.0 | arch if upstream tree has `qwen4exp` | Most compatible baseline, not the pwilkin kernels. |
| kyuz0 `rocm-10.0-qwen-3.8-flash-next` | packaging | ROCm 10.0 | tracks `drluoto/llama.cpp:strix-halo-flash-next` | Older ROCm-oriented drluoto branch; drluoto’s own writeup moved to Vulkan. |
| kyuz0 `rocm-10.0-engramhalo` | packaging | ROCm 10.0 (fork validated on 7.14) | EngramHalo | Experimental image. |
| kyuz0 `rocm-10.0-strix-llama` | packaging | retained-PM4 ROCr + halo-box | claimed Q4_K_XL + shared Q8 MTP | **Different quant** than IQ4_NL pin. |

NGQ4 GGUF example: [`cygnal/Qwen3.8-Flash-Next-Uncensored-IQ4XS-NGQ4-GGUF`](https://huggingface.co/cygnal/Qwen3.8-Flash-Next-Uncensored-IQ4XS-NGQ4-GGUF) — stock Vulkan + historical PR #27742, **no MTP**, abliterated. Card’s “not merged” note is stale (`qwen4exp` is in ggml-org). Not the pwilkin pin.

---

## Compatibility blockers for the follow target

1. **Linux gfx1151 + KFD + system ROCm 6.1+** — installer hard-fails otherwise. This Mac/CI cannot run it.
2. **~110 GiB model disk + 128 GB UMA** — stated requirement for Flash-Next.
3. **HIP correctness risk on gfx1151** — halo-box documents batched HIP wrong output unless `HIP_LAUNCH_BLOCKING=1`; drluoto reports silent ROCm logit corruption. pwilkin’s own journey includes a 150k planted-fact check on *this* stack; still not a gateway tool-call test.
4. **Experimental env-gated kernels** — HF: running `llama-server` without the launcher gets generic paths.
5. **Single slot default** — `--parallel 1`. Multi-slot + MTP unstated here (EngramHalo says unvalidated on that fork).
6. **Text-only pin** — no mmproj.
7. **f16 KV** — memory vs tool-call quality trade; do not silently switch to q8/q4 KV.
8. **Co-tenancy** — Halogen already documents ~68 GiB resident; Flash-Next 93 GiB weights compete on the same 128 GB box. Not measured here.
9. **IOMMU** — pwilkin installer does **not** set `amd_iommu=off`. Halogen docs treat that as a Halogen-only host trade.

---

## Evaluation order (adapter gateway; no winner)

1. **Native pwilkin prefixes on the Strix Halo box** via `install-flash-next.sh` (or the same pins without `curl|bash`, inspected first). Prove `/health` or equivalent, `/v1/models`, `/v1/chat/completions`, `--jinja` tool round-trip, reasoning if catalogue needs it, prefix-cache reuse on a coding prompt, MTP acceptance on code vs prose.
2. **Only if packaging requires a container:** reproduce the *same* commits and CMake flags; do not wrap the installer; device passthrough still required at **run** time. Build-without-device is a Main packaging decision, not this note.
3. **Halogen** remains the optional closed-source generator already selected in `docs/halogen.md` — different weights (`.hgn`), not this GGUF.
4. Secondary llama.cpp forks only if (1) fails tools/reasoning/cache or HIP correctness.

Evidence still required before locking the gateway adapter to this engine: tool-call parse path (native vs Generic), reasoning controls, slot/cache behavior at `PARALLEL=1`, decode adequacy vs Halogen on the same coding workload, and that IQ4_NL PROJFIX (not NGQ4/Q6_K) meets quality. No number in this file is a measurement of `llm-router`.

---

## Sources inspected

- https://pwilkin.github.io/strix-halo/ and `journey.html`
- https://github.com/pwilkin/strix-halo `README.md`, `install.sh`, `install-flash-next.sh`
- https://github.com/pwilkin/llama.cpp `LICENSE`, `README.md` (default/strix-halo)
- https://huggingface.co/ilintar/qwen3.8-flash-next-gguf-strix-halo
- https://github.com/kyuz0/amd-strix-halo-toolboxes `README.md`
- https://github.com/halo-box/strix-llama.cpp `README.md`
- https://github.com/Nathanw1014/strix-halo-llamacpp `README.md`
- https://github.com/Aristo94/EngramHalo.cpp `docs/strix-halo/README.md` (`strix-halo-qwen4exp`)
- https://github.com/drluoto/flash-next-strix-halo `README.md`
- https://github.com/ROCmFPX/ROCmFPX `README.md`
- https://github.com/ikawrakow/ik_llama.cpp `README.md`
- https://github.com/ggml-org/llama.cpp `tools/server/README.md`, `docs/function-calling.md`, `qwen4exp` sources
- https://huggingface.co/cygnal/Qwen3.8-Flash-Next-Uncensored-IQ4XS-NGQ4-GGUF
- This repo: `docs/halogen.md` (Halogen pin only)
