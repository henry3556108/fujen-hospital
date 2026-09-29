#!/usr/bin/env bash
# 一鍵跑平台所有測試。
#   scripts/test-all.sh            不需 Docker：各子專案單元測試、網頁單元測試、S0 smoke
#   scripts/test-all.sh --e2e      另跑 Playwright（Chromium＋Edge，網頁測試模式）
#   scripts/test-all.sh --docker   另起 compose 環境跑經 Gateway 驗收（需 Docker）
#   scripts/test-all.sh --kind     另跑 kind 叢集的排程與監控測試（需先 deploy/kind/up.sh）
#   scripts/test-all.sh --compliance  另跑合規檢查（授權清單、來源、漏洞、稽核與監控覆蓋、機密、掃毒）並彙整測試報告
#                                     compose 專案由 COMPOSE_PROJECT 指定（預設 ai-platform）；會重新掃描所有映像，約需 30 分鐘以上
set -uo pipefail
cd "$(dirname "$0")/.."
E2E=0; DOCKER=0; KIND=0; COMPLIANCE=0
for a in "$@"; do case $a in --e2e) E2E=1;; --docker) DOCKER=1;; --kind) KIND=1;; --compliance) COMPLIANCE=1;; *) echo "未知參數 $a"; exit 2;; esac; done

RESULTS=(); FAILED=0
JUNIT_DIR="$PWD/acceptance/reports/junit"; rm -rf "$JUNIT_DIR"; mkdir -p "$JUNIT_DIR"
run() {  # run <名稱> <目錄> <指令...>
  local name=$1 dir=$2; shift 2
  printf '\n==== %s ====\n' "$name"
  # pytest 的結果另存 junit，供 --compliance 彙整測試報告（TC-DAILY-03）
  local junit; junit="$JUNIT_DIR/$(printf '%02d' ${#RESULTS[@]})-$(echo "$dir" | tr / -).xml"
  local out; out=$(cd "$dir" && PYTEST_ADDOPTS="--junitxml=$junit" "$@" 2>&1); local rc=$?
  echo "$out" | tail -4
  local summary; summary=$(echo "$out" | grep -E "passed|failed|Tests " | tail -1 | sed 's/^[ =]*//')
  if [ $rc -eq 0 ]; then RESULTS+=("PASS  $name  $summary"); else RESULTS+=("FAIL  $name  $summary"); FAILED=1; fi
}

PYTEST=(uv run -q pytest -q -p no:cacheprovider)
run "平台 API 單元"      api            "${PYTEST[@]}"
run "結構式函式庫"        libs/tabular   "${PYTEST[@]}"
run "合成資料"            tools/synth    "${PYTEST[@]}"
run "匯入 CLI"            tools/importer "${PYTEST[@]}"
run "假模型服務"          fakes          "${PYTEST[@]}"
run "訓練範本與推論服務"  training       uv run -q --extra keras pytest -q -p no:cacheprovider
run "網頁單元"            web            npm test --silent
run "S0 smoke"            smoke          "${PYTEST[@]}" -rs

if [ $E2E -eq 1 ]; then
  run "Playwright"        web            npx playwright test
fi

if [ $DOCKER -eq 1 ]; then
  (cd deploy/local && docker compose up -d --build --wait && docker compose exec -T api /app/.venv/bin/python -m app.seed >/dev/null)
  run "經 Gateway 驗收"   acceptance     env COMPOSE_PROJECT=ai-platform PACS_URL=http://127.0.0.1:8043 "${PYTEST[@]}"
fi

if [ $KIND -eq 1 ]; then
  run "kind 叢集"         api            "${PYTEST[@]}" -m kind ../acceptance/test_tc_a02_gpu.py ../acceptance/test_tc_c01.py ../acceptance/test_tc_c02.py
fi

if [ $COMPLIANCE -eq 1 ]; then
  CHECKS="$JUNIT_DIR/compliance-checks.log"; : > "$CHECKS"
  PROJECT="${COMPOSE_PROJECT:-ai-platform}"
  comp() {  # comp <名稱> <compliance 子指令...>：總結行記到 CHECKS，給測試報告用
    printf '\n==== 合規：%s ====\n' "$1"; local name=$1; shift
    local out; out=$(cd compliance && uv run -q python -m compliance "$@" 2>&1); local rc=$?
    echo "$out" | tail -6; echo "$out" | grep -E '^(PASS|FAIL|WARN) ' >> "$CHECKS"
    if [ $rc -eq 0 ]; then RESULTS+=("PASS  合規 $name"); else RESULTS+=("FAIL  合規 $name"); FAILED=1; fi
  }
  run "合規工具單元"      compliance     "${PYTEST[@]}"
  comp "授權清單"          licences check
  comp "映像內 Python 套件" packages check --reuse
  comp "映像來源"          sources
  comp "漏洞掃描"          vulns
  if [ $KIND -eq 1 ]; then comp "監控覆蓋" monitoring; fi
  if [ $DOCKER -eq 1 ]; then
    comp "8 類稽核"        audit --compose-project "$PROJECT"
    comp "機密外洩"        secrets --compose-project "$PROJECT" --gateway http://localhost:${GATEWAY_HOST_PORT:-9080} \
                               --keycloak http://localhost:${KEYCLOAK_HOST_PORT:-8080}
    comp "上傳區掃毒"      malware --compose-project "$PROJECT"
  fi
  comp "測試報告"          report --checks "$CHECKS"
fi

printf '\n==== 總結 ====\n'; printf '%s\n' "${RESULTS[@]}"
exit $FAILED
