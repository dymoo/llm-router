# Aristo94/EngramHalo.cpp — Qwen3.8-Flash-Next runtime research (Strix Halo, engram offload)

**Date:** 2026-09-20
**Scope:** Primary-source research on `Aristo94/EngramHalo.cpp` default branch `strix-halo-qwen4exp` and its HF model sources. Focus per operator priority: the required n-gram (PLE/"engram") table SSD offload — exact flags, mmap/page-cache vs pinned-resident behavior, direct-read path, required table format, SSD space/bandwidth — then concurrency (n=1/2/4/8), MTP compatibility, slot/context memory constraints, stability caveats.
**Non-goals:** no deployment or app-code changes, no builds/tests/lint, no installs, no paid inference. No AMD host available: nothing here is an on-box measurement of this repo.
**Comparison note:** `docs/research/strix-halo-runtimes.md` owns the pwilkin pin (llama.cpp `b0f31f5876ef3856b55f5bb88072cc96e5effafe` / rocm-systems `7dda3ac6cfe6bbe0b7f08c23a67cfa118d8641a1`) and the runtime landscape. `docs/research/strix-concurrency-comparison.md` (sibling agent) owns the multi-request comparison. This file is the EngramHalo source of record. **No absolute winner is claimed** — pwilkin and EngramHalo numbers were taken on different builds, quants, ubatches, contexts, and (for some rows) different RAM sizes; no matched A/B exists.

Facts, estimates, and unknowns are separated. Every decisive claim cites its source URL.

---

## Identity and exact pins

| What                                  | Value                                                                                                                                                                                                                                                                       | Source                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Repo                                  | https://github.com/Aristo94/EngramHalo.cpp (fork of `ggml-org/llama.cpp`)                                                                                                                                                                                                   | repo view, inspected 2026-09-20                                                                                    |
| Branch                                | `strix-halo-qwen4exp` (default)                                                                                                                                                                                                                                             | repo view                                                                                                          |
| HEAD at inspection                    | `cf4cd1eeecda8384f7418eb0221738ab874effe8` — docs-only commit (committer date 2026-09-20); code-identical parent `a7b67eb8e10366ee97fc8d4c4d0ddc2f8adf994a`                                                                                                                 | https://api.github.com/repos/Aristo94/EngramHalo.cpp/commits/strix-halo-qwen4exp                                   |
| Base                                  | ggml-org PR #27742 lineage: PR head `af1ffaf37` at measurement time, merged upstream 2026-08-27 as `6c84c7d5`; branch is **rebased onto master on top of that merge** and tracks current upstream (Sep 19–20 commits #29115/#29108/#28832/#29094/#28770 visible in history) | https://github.com/Aristo94/EngramHalo.cpp/blob/strix-halo-qwen4exp/docs/strix-halo/README.md; commit history page |
| Reference builds quoted in benchmarks | "stock" `b8bdf73bb` (build 10678) and best-pre-patch `243914706` (build 10695) of the PR branch                                                                                                                                                                             | https://github.com/Aristo94/EngramHalo.cpp/blob/strix-halo-qwen4exp/docs/strix-halo/BENCHMARKS.md                  |
| Backend scope                         | **ROCm/HIP only** (gfx1151). Vulkan/RADV on this branch is reported a net loss (prefill ~half of stock, MTP collapse 6–7 t/s — unverified third-party report); the fork's own Vulkan cross-check covers plain pp/tg only, not MTP                                           | fork docs/strix-halo/README.md                                                                                     |
| ROCm                                  | 7.14 (`amdrocm-runtime7.14`, `amdrocm-blas7.14-gfx1151`) via the shipped container; kyuz0 `rocm-10.0-engramhalo` image is an **experimental** ROCm 10.0 port, manual-build only                                                                                             | Dockerfile.rocm-7.14; https://github.com/kyuz0/amd-strix-halo-toolboxes                                            |
| License                               | llama.cpp MIT; model **Qwen Community License 1.0** (MaaS/AI-Work-Assistant clause — relevant to a commercial router)                                                                                                                                                       | fork README; HF card                                                                                               |

### The patch series (commit → effect)

