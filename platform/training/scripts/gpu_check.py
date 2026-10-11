"""TC-A01-03 的容器內檢查：GPU、CUDA、cuDNN、PyTorch、TensorFlow。
與 docs/acceptance-kit/m1/files/TC-A01-03-gpu-check.yaml 的指令相同（那個檔要能直接 kubectl apply，所以內容另外寫一份）。
  python gpu_check.py
"""
import os
import platform
import subprocess

print("節點:", os.environ.get("NODE_NAME", "?"), " Python:", platform.python_version())
try:
    out = subprocess.run(["nvidia-smi", "--query-gpu=index,name,driver_version,memory.total",
                          "--format=csv,noheader"], capture_output=True, text=True, timeout=30)
    print("nvidia-smi:", out.stdout.strip() or out.stderr.strip())
except FileNotFoundError:
    print("nvidia-smi: 容器內沒有 nvidia-smi")
try:
    import torch
    print("PyTorch:", torch.__version__, " CUDA:", torch.version.cuda,
          " cuDNN:", torch.backends.cudnn.version(), " GPU 數:", torch.cuda.device_count(),
          " 可用:", torch.cuda.is_available())
    if torch.cuda.is_available():
        x = torch.rand(1024, 1024, device="cuda")
        print("PyTorch GPU 運算:", float((x @ x).sum()) > 0)
except Exception as e:  # noqa: BLE001
    print("PyTorch: 失敗", type(e).__name__, e)
try:
    import tensorflow as tf
    info = tf.sysconfig.get_build_info()
    gpus = tf.config.list_physical_devices("GPU")
    print("TensorFlow:", tf.__version__, " CUDA:", info.get("cuda_version"), " cuDNN:", info.get("cudnn_version"),
          " GPU 數:", len(gpus))
    if gpus:
        with tf.device("/GPU:0"):
            print("TensorFlow GPU 運算:", float(tf.reduce_sum(tf.random.uniform((1024, 1024)))) > 0)
except Exception as e:  # noqa: BLE001
    print("TensorFlow: 失敗", type(e).__name__, e)
