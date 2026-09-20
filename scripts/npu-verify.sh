#!/usr/bin/env bash
# Host-only. Default deployment is Laya CPU + Halogen with amd_iommu=off,
# which makes the NPU unavailable. Run this only on the AMD Linux box after
# enabling IOMMU and rebooting. Does not edit the bootloader.
set -euo pipefail

echo "This host kernel cmdline:"
tr ' ' '\n' < /proc/cmdline | sed -n '1,200p'

if grep -Eq 'amd_iommu=off|iommu=off' /proc/cmdline; then
  echo "FAIL: IOMMU is off on this kernel. NPU is unavailable. Default Halogen host uses this setting."
  echo "NPU requires IOMMU enabled and a reboot; that is mutually exclusive with the default Halogen host."
  exit 1
fi

if ! command -v lspci >/dev/null; then
  echo "FAIL: lspci not found"
  exit 1
fi

if ! lspci -nn | grep -q '1022:17f0'; then
  echo "FAIL: PCI ID 1022:17f0 (STX/KRK NPU) not present"
  lspci -nn | sed -n '1,80p' || true
  exit 1
fi
echo "OK: lspci shows 1022:17f0"

if [[ ! -f /opt/xilinx/xrt/setup.sh ]]; then
  echo "FAIL: /opt/xilinx/xrt/setup.sh missing. Install Ryzen AI 1.8 Linux NPU/XRT packages first (docs/npu.md)."
  exit 1
fi

# shellcheck disable=SC1091
source /opt/xilinx/xrt/setup.sh

if ! command -v xrt-smi >/dev/null; then
  echo "FAIL: xrt-smi not on PATH after sourcing XRT"
  exit 1
fi

echo "xrt-smi examine:"
xrt-smi examine

echo "Expect Device Name containing NPU Strix (or the NPU name for this machine) and Architecture aie2p."
echo "Driver verification only. This is not a VitisAI assignment report and not a Laya NPU enable."