| SHA         | Commit                                                                    | Effect                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abda7ddb6` | CUDA/HIP: skip fully-masked warp slices in FA vec; tune head-256 for RDNA | backend-generic FA vector-kernel early exit; picks vector kernel for qwen4exp shape (hd 256, GQA 2, q8_0 KV)                                                  |
| `af25fb85e` | HIP: chunked GATED_DELTA_NET prefill (opt-in)                             | opt-in on RDNA3/RDNA4 via `GGML_HIP_GDN_CHUNK=1`; **not active in any published number**                                                                      |
| `69f44d1b5` | mmap: prefetch lazily read rows; IQ4_NL get_rows for non-QK_K rows        | batched `posix_madvise` readahead for SSD-backed engram rows; **without the IQ4_NL `get_rows` path the 160-value engram gather cannot run on the GPU at all** |
| `a2ff187ed` | qwen4exp: gather top-k KV rows in QSA decode instead of dense masking     | the decode-numerics-touching patch; graph-level gather, env-gated (details below)                                                                             |
| `31b71a27f` | qwen4exp: MTP draft head and mtp-only sidecar loading                     | standalone `-md` sidecar support; initial unmasked-nextn readback crash fixed                                                                                 |
| `e2e0976d1` | convert: export the qwen4exp MTP block                                    | `convert_hf_to_gguf.py --remote --mtp` builds the sidecar                                                                                                     |
| `b6da37ae2` | mmap: drop page cache behind uploaded tensors during load                 | transient load peak −~88% (28 GiB → 2 GiB extra cache; free mem during upload 0.8 → 17+ GiB)                                                                  |

Sources: each commit page under https://github.com/Aristo94/EngramHalo.cpp/commits/strix-halo-qwen4exp and the commit table in docs/strix-halo/README.md.

Two additional **container patches** (not branch commits) are required to reproduce the measured configuration:

- `llama-cpp-25992-rocm-host-buffer.patch` — disables ROCm host-buffer compute on integrated GPUs. **Correctness workaround** for ggml-org llama.cpp issue #25992 (`-np > 1` + `--kv-unified` can return other requests' responses verbatim); based on still-unmerged upstream PR #25863. Also determines where engram gathers get scheduled with `-lm none`.
- `llama-cpp-qwen38-per-buffer-mmap.patch` — per-shard-buffer mmap tracking; stops whole-file prefetch. **This is what lets the sparse engram tensor stay mmap-backed on CPU while dense weights upload to the GPU.**

Sources: https://github.com/Aristo94/EngramHalo.cpp/blob/strix-halo-qwen4exp/docs/strix-halo/Dockerfile.rocm-7.14, the two `.patch` files in the same dir, BENCHMARKS.md.

---

## PLE / "engram" table offload (REQUIRED feature — exact mechanism)

### What the table is

- Tensor `per_layer_token_embd` (LLM_TENSOR_PER_LAYER_TOKEN_EMBD): **one 26.82 GiB IQ4_NL tensor, byte-identical in all quants, always CPU-side**. It is never resident on the GPU in any mode; `-ngl 999` does not pull it in. (BENCHMARKS.md)
- Gather pattern: each token gathers `ple_n_heads` (16) rows of a shared table via a host-side n-gram hash (`mixed_n = (t[p]*m[0]) ^ … % vocab[h] + offset[h]`); rows are 160 values (head_dim 160), **not a multiple of QK_K=256** — this is why the IQ4_NL `get_rows` GPU path was needed. (source: `src/models/qwen4exp.cpp` HEAD; commit `69f44d1b5`)
- 51B of the architecture's ~176B params are these n-gram (PLE) embedding parameters. (unsloth HF card; julianmb issue #1 arithmetic)

### Loader wiring (code-traced)

- The converter marks the table `TENSOR_READ_LAZY` in `llama_model_qwen4exp::load_arch_tensors` (verified at HEAD and at the gather commit): `per_layer_tok_embd = create_tensor(..., TENSOR_READ_LAZY)`. The lazy machinery is upstream #27794 (`tensor-read-lazy`).
- The per-buffer mmap container patch makes the async-upload path tolerate a shard buffer that is mmap-backed; combined with `ml.init_mappings(false, ...)` (no whole-file prefetch), the dense weights upload to GPU while the sparse table stays file-backed.
- The gather input node (`llm_graph_input_ple::set_input`) calls `pmodel.prefetch_rows(...)` — **the direct-read path**: tokens' row indices are computed host-side, the mapping is read straight off mmap pages (`MADV_RANDOM`), and one batched `posix_madvise`/readahead hint is issued per page-merged row range instead of one fault per row. 16 faults per token, all queued before the graph runs. (source: `src/models/qwen4exp.cpp` at HEAD; commit `69f44d1b5`)

### Flags that control it (the short answer)

| Goal                                                           | Flags                                                                                                                                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSD offload (full 262K window, ~1–1.5 GiB resident)            | default (`-lm mmap`) — explicit: `-lm mmap --tensor-read-lazy on` (`on` only makes intent explicit; default `auto` already covers every lazy-marked tensor above 4 GiB, incl. this one)        |
| Full-resident table (fastest, interactive, ≤48K practical)     | `-lm none` → 26.8 GiB **pinned** host memory (regular tensor; no lazy path)                                                                                                                    |
| Frequent reloads without discarding uploaded-weight page cache | `LLAMA_MMAP_DROP_BEHIND=1`: unmap only. Default `2` also invalidates copied-weight file pages; `0` disables dropping. Lazy tensors that remain mapped are excluded from this loader operation. |
| **Forbidden**                                                  | `--no-mmap` — silently disables the lazy-read path                                                                                                                                             |

Sources: docs/strix-halo/README.md "Recommended server configs", "Known limits"; `src/models/qwen4exp.cpp`.

Main verified these `DROP_BEHIND` modes directly in [`llama-model-loader.cpp` at the inspected commit](https://github.com/Aristo94/EngramHalo.cpp/blob/cf4cd1eeecda8384f7418eb0221738ab874effe8/src/llama-model-loader.cpp). This is a load-peak/reload control, **not** proof that the PLE table or inference KV cache is warm.

### Required table format

- The gather target must be the **IQ4_NL tensor with padded rows** (converter pads the table; `ne[1]` must cover the PLE head ranges — loader throws otherwise). Any quant of the trunk is fine; the table itself is byte-identical IQ4_NL everywhere. Static requants that reformatted this tensor at higher bpw (julianmb's 115.5 GiB pass) still carry ~38 GiB at high precision but keep the PLE quantization; the fork's published configs use unsloth UD quants as-is.
- Caveat: a CPU-overridden tensor (`-ot ...=CPU`) on this **HIP** build lands in "ROCm_Host" = **pinned anonymous copies, not file-backed** — disk streaming through `-ot` does not work on the HIP build (verified with `exps=CPU`, issue #1 finding 2; same buffer-type mechanism applies to the PLE tensor [INFERENCE]). The supported streaming path is `TENSOR_READ_LAZY` + mmap, not `-ot`.

### SSD space and bandwidth

- Disk: unsloth UD-IQ3_XXS 76.32 GiB (3 shards) / UD-IQ4_XS 87.24 GiB (+ 4.1 GB sidecar). (BENCHMARKS.md, unsloth tree)
- Resident cost of SSD mode: ~1 GiB estimated (author), 1.4 GiB RSS on a DGX Spark field report. (docs note [3])
- Measured bandwidth effects (96 GB box, Crucial CT1000E100SSD8 NVMe, models on `/home`):
  - Like-for-like `llama-bench` (engram page-cached in both): SSD-vs-RAM costs ~5% prefill at depth 0 (468.1 vs 491.4 t/s), nothing on decode (24.6 vs 24.7 tg128). At 16K depth both are KV/indexer-bound and equal (376.5/376.9 pp).
  - **Cold** page cache per run, marginal at depth: IQ3 pp2048 470.9 @4K → 174.4 @128K; warm page cache would read higher (the cached mmap pair reaches 502).
  - True SSD-lazy server operation (table read from SSD as used, cache not pre-warmed): 395.6 t/s prefill / 22.6 t/s decode @4K depth; 381.9 / 21.0 @16K (depth-curve delta rates — a different metric from `pp4096`, not directly comparable to the bench table).
  - RAM mode never touches the SSD after load; its cost is load time (minutes, full read + pinning) vs seconds (mmap).
- The reads are random-access (`MADV_RANDOM`, no two rows on a page) — the design pays NVMe random-read latency per gather and buys it back with batched readahead hints; docs do not quote raw SSD throughput, so bandwidth is characterized only by these observed end-to-end numbers. Unresolved on-box variable: your NVMe's random-read profile.

### Latency / cache-warm behavior (summary)

| Metric                         | Value                                                      | Conditions                                                                   |
| ------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Cold-start penalty             | first request 20–55% slow; worst observed 17.8 vs 39.3 t/s | right after full `-lm none` load                                             |
| Repeat-request inflation       | up to ~35% fast (52.7 vs 39.3)                             | identical request again: prompt cache + ngram speculator has seen the answer |
| Synthetic-prompt MTP inflation | decode reads 2–3× high (73 t/s observed)                   | random-word filler prompts; measure MTP decode on real payloads only         |
| Load time                      | seconds (mmap) vs minutes (pin)                            | SSD vs RAM mode                                                              |

Source: BENCHMARKS.md "Measurement pitfalls".

---

## Actual quant support and model files

| File                                                                                                                               | Size                                                                  | Note                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unsloth `Qwen3.8-Flash-Next-GGUF` UD-Q2_K_XL → UD-Q6_K_XL (IQ1_M/IQ1_S/IQ3_XXS/Q3_K_XL/IQ4_XS/Q4_K_XL/Q5_K_XL/Q6_K_XL, Q8_0, BF16) | 76.3 GiB (IQ3_XXS) / 87.2 (IQ4_XS) / 103.7 (Q4_K_XL) / 83.8 (Q3_K_XL) | published configs use UD-IQ3_XXS and UD-IQ4_XS                                                                                                                                                       |
| EasiiX `mtp-Qwen3.8-Flash-Next-hc-Q8_0.gguf`                                                                                       | 4.1 GB                                                                | **use this one**; includes hyper-connection tensors required by llama.cpp since ggml-org#28901                                                                                                       |
| ~~EasiiX `mtp-Qwen3.8-Flash-Next-Q8_0.gguf`~~                                                                                      | 4.1 GB                                                                | **DEPRECATED 2026-09-19** — current builds refuse it (`check_tensor_dims: tensor 'output_hc_norm.weight' not found`). Note the fork README's configs A/B still name the old file — substitute `-hc-` |
| dzannotti / other community exports                                                                                                | —                                                                     | old format (missing `nextn.hc_head_*`, alignment/split-count checks) — rejected by the merged reader; standalone-load fails outright on pre-fork trunks (julianmb issue #1)                          |

Sidecar contract (first-party issue): a working sidecar keeps `block_count = 49`, tensors at `blk.48.*` (49-entry `compress_ratios`, MTP block is a full-attention layer), and the runtime selects the trailing block via `n_main = n_layer - nextn_predict_layers`. The hyper-connection combiner (`nextn.hc_*`) is the difference between 0.87–0.96 and ~0.47 draft acceptance — mean-pooling the streams collapses acceptance. (source: https://github.com/Aristo94/EngramHalo.cpp/issues/1 comments)

Quality anchors: wikitext-2 PPL IQ3_XXS 4.1466 ± 0.035 vs IQ4_XS 4.0430 ± 0.034 (−2.5%); QSA gather Δ 0.03% (4.4601 vs 4.4613) vs dense mask, same build. (BENCHMARKS.md)

---

## Build and launch

### Container build (kyuz0-style)

```bash
cd docs/strix-halo
podman build -f Dockerfile.rocm-7.14 -t engramhalo .
toolbox create engramhalo --image localhost/engramhalo -- \
  --device /dev/dri --device /dev/kfd --group-add video --group-add render \
  --security-opt seccomp=unconfined
