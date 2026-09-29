#!/usr/bin/env bash
# 一鍵跑平台所有測試。
#   scripts/test-all.sh            不需 Docker：各子專案單元測試、網頁單元測試、S0 smoke
#   scripts/test-all.sh --e2e      另跑 Playwright（Chromium＋Edge，網頁測試模式）
#   scripts/test-all.sh --docker   另起 compose 環境跑經 Gateway 驗收（需 Docker）
#   scripts/test-all.sh --kind     另跑 kind 叢集的排程與監控測試（需先 deploy/kind/up.sh）
set -uo pipefail
cd "$(dirname "$0")/.."
E2E=0; DOCKER=0; KIND=0
for a in "$@"; do case $a in --e2e) E2E=1;; --docker) DOCKER=1;; --kind) KIND=1;; *) echo "未知參數 $a"; exit 2;; esac; done

declare -a RESULTS; FAILED=0
run() {  # run <名稱> <目錄> <指令...>
  local name=$1 dir=$2; shift 2
  printf '\n==== %s ====\n' "$name"
  local out; out=$(cd "$dir" && "$@" 2>&1); local rc=$?
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

printf '\n==== 總結 ====\n'; printf '%s\n' "${RESULTS[@]}"
exit $FAILED
