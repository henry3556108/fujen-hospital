"""8 類稽核抽查（TC-D01-05）與每日覆蓋（TC-DAILY-01）。

資料從平台資料庫的 audit_log 讀出（compose 堆疊內的 PostgreSQL，或任何可連的 psql）。
沒有產生者的類別會照實回報 0 筆並失敗，不會被當成通過。
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field

CATEGORIES = ["account", "role", "permission", "project", "dataset", "training", "inference", "data_exchange"]
LABELS = {"account": "帳號", "role": "角色", "permission": "權限", "project": "專案", "dataset": "資料集",
          "training": "訓練", "inference": "推論", "data_exchange": "資料交換"}
# 契約 TC-SS-06：誰、何時、類別、動作、對象、結果、來源 IP
REQUIRED = ["actor", "at", "category", "action", "target", "result", "source_ip"]
PER_CATEGORY = 3

SAMPLE_SQL = f"""
select coalesce(json_agg(t order by t.category, t.at desc), '[]'::json) from (
  select id, actor, at, category, action, target, result, source_ip,
         row_number() over (partition by category order by at desc, id desc) as n
  from audit_log) t where t.n <= {PER_CATEGORY}
"""
COUNT_SQL = "select coalesce(json_object_agg(category, n), '{}'::json) from (select category, count(*) n from audit_log group by category) c"


@dataclass
class AuditReport:
    counts: dict[str, int] = field(default_factory=dict)
    samples: list[dict] = field(default_factory=list)
    missing_fields: list[str] = field(default_factory=list)   # 「類別 #id 缺 欄位」
    short: dict[str, int] = field(default_factory=dict)       # 類別 → 抽到的筆數（不足 3）
    unknown: dict[str, int] = field(default_factory=dict)     # 不屬於 8 類的類別

    @property
    def sampled(self) -> int:
        return len([s for s in self.samples if s["category"] in CATEGORIES])

    @property
    def sample_ok(self) -> bool:            # TC-D01-05
        return not self.short and not self.missing_fields and not self.unknown

    @property
    def daily_ok(self) -> bool:             # TC-DAILY-01
        return all(self.counts.get(c, 0) > 0 for c in CATEGORIES) and not self.unknown


def evaluate(samples: list[dict], counts: dict[str, int]) -> AuditReport:
    report = AuditReport(counts={c: int(counts.get(c, 0)) for c in CATEGORIES}, samples=samples)
    report.unknown = {c: int(n) for c, n in counts.items() if c not in CATEGORIES}
    by_cat: dict[str, int] = {}
    for row in samples:
        cat = row.get("category")
        by_cat[cat] = by_cat.get(cat, 0) + 1
        for name in REQUIRED:
            value = row.get(name)
            if value is None or (isinstance(value, str) and not value.strip()):
                report.missing_fields.append(f"{LABELS.get(cat, cat)} #{row.get('id')} 缺 {name}")
    report.short = {c: by_cat.get(c, 0) for c in CATEGORIES if by_cat.get(c, 0) < PER_CATEGORY}
    return report


def psql_json(compose_project: str, sql: str) -> object:
    """在 compose 專案的 postgres 容器裡執行查詢，回傳 JSON。"""
    proc = subprocess.run(["docker", "compose", "-p", compose_project, "exec", "-T", "postgres",
                           "psql", "-U", "platform", "-d", "platform", "-tAc", sql],
                          capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(f"讀取稽核資料失敗：{proc.stderr.strip()[-300:]}")
    return json.loads(proc.stdout.strip() or "null")


def collect(compose_project: str) -> AuditReport:
    return evaluate(psql_json(compose_project, SAMPLE_SQL) or [], psql_json(compose_project, COUNT_SQL) or {})