```

CMake (container): `-DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1151 -DCMAKE_BUILD_TYPE=Release -DGGML_RPC=ON -DROCM_PATH=/opt/rocm -DHIP_PLATFORM=amd`. Runtime packages: `amdrocm-runtime7.14`, `amdrocm-blas7.14-gfx1151`. (Dockerfile.rocm-7.14)

The source's historical 96 GB benchmark host used `amd_iommu=off amdgpu.gttsize=94208 ttm.pages_limit=24117248` and TuneD `accelerator-performance`. These are **measurement conditions, not this hub's recommended boot arguments**. Keep IOMMU enabled for FastFlowLM/XDNA2; establish a new GPU baseline with that setting. Do not copy a 96 GB carve-out onto the 128 GB target without measuring headroom for hot weights, KV, Laya, NPU allocations, and page cache.

### Recommended server configs (fork-verbatim, sidecar name updated to `-hc-`)

**A — interactive single slot, RAM mode, fastest (this is the 39.3 tok/s config):**

```bash
toolbox run --container engramhalo env ROCBLAS_USE_HIPBLASLT=1 \
  llama-server -m Qwen3.8-Flash-Next-UD-IQ3_XXS-00001-of-00003.gguf \
  -ngl 999 -fa on -ctk q8_0 -ctv q8_0 \
  -lm none -c 32768 -b 8192 -ub 2048 -t 4 --parallel 1 --jinja --no-webui \
  -md mtp-Qwen3.8-Flash-Next-hc-Q8_0.gguf \
  --spec-type draft-mtp,ngram-mod --spec-draft-n-max 4 --spec-draft-p-min 0.75
