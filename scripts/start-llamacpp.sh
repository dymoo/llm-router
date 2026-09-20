#!/bin/sh
set -eu

if [ -z "${LLAMA_ARG_MODEL:-}" ] || [ ! -f "$LLAMA_ARG_MODEL" ]; then
  echo "Set LLAMACPP_MODELS_DIR and LLAMACPP_MODEL_FILE to a mounted GGUF before starting llama.cpp." >&2
  exit 2
fi
case "${LLAMA_ARG_LOAD_MODE:-}/${LLAMA_ARG_LAZY_MODE:-}" in
  mmap/on|none/on-direct) ;;
  *) echo "This profile requires SSD-backed PLE: mmap/on, or a compatible fork's none/on-direct." >&2; exit 2 ;;
esac
binary="${LLAMACPP_SERVER_BIN:-/app/llama-server}"
if [ ! -x "$binary" ]; then
  echo "LLAMACPP_SERVER_BIN is not executable in the selected LLAMACPP_IMAGE." >&2
  exit 2
fi
exec "$binary" "$@"
