"""TC-SS-04 金鑰不外洩：API 回應（已登入與未登入）與前端打包檔都不可出現部署檔裡的機密值。

實作在 platform/compliance（python -m compliance secrets），這裡只包成 pytest 案例，讓測試報告對得上 TC ID。
需要 COMPOSE_PROJECT；前端打包檔由 WEB_DIST 指定（未設定時只掃 API 回應）。
"""
import os
import subprocess
from pathlib import Path

import pytest

COMPLIANCE = Path(__file__).resolve().parents[1] / "compliance"
PROJECT = os.environ.get("COMPOSE_PROJECT")
K8S_NAMESPACE = os.environ.get("K8S_NAMESPACE")   # Kubernetes 部署：另比對叢集 Secret 的實際值


@pytest.mark.skipif(not (PROJECT or K8S_NAMESPACE), reason="設定 COMPOSE_PROJECT 或 K8S_NAMESPACE 才能列出 API 端點")
def test_tc_ss_04_no_secret_in_api_responses_or_bundle():
    target = ["--kube-namespace", K8S_NAMESPACE] if K8S_NAMESPACE else ["--compose-project", PROJECT]
    cmd = ["uv", "run", "-q", "python", "-m", "compliance", "secrets", *target,
           "--gateway", os.environ.get("GATEWAY_URL", "http://localhost:9080"),
           "--keycloak", os.environ.get("KEYCLOAK_URL", "http://localhost:8080")]
    if os.environ.get("WEB_DIST"):
        cmd += ["--web-dist", os.environ["WEB_DIST"]]
    out = subprocess.run(cmd, cwd=COMPLIANCE, capture_output=True, text=True, timeout=600)
    assert out.returncode == 0, out.stdout + out.stderr
    assert "明文出現 0 次" in out.stdout