```

**B — long context up to 262144, engram on SSD:**

```bash
toolbox run --container engramhalo env ROCBLAS_USE_HIPBLASLT=1 \
  llama-server -m Qwen3.8-Flash-Next-UD-IQ3_XXS-00001-of-00003.gguf \
  -ngl 999 -fa on -ctk q8_0 -ctv q8_0 \
  -lm mmap --tensor-read-lazy on -c 262144 -b 8192 -ub 2048 -t 4 \
  --parallel 1 --jinja --no-webui \
  -md mtp-Qwen3.8-Flash-Next-hc-Q8_0.gguf \
  --spec-type draft-mtp,ngram-mod --spec-draft-n-max 4 --spec-draft-p-min 0.75
  # With the sidecar prefer -c 163840: MTP validated to a 164K slot; 256K+MTP never run.
```

**C — throughput, multiple slots (no MTP):**

```bash
toolbox run --container engramhalo env ROCBLAS_USE_HIPBLASLT=1 \
  llama-server -m Qwen3.8-Flash-Next-UD-IQ3_XXS-00001-of-00003.gguf \
  -ngl 999 -fa on -ctk q8_0 -ctv q8_0 \
  -lm mmap --tensor-read-lazy on -c 131072 -b 8192 -ub 2048 -t 4 \
  --parallel 4 --jinja --no-webui
  # -c is TOTAL context: 131072 / 4 slots = 32K per slot.
