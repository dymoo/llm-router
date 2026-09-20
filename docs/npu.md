# Optional Laya NPU (not default)

Laya remains `LAYA_BACKEND=cpu`. Its optional ONNX/VitisAI path requires an IOMMU-enabled host and a successful operator-assignment probe before NPU serving; it is not automatically enabled by FastFlowLM.

No physical NPU execution has been tested here. The default Laya container does not mount `/dev/accel`. The separate optional **FastFlowLM** profile does mount the XDNA2 device for embeddings/STT; see [ai-hub.md](ai-hub.md). These are different runtimes and model formats.

## One-time Linux prerequisites (Ryzen AI Software 1.8.0)

Source: [Linux installation](https://ryzenai.docs.amd.com/en/latest/linux.html) (consulted 2026-09-20). Current release supports STX/KRK. Ubuntu + Python 3.12:

AMD documents BF16 encoder/NLP support on STX/KRK, not a prevalidated Laya graph on this exact Strix Halo machine. Treat this as a feasibility path, not a compatibility certificate. FastFlowLM explicitly lists Strix Halo for its own supported model binaries; that does not establish VitisAI support for arbitrary Laya operators. Keep CPU Laya until hardware/compiler assignment and output agreement pass.

```bash
sudo apt update
sudo apt install python3.12 python3.12-venv libboost-filesystem1.74.0 dkms
```

NPU/XRT packages from AMD's 1.8 Linux zip (`RAI_1.8_Linux_NPU_XRT.zip`):

```bash
sudo apt install --fix-broken -y ./xrt_202620.2.25.37_24.04-amd64-base.deb
sudo apt install --fix-broken -y ./xrt_202620.2.25.37_24.04-amd64-base-dev.deb
sudo apt install --fix-broken -y ./xrt_202620.2.25.37_24.04-amd64-npu.deb
sudo apt install --fix-broken -y ./xrt_plugin.2.25.260102.56.release_24.04-amd64-amdxdna.deb
```

Ryzen AI tarball `ryzen_ai-1.8.0.tgz`:

```bash
mkdir ryzen_ai-1.8.0 && tar -xvzf ryzen_ai-1.8.0.tgz -C ryzen_ai-1.8.0
./install_ryzen_ai.sh -a yes -p <TARGET-PATH>/venv
source <TARGET-PATH>/venv/bin/activate
source /opt/xilinx/xrt/setup.sh
export LD_LIBRARY_PATH=/lib/x86_64-linux-gnu:${RYZEN_AI_INSTALLATION_PATH}/onnxruntime/lib/:$LD_LIBRARY_PATH
```

Always re-source XRT after activating the venv.

## Driver verification (must pass before compile)

IOMMU must **not** be off:

```bash
scripts/npu-verify.sh
```

The script fails if `amd_iommu=off` / `iommu=off` is on the kernel command line, if PCI ID `1022:17f0` is missing, or if `xrt-smi examine` is unavailable. Expect `xrt-smi examine` to show an NPU (name may vary) with architecture `aie2p`.

Optional AMD quicktest (CNN, not Laya):

```bash
cd <TARGET-PATH>/venv/quicktest
python quicktest.py
```

Expect `Setting environment for STX/KRK` / `Test Finished`. That still is **not** a Laya VitisAI assignment report.

## Compile / probe / serve

Source of truth is `python -m laya_service` (not ops wrappers). Default Compose stays `LAYA_BACKEND=cpu` with `LAYA_MODEL_REVISION=1c5edc17a7acd8701df6fc341c0d179f1c62c982`. Root checkpoint max_len is 512 / head 192; do not assume 1k state.

```bash
python -m laya_service export --out /var/cache/laya/onnx \
  --model convaiinnovations/laya \
  --revision 1c5edc17a7acd8701df6fc341c0d179f1c62c982

# Operator-table check, no NPU device required:
python -m laya_service probe
python -m laya_service probe --onnx /var/cache/laya/onnx/laya.onnx --precision bf16

# Host-only. Requires IOMMU on, Ryzen AI 1.8, and npu-verify.sh PASS.
python -m laya_service compile \
  --onnx /var/cache/laya/onnx/laya.onnx \
  --context /var/cache/laya/ep-context/laya.epctx.onnx \
  --cache-dir /var/cache/laya/vaip \
  --report /var/cache/laya/vitisai_ep_report.json \
  --precision bf16 \
  --threshold 0.95
```

Compile must print assignment ≥ 0.95 before `LAYA_BACKEND=npu`. Anything less stays CPU. NPU serve is **on the host**, not the default Compose CPU image. Container `/dev/accel` passthrough is unverified. There is no silent CPU fallback inside NPU mode.

## Mutually exclusive with a Halogen IOMMU-off host

| Host | Halogen candidate | Laya |
| --- | --- | --- |
| `amd_iommu=off` (Halogen-only trade, if applied) | that candidate's previous host setting | CPU only |
| IOMMU enabled | may run, without that Halogen-specific trade | NPU possible after probe |

Do not treat `amd_iommu=off` as a generic router default. Do not enable NPU on a host that has IOMMU off.
