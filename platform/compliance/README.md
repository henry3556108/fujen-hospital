# 合規與交付檢查（WP8）

`python -m compliance <檢查>`，每項檢查印一行 `PASS｜FAIL｜WARN  <TC ID>  <說明>`，失敗時結束碼非 0。
實際用到的映像與套件由部署檔**探索**（所有 compose 檔與疊加檔、kind 部署檔、部署腳本引用的遠端部署檔、Dockerfile、程式裡的預設映像、`uv.lock`、`package-lock.json`），不寫死清單；新服務合併後不用改程式。

```bash
uv sync
uv run python -m compliance discover                      # 看探索到什麼
uv run python -m compliance licences generate|check       # TC-D01-01 授權清單（docs/delivery/）
uv run python -m compliance packages generate|check       # TC-A01-04 映像內 Python 套件
uv run python -m compliance sources [--running --compose-project P --kube-context C]   # TC-D01-07 來源
uv run python -m compliance vulns [--fail-on HIGH]        # TC-D01-07 Trivy
uv run python -m compliance malware --compose-project P   # TC-D01-06 ClamAV 掃上傳區
uv run python -m compliance audit --compose-project P     # TC-D01-05、TC-DAILY-01
uv run python -m compliance monitoring                    # TC-DAILY-02（kind 叢集）
uv run python -m compliance secrets --compose-project P --gateway URL --keycloak URL --web-dist ../web/dist   # TC-SS-04
uv run python -m compliance report --checks <記錄檔>      # TC-DAILY-03，輸出 acceptance/reports/<日期>/
```

- 外部工具以釘住 digest 的容器執行，版本記在 `tools.lock.json`。快取（漏洞資料庫、病毒碼、遠端部署檔）在 `~/.cache/fujen-compliance`（`COMPLIANCE_CACHE` 可改），不進版本庫。
- `licences`／`packages` 會建置平台自建映像並以 Syft 掃描所有映像，第一次約需 20 分鐘；`--reuse` 沿用 `out/subjects.json`。
- 政策檔在 `policy/`：核准的映像來源、監控覆蓋例外、測試報告缺陷分級。
- 備份、還原與演練腳本在 `scripts/`，說明見 `docs/delivery/備份與還原說明.md`、`docs/delivery/部署說明.md`。
- 一鍵執行：`platform/scripts/test-all.sh --docker --kind --compliance`。