```

Free rules (cost nothing): never bf16 KV (hd-256 FA re-converts the whole cache every call; `q8_0` equal speed, half memory; KV+indexer @262144: 8.3 → ~4.5 GiB); `-ub 2048` needs the per-block QSA bias (in branch via #27742 head); `-t 4` in mmap mode, thread count stops mattering with `-lm none`. (docs/strix-halo/README.md)

---

## Claimed timings and conditions

Measured 2026-08-27 on one machine (GMKtec EVO-X2, Ryzen AI MAX+ 395, 40 CU RDNA 3.5 gfx1151, 96 GB LPDDR5X-8000 ≈256 GB/s theoretical, OS sees 92 GiB). q8_0 KV, temp 0. (BENCHMARKS.md)

| q8_0 KV, temp 0           | stock (IQ3)   | tuned IQ3, SSD              | tuned IQ3, RAM  | tuned IQ4_XS, SSD        |
| ------------------------- | ------------- | --------------------------- | --------------- | ------------------------ |
| tg400 code, MTP @ d0      | 24.4 [anchor] | 35.3                        | **39.3**        | 31.1                     |
| tg300 prose, MTP @ d0     | 22.4          | 25.1                        | 25.3            | 23.2                     |
| tg300 code, MTP @ d78k    | ~10           | 21.3                        | —               | **24.7**                 |
| tg300 code, MTP @ d156k   | ~6            | **12.1**                    | —               | 11.4                     |
| pp4096 @ d0               | 352           | 396 [server, true SSD-lazy] | 496 [bench]     | 502 [bench, cached mmap] |
| pp @ d131k (delta rate)   | 91            | 192                         | —               | —                        |
| pp avg over 156K prompt   | —             | 192                         | —               | 216                      |
| resident engram           | 26.8 GiB      | ~1 GiB                      | 26.8 GiB pinned | ~1 GiB                   |
| max context (single slot) | 262K          | 262K (164K w/ MTP)          | 131K measured   | 262K                     |

**Which config gives 39 tok/s:** config A — single slot, `--parallel 1`, UD-IQ3_XXS, q8_0 KV, `-lm none` (table fully resident), MTP combo `draft-mtp,ngram-mod`, n-max 4, p-min 0.75, hipBLASLt, warm (non-cold, fresh prompt), 400-token code output at temperature 0. The like-for-like anchor in the same patched build without MTP is 24.4 t/s (code, same prompt) — MTP adds +61% at acceptance ~83%. (BENCHMARKS.md flag matrix + speculation table; docs/strix-halo/README.md config A)

Depth curves (IQ3, q8_0 KV, t4, ub2048, hipBLASLt, SSD mode): prefill before→after patches at d131k 90.9→192.3 t/s; decode at d131k 7.02→9.53; deepest stage measured 236,730 real tokens (pp delta 137.9, decode 6.45). Residual depth decay attributed to the QSA indexer still scoring O(ctx/4) blocks/token. (BENCHMARKS.md)

MTP at depth (server, real code payloads, Q8_0 sidecar, n-max 4, p-min 0.75): 36.4 t/s @~0K (79.6% acceptance) → 21.6 @77.7K (73.5%) → 20.8 @156.4K (66.0%); the MTP win _grows_ with depth (+47% → +63% → >2× vs plain). Sidecar costs prefill "essentially nothing" (within a few % of the plain bench curve). (BENCHMARKS.md)

Flag matrix wins: `-t 4` (tg @16K 13.4→15.7), f16/q8_0 KV over bf16 (18.5/18.1 @16K), `ROCBLAS_USE_HIPBLASLT=1` (pp only), UD-IQ4_XS prefill faster than IQ3 (281–404 vs 346–468 in various modes) but ~7% decode tax. (BENCHMARKS.md)

Provenance caveat: the speculation-table campaign binaries predate the shipped MTP head; the sidecar of that day ran through the PR-branch draft path. The shipped head's first request crashed (fixed in-commit) and then read 34.3/22.2 code/prose at 79.6%/63.9%. Plain mainline master cannot load the sidecar at all until upstream #27836 (or equivalent) lands — that PR is still **open** as of 2026-09-02. (BENCHMARKS.md; ggml-org#27836)

---

## Concurrency trace (code + tests, not the `--parallel` flag)

### Hard code-level restrictions found

1. **QSA gather is single-sequence-only by default.** Source (`src/models/qwen4exp.cpp`, commit `a2ff187ed`, unchanged at HEAD): `qsa_gather_n_sel()` returns 0 (dense masked path) unless `ubatch.n_seqs_unq == 1`, additionally gated on `cparams.flash_attn`, non-alibi, `n_tokens <= 16` (decode-sized only), `n_kv >= LLAMA_QSA_GATHER threshold` (default 16384), and `n_sel < n_kv` (top_k 2048 + block tail, padded to FATTN_KQ_STRIDE 256). `LLAMA_QSA_GATHER_MS=1` lifts the multi-sequence restriction for validation; `LLAMA_QSA_GATHER_TRACE=1` logs every gather graph build (shape-confirmation knob). In-code justification: multi-sequence gather graphs are pinned correct on CPU (`tests/test-qsa-gather-ms.cpp`, NMSE ≤ 4.4e-14, unified + 2-stream joint-decode shapes), but end-to-end GPU validation exists only for plain single-sequence decode — hence the gate.
2. **PLE n-gram assert forbids tokens shared by multiple sequences.** `llm_graph_input_ple::set_input` runs `GGML_ASSERT(ubatch->n_seq_id[i] == 1 && "PLE n-gram embeddings do not support tokens shared by multiple sequences")`. Server multi-slot decode batches one token per slot (n_seq_id 1) and is safe; any batch shape that carries one token under multiple seq_ids (eval tools' coupled prefixes, `llama-batched-bench` common-prefix mode) crashes at layer 2 on gfx1151 unless the masked path is taken. This is a real co-tenancy hazard for any future gateway feature that shares a KV region across slots.
3. **Multi-slot serving requires the #25992 host-buffer workaround.** Without it, `--parallel > 1` on gfx1151 can return other requests' responses verbatim (ggml-org#25992, fix unmerged upstream); the shipped container applies the patch and warns when it no longer applies. Build-outside-container → do not run multi-slot. (docs + patch file)

### Measured concurrency numbers

Only **pre-patch stock** `llama-batched-bench` exists (b8bdf73bb, IQ3, q8_0 KV, ub 512, -c 16384, npp 2048, ntg 64) — not re-measured on the patched branch, no MTP:

| parallel | pp aggregate | decode aggregate | per-stream decode |
| -------- | ------------ | ---------------: | ----------------: |
| 1        | 351.7        |             22.6 |              22.6 |
| 2        | 362.9        |             36.9 |              18.4 |
| 4        | 358.7        | **54.7** (~2.4×) |              13.7 |
| 5        | 358.5        | 56.0 (saturated) |              11.2 |

Author: "expect at least the same, it has not been re-measured here." **n=8 was never measured**; aggregate saturates at n=5 on stock. (BENCHMARKS.md "Multi-slot throughput")

### MTP + concurrency

- **Multi-slot + speculative decoding is not validated on this arch** — author's explicit statement in config C, which deliberately omits `-md`. No code-level prohibition was found (the MTP port follows the deepseek4/deepseek32 per-slot draft pattern and `create_memory` wires MTP contexts per hybrid context); the limitation is validation, not a traced gate. (docs/strix-halo/README.md; commit `31b71a27f`)
- Speculative decoding is lossless at temperature 0 in principle (target verifies every drafted token), but greedy byte-identity on HIP is **not** held by every export — the #27836 thread shows mid-generation divergence on ROCm 7.1 with a grafted F16/F32 mixer vs Q8_1 trunk `hc_head_*`. Acceptance unaffected. (ggml-org#27836 comments)
- `ngram-mod` alone: code 24.7 → 27.8 t/s (32K slot). External 0.8B draft: useless here (expert traffic scales with draft depth). (BENCHMARKS.md)

### Warm history at concurrency

- Warm prefix in the docs = one slot, `cache_prompt: true`, growing-prefix depth curve. Concurrent warm-prefix behavior was **not measured**; the only concurrency metric is the stock batched-bench above (which does couple a common prefix and would trip the PLE assert on the patched engine — batched-bench numbers are therefore stock-only by construction).
- Unresolved: whether the ngram-mod speculator's benefit survives mixed-slot ubatches (draft acceptance under concurrency) — explicitly unvalidated territory.

---

## Slot / memory constraints (96 GB box measured; 128 GB scales up)

- **`-c` is the total context across slots** (131072/4 = 32K per slot). IQ4_XS @262144 single slot = 71.1 GiB GTT and runs; IQ3 @4×262144 fits memory-wise (73.8 GiB GTT) but decode collapses (engram cache squeezed) — multi-stream needs smaller slots. (BENCHMARKS.md)
- RAM mode (`-lm none`): measured OK to `-c 131072` (24.8 t/s, 55.4 GiB GTT); `-c 262144` does not fit (~61 GiB GTT needed on top of everything else). First-request **deadlock** reproduced at `-c 143360`/`-c 163840` (server healthy, first request sits at `n_prompt_tokens_processed: 0`, GPU idle) — 2026-08-27 build, not re-tested on current; band 32K–98K unexplored, ~48K boundary is an estimate. (docs "Known limits"/"RAM mode is a short-context mode")
- SSD mode is the only option for long contexts and costs ~5% prefill at d0, nothing at 16K+ (like-for-like).
- Load: `LLAMA_MMAP_DROP_BEHIND` default cuts transient peak ~88%; RAM mode has no such reduction (27 GiB tensor mid-read drop = 45× slower prefill via swap thrash — deliberate).
- **128 GB box specifics (julianmb, independent reproduction):** a static 5.61 bpw IQ4_XS requant (116 GiB) + 3.9 GiB draft anon exceeded 124 GiB physical → GTT page swaps → hsa-allocator livelock during draft load, 5/5 reproductions. With unsloth sizes (IQ3_XXS 76.3 / Q3_K_XL 83.8 / IQ4_XS 87.2 GiB) + 4.1 GiB draft + KV, MTP fits with room. (source: https://github.com/Aristo94/EngramHalo.cpp/issues/1)

---

## Critical stability / performance caveats (first-party)

1. `--tensor-read-lazy on` hang reports: native ROCm 7.2.4 Ubuntu with `HSA_XNACK=1`/`HSA_ENABLE_SDMA=0` hangs indefinitely (unreproduced on the TheRock 7.14 container stack); **rocm 7.15 host build segfaults in libhsa-runtime64 during lazy load** (julianmb). Workaround: drop `--tensor-read-lazy`, keep mmap (prefill pays cold reads). Lazy reads depend on the page-fault path XNACK changes — pin your ROCm version to the validated stack (7.14 container) or verify on-box.
2. RAM-mode large-slot first-task deadlock (above); 92/92 GiB thrash at `-c 98304` RAM + sidecar.
3. `llama-perplexity --multiple-choice` crashes on every qwen4exp build (upstream bug); PPL 32K chunks OOM on larger quants (use 8K).
4. Measurement pitfalls: cold-start low, repeats high, synthetic prompts inflate MTP decode 2–3×.
5. n=1 hardware sample; single-machine methodology; llama-bench vs server metrics not interchangeable.
6. Upstream arch keeps moving; the branch rebase carries the series — pin the commit, don't float master.
7. ROCBLAS_USE_HIPBLASLT=1 is part of every published config; M4-Max-style `-ot` offload tricks do not transfer through this HIP build (ROCm_Host pinning).
8. GGML_HIP_GDN_CHUNK=1 (chunked GDN prefill) is an unmeasured potential prefill gain — nothing published uses it.

---

## Single-stream vs concurrency: what the evidence supports

- **Fastest single stream (claimed):** RAM-mode IQ3 + MTP combo ≈ 39.3 t/s on code; ~25 t/s prose; 21+ t/s at 150K context depth. Gains: top-k kernel (fixes long-context collapse), QSA gather (+single-stream decode bandwidth reduction above 16K), MTP (+47%→2× with depth), hipBLASLt, q8_0 KV.
- **Highest measured throughput:** `--parallel 4`, no MTP, ~55 t/s aggregate / 13.7 per stream — but measured on the **pre-fix pre-patch** build; the clean path on the current tree requires the #25992 patch (included in the container). At concurrency the QSA-gather speedup is **off** (multi-seq → dense fallback): concurrency trades per-stream latency for aggregate throughput, and does not benefit from the headline optimization.
- MTP and concurrency have **not been exercised together** on this router-relevant surface; no claim either way.
- Against the pwilkin router default (IQ4_NL ~34 G params, 128 GB UMA, 65K ctx, MTP n-max 3): different quant (IQ4_NL vs IQ3_XXS/IQ4_XS), different concurrency posture, different RAM size — no shared measurement basis; the user's own cross-check (cross-referenced in the completeness report) still leaves absolute-winner status unproven for either. The known pin remains the default until a same-box, same-quant A/B says otherwise.

## Unresolved performance variables

- `GGML_HIP_GDN_CHUNK=1` prefill impact (never measured).
- QSA-gather threshold tuning (`LLAMA_QSA_GATHER=<int>`) and the untested 16K–128K window on non-default settings.
- Concurrency × MTP × deep-context interaction (nothing measured).
- Real-NVMe throughput on the target box (only indirect evidence: 396 vs 395/… deltas above).
- Strix Halo 128 GB carve-out behavior vs the 96 GB numbers (GGT totals per allocation above are 96 GB-exercised).
- Whether the `ngram-mod` fast path survives long contexts (author calls it an uncertainty, not a gap).

## Decision and hardware acceptance

Retain the already selected pwilkin native-prefix runtime as the control. EngramHalo and the kyuz0 variants are benchmark candidates, not automatic upgrades. No source establishes a same-box, same-quant, same-workload winner.

Use the [shared benchmark matrix](strix-concurrency-comparison.md#reproducible-on-box-evaluation-protocol-no-paid-calls). Begin EngramHalo with the SSD-backed table configuration, not the fastest RAM-table headline configuration, because on-demand SSD PLE is a product requirement. Verify each flag against the pinned binary's `--help`; flags from different forks are not interchangeable.

Before multi-slot serving, verify the host-buffer correctness patch and independent per-request answers. Record MTP on/off, n=1/2/4/8 where supported, per-stream and aggregate throughput, cold/warm PLE pages, cold/warm prompt cache, and reasoning-enabled tool loops. Reject configurations with cross-request contamination, corrupt outputs, model/KV swapping, or loss of required SSD-table behavior.

No hardware tests have run in this repository. Published results above are attributed source measurements, not acceptance evidence for the incoming machine.

## Primary sources

- [Pinned EngramHalo README and launch configurations](https://github.com/Aristo94/EngramHalo.cpp/blob/cf4cd1eeecda8384f7418eb0221738ab874effe8/docs/strix-halo/README.md)
- [Pinned benchmark methods and results](https://github.com/Aristo94/EngramHalo.cpp/blob/cf4cd1eeecda8384f7418eb0221738ab874effe8/docs/strix-halo/BENCHMARKS.md)
- [Pinned loader implementation](https://github.com/Aristo94/EngramHalo.cpp/blob/cf4cd1eeecda8384f7418eb0221738ab874effe8/src/llama-model-loader.cpp)
- [Pinned model implementation](https://github.com/Aristo94/EngramHalo.cpp/blob/cf4cd1eeecda8384f7418eb0221738ab874effe8/src/models/qwen4exp.cpp)
- [MTP compatibility discussion](https://github.com/Aristo94/EngramHalo.cpp/issues/1)
- [kyuz0 toolbox packaging](https://github.com/kyuz0/amd-strix-halo-toolboxes)
