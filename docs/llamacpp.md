# llama.cpp (host prefixes; Compose does not run it)

**Default remains the approved pwilkin native-prefix flow.** EngramHalo and kyuz0 toolbox variants are documented benchmark candidates, not automatic upgrades. Their numbers use different quants, contexts and instruments; no same-box winner has been established. Keep the control configuration until the incoming hardware passes the matched comparison.

Approved guide: [Strix Halo Lab](https://pwilkin.github.io/strix-halo/). Packaging is **native isolated prefixes on the AMD host**. Compose default is `gateway` + `laya` only. There is no llama.cpp container in this repository.

This agent has **no gfx1151 host**. Commands below are for that Linux box. Do not `curl | bash`.

## 1. Fetch pinned installer (inspect, do not execute yet)

Guide commit `f73872fe20dfdef460653f18e2fe63e5366ae958` (2026-09-16).

```bash
node scripts/fetch-strix-halo-guide.mjs
```

Writes checksum-verified copies to `third_party/strix-halo/f73872fe20dfdef460653f18e2fe63e5366ae958/`:

| File | sha256 |
| --- | --- |
| `install.sh` | `b339476d3db30b1c70feea175c2dd2eb8abad4cce0bfba1b5777542174a1d1e0` |
| `install-flash-next.sh` | `7fd25b554afcbe76d33b932ca07daadac2166b581c8d8861ea379b45778a0dc8` |

The wrapper only sets `STRIX_PROFILE=flash-next` and execs `install.sh`.

## 2. Prerequisites (AMD Linux, desktop user, no `/opt` overwrite)

System ROCm/HIP SDK ≥ 6.1 must already exist (`hipcc`, hipBLAS, rocBLAS, LLVM, rocprofiler-register). The installer builds extra ROCr/HIP into `$HOME/.local/share/qwen3.8-strix-halo` and never replaces `/opt/rocm`. No kernel/IOMMU edits.

```bash
cd third_party/strix-halo/f73872fe20dfdef460653f18e2fe63e5366ae958
bash install.sh --skip-packages --check-only
```

`--check-only` still requires gfx1151: Linux x86_64, amdgpu, `/dev/kfd` r/w, `/dev/dri/renderD*` r/w, KFD `gfx_target_version` `110501`. It will fail on this Mac.

## 3. Install Flash-Next (on that host)

~110 GiB free, 128 GB unified memory.

```bash
STRIX_PROFILE=flash-next bash install.sh --model-dir "$HOME/.models"
```

Pins inside that script: ROCm `7dda3ac6cfe6bbe0b7f08c23a67cfa118d8641a1`, llama.cpp `b0f31f5876ef3856b55f5bb88072cc96e5effafe`, weights `ilintar/qwen3.8-flash-next-gguf-strix-halo` IQ4_NL shards + `mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf`. A different quant/export needs fresh compatibility and quality checks, not a filename substitution.

## 4. Launch (private bind)

Default is localhost. The gateway container cannot use `127.0.0.1`. Bind a private address and firewall it:

```bash
qwen3.8-strix-halo-server --host 0.0.0.0 --port 8080
```

Keep 8080 off the public internet.

## 5. Router + Laya (this repo)

```bash
node scripts/setup.mjs
docker compose up -d
docker compose exec gateway node /opt/ops/discover-local.mjs http://host.docker.internal:8080
```

Put `modelId` from `/v1/models` into `catalog.json`. Endpoint `http://host.docker.internal:8080/v1`. Gateway `extra_hosts` maps `host.docker.internal` to the host gateway.

That is the startup flow **after** hardware/guide install. It is not a clean-host Docker one-command.

Halogen and containerized llama.cpp are equally supported alternatives. See [runtime selection](runtime-selection.md) for matching profiles/catalogues and safe switching; the generic Vulkan image is not the optimized native build described here.

## Required SSD-backed table behavior

The pinned launcher uses `--load-mode none --lazy-mode on-direct`: dense active weights and KV stay in RAM; PLE/n-gram lookup rows are read from the model file on local SSD on demand. This is **not** whole-model swapping or KV offload. Confirm those effective flags and file-backed reads on the AMD host before accepting the runtime.

Keep IOMMU enabled for optional XDNA2 services. Measure GPU chat, Laya CPU, and NPU auxiliary workloads both alone and together; shared RAM/bandwidth can change the best concurrency level. Record cold/warm SSD table pages independently from runtime prompt/KV cache hits.

The detailed [runtime comparison matrix](research/strix-concurrency-comparison.md) and [EngramHalo analysis](research/engram-halo.md) preserve alternatives and their validation gaps.
