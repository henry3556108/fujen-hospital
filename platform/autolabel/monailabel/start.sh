#!/bin/sh
# 啟動 MONAI Label（radiology app）。設定見 Dockerfile.monailabel 的 ENV。
#   use_pretrained_model=false：權重已烤在映像內，不再連網下載
#   sam2=false、scribbles=false：只提供分割模型（平台的規格 1.0 只用 segmentation／detection）
#   skip_scoring、skip_strategy：平台不用主動學習，不在背景掃描資料夾
set -eu
mkdir -p "$MONAI_LABEL_STUDIES"
exec monailabel start_server \
  --app /opt/monailabel/apps/radiology \
  --studies "$MONAI_LABEL_STUDIES" \
  --host 0.0.0.0 --port "$MONAI_LABEL_PORT" \
  --conf models "$MONAI_LABEL_MODELS" \
  --conf use_pretrained_model false \
  --conf sam2 false \
  --conf scribbles false \
  --conf skip_scoring true \
  --conf skip_strategy true
