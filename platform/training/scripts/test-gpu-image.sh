#!/usr/bin/env bash
# 在 GPU 訓練映像（platform-trainer-gpu）內驗證：
#   1. TC-A01-03 的 GPU 檢查：PyTorch、TensorFlow 都看得到 GPU 且能運算
#   2. 影像範本測試（tests/test_image_templates.py）：tensorflow 與 torch 兩種 Keras 後端，在 GPU 上訓練、
#      重跑 3 次權重逐位元相同（TC-B05-04）、H5 在平台外可載入（TC-B05-06）
#   3. 沒有 GPU 時（kind 的假 GPU 節點）同一個映像改用 CPU，影像分類仍能訓練
# 需要 Docker 與 NVIDIA Container Toolkit（docker run --gpus）。合成資料在主機以 uv 產生後掛進容器。
#   ./test-gpu-image.sh                      全部
#   IMAGE=<映像> ./test-gpu-image.sh         指定映像（預設 platform-trainer-gpu:dev）
#   ONLY=check ./test-gpu-image.sh           只跑第 1 項
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLATFORM_DIR="$(cd "$HERE/../.." && pwd)"
IMAGE="${IMAGE:-platform-trainer-gpu:dev}"
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
run() {  # run <docker 參數…> -- <指令…>：以 root 執行（要在容器內 pip install pytest），原始碼唯讀掛載
  docker run --rm --ipc=host --user root -e PYTHONDONTWRITEBYTECODE=1 \
    -v "$PLATFORM_DIR:/src:ro" "$@"
}

log "1. GPU 檢查（TC-A01-03）：$IMAGE"
run --gpus all "$IMAGE" python /src/training/scripts/gpu_check.py
[ "${ONLY:-}" = check ] && exit 0

SYNTH="$(mktemp -d)"
trap 'rm -rf "$SYNTH"' EXIT
log "產生合成資料"
(cd "$PLATFORM_DIR/tools/synth" && uv run -q python -m synth all --out "$SYNTH")
chmod -R a+rX "$SYNTH"
TESTS="pip install -q --root-user-action=ignore pytest && cd /src/training && python -m pytest -p no:cacheprovider -q"

log "2. 影像範本測試（GPU，tensorflow 與 torch 兩種後端）"
run --gpus all -v "$SYNTH:/synth:ro" -e SYNTH_DIR=/synth "$IMAGE" bash -c "$TESTS -m keras tests/test_image_templates.py"

log "3. 沒有 GPU 時改用 CPU（影像分類，tensorflow 後端）"
run -v "$SYNTH:/synth:ro" -e SYNTH_DIR=/synth "$IMAGE" \
  bash -c "$TESTS tests/test_image_templates.py -k 'classification_trains and tensorflow'"
log "完成"
