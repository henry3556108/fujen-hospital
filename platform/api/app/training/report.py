"""訓練報表：一頁可列印的 HTML（設定、指標與白話說明、K 折平均±標準差、圖表），給不寫程式的使用者存檔或列印。

圖表以內嵌 SVG 畫出，不載入任何外部資源、不含程式碼；使用者輸入的文字一律跳脫。
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from html import escape
from typing import Any

from app.training.config import KIND_NAMES

ALGORITHM_NAMES = {
    "logistic_regression": "邏輯斯迴歸（Logistic Regression）",
    "linear_regression": "線性迴歸（Linear Regression）",
    "random_forest": "隨機森林（Random Forest）",
    "gradient_boosting": "梯度提升（Gradient Boosting）",
    "fake": "快速測試（未真正訓練）",
}

# 指標：(顯示名稱, 一句話說明什麼叫好)
METRICS = {
    "accuracy": ("準確率", "預測正確的比例（0～1）。越接近 1 越好；請和「全部都猜最常見的那一類」的比例比較，高出越多越有用。"),
    "f1_macro": ("F1 分數（各類平均）", "同時考慮「抓得到」與「抓得準」，各類別平均（0～1）。越接近 1 越好；類別人數不平均時比準確率可靠。"),
    "auc": ("AUC（ROC 曲線下面積）", "隨機挑一位陽性與一位陰性，模型把陽性排在前面的機率。0.5 等於亂猜，0.7 以上尚可，0.8 以上良好，0.9 以上優秀。"),
    "sensitivity": ("敏感度", "實際為陽性的人當中，模型抓到的比例（0～1）。越高代表越少漏掉病人。"),
    "specificity": ("特異度", "實際為陰性的人當中，模型正確判為陰性的比例（0～1）。越高代表越少誤報。"),
    "baseline_accuracy": ("比較基準：全部猜訓練資料最常見的類別", "什麼都不學、每個人都猜訓練資料中最常見的那一類時的準確率。模型的準確率要明顯高於它才有用。"),
    "baseline_rmse": ("比較基準：每次都猜平均值", "什麼都不學、每次都猜訓練資料平均值的 RMSE。模型的 RMSE 要明顯低於它才有用。"),
    "r2": ("R²（解釋量）", "模型能解釋結果高低差異的比例。1 為完美，0 等於每次都猜平均值，負數代表比猜平均值還差；越接近 1 越好。"),
    "rmse": ("RMSE（均方根誤差）", "預測值平均偏離實際值多少，單位與目標欄位相同，越小越好；大錯會被放大計算。"),
    "mae": ("MAE（平均絕對誤差）", "預測值與實際值差距的平均，單位與目標欄位相同，越小越好。"),
    "pixel_accuracy": ("像素準確率", "每個像素分類正確的比例（0～1）。背景很多時容易偏高，請一併看 Dice。"),
    "dice": ("Dice 係數", "預測區域與標註區域的重疊程度（0～1）。越接近 1 越好，一般 0.7 以上算不錯。"),
    "mean_iou": ("平均 IoU", "預測方框與標註方框的重疊比例（0～1）。越接近 1 越好，0.5 以上通常算有框到。"),
    "score": ("分數（快速測試）", "快速測試產生的亂數，沒有意義。"),
}
SPLIT_NAMES = {"test": "測試集", "validation": "驗證集", "train": "訓練集"}
SUBSET_NOTES = {"test": "圖表以測試集（訓練時沒看過的資料）計算。",
                "validation": "沒有測試集，圖表以驗證集計算。",
                "train": "沒有測試集與驗證集，圖表以訓練資料計算，結果可能過度樂觀。"}

COLOR = "#1f5fa8"
GRID = "#d0d7de"
TEXT = "#24292f"


def _fmt(value: Any, digits: int = 4) -> str:
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, int):
        return f"{value:,}"
    if isinstance(value, float):
        if not math.isfinite(value):
            return "—"
        return f"{value:.{digits}g}" if abs(value) < 1e-4 and value != 0 else f"{round(value, digits):g}"
    return escape(str(value))


def _e(value: Any) -> str:
    return escape(str(value), quote=True)


def validation_text(config: dict) -> str:
    split = config.get("split") or {}
    pct = {k: f"{round(float(split.get(k, 0)) * 100, 1):g}%" for k in ("train", "validation", "test")}
    validation = config.get("validation") or {"method": "holdout"}
    if validation.get("method") == "kfold":
        return f"K 折交叉驗證（K = {validation['folds']}），另保留測試集 {pct['test']}"
    return f"固定比例切分（訓練 {pct['train']}、驗證 {pct['validation']}、測試 {pct['test']}）"


# ---------------------------------------------------------------- SVG

W, H = 480, 300
ML, MR, MT, MB = 56, 16, 12, 44


def _ticks(lo: float, hi: float, count: int = 5) -> tuple[float, float, list[float]]:
    if not (math.isfinite(lo) and math.isfinite(hi)):
        lo, hi = 0.0, 1.0
    if lo == hi:
        pad = abs(lo) or 1.0
        lo, hi = lo - pad / 2, hi + pad / 2
    raw = (hi - lo) / count
    power = 10 ** math.floor(math.log10(raw))
    step = next((s * power for s in (1, 2, 2.5, 5, 10) if s * power >= raw), 10 * power)
    start, end = math.floor(lo / step) * step, math.ceil(hi / step) * step
    ticks, value = [], start
    while value <= end + step / 1e6:
        ticks.append(round(value, 10))
        value += step
    return start, end, ticks


class _Plot:
    def __init__(self, x: tuple[float, float], y: tuple[float, float], x_label: str, y_label: str):
        self.x0, self.x1, self.xt = _ticks(*x)
        self.y0, self.y1, self.yt = _ticks(*y)
        self.parts = [f'<svg viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" '
                      f'xmlns="http://www.w3.org/2000/svg" font-size="11" fill="{TEXT}">']
        pw, ph = W - ML - MR, H - MT - MB
        self.px = lambda v: ML + (v - self.x0) / (self.x1 - self.x0) * pw
        self.py = lambda v: MT + (1 - (v - self.y0) / (self.y1 - self.y0)) * ph
        for t in self.yt:
            self.parts.append(f'<line x1="{ML}" x2="{W - MR}" y1="{self.py(t):.1f}" y2="{self.py(t):.1f}" '
                              f'stroke="{GRID}"/><text x="{ML - 6}" y="{self.py(t) + 4:.1f}" '
                              f'text-anchor="end">{t:g}</text>')
        for t in self.xt:
            self.parts.append(f'<text x="{self.px(t):.1f}" y="{MT + ph + 16}" text-anchor="middle">{t:g}</text>')
        self.parts.append(f'<line x1="{ML}" x2="{W - MR}" y1="{MT + ph}" y2="{MT + ph}" stroke="{TEXT}"/>')
        self.parts.append(f'<text x="{ML + pw / 2}" y="{H - 6}" text-anchor="middle">{_e(x_label)}</text>')
        self.parts.append(f'<text transform="translate(14 {MT + ph / 2}) rotate(-90)" '
                          f'text-anchor="middle">{_e(y_label)}</text>')

    def line(self, a: tuple[float, float], b: tuple[float, float], dashed: bool = True) -> None:
        dash = ' stroke-dasharray="4 4"' if dashed else ""
        self.parts.append(f'<line x1="{self.px(a[0]):.1f}" y1="{self.py(a[1]):.1f}" x2="{self.px(b[0]):.1f}" '
                          f'y2="{self.py(b[1]):.1f}" stroke="#6e7781"{dash}/>')

    def svg(self) -> str:
        return "".join(self.parts) + "</svg>"


def roc_svg(roc: dict) -> str:
    plot = _Plot((0, 1), (0, 1), "偽陽性率（1 − 特異度）", "真陽性率（敏感度）")
    plot.line((0, 0), (1, 1))
    path = " ".join(f"{'M' if i == 0 else 'L'}{plot.px(x):.1f},{plot.py(y):.1f}"
                    for i, (x, y) in enumerate(roc["points"]))
    plot.parts.append(f'<path d="{path}" fill="none" stroke="{COLOR}" stroke-width="2"/>')
    return plot.svg()


def scatter_svg(points: list[list[float]], x_label: str, y_label: str, *, diagonal: bool) -> str:
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    lo, hi = min(xs + ys), max(xs + ys)
    plot = _Plot((lo, hi), (lo, hi), x_label, y_label)
    if diagonal:
        plot.line((plot.x0, plot.x0), (plot.x1, plot.x1))
    for x, y in points:
        plot.parts.append(f'<circle cx="{plot.px(x):.1f}" cy="{plot.py(y):.1f}" r="3" fill="{COLOR}" '
                          f'fill-opacity="0.7"/>')
    return plot.svg()


def histogram_svg(bins: list[dict], x_label: str) -> str:
    plot = _Plot((bins[0]["start"], bins[-1]["end"]), (0, max(1, max(b["count"] for b in bins))), x_label, "筆數")
    for b in bins:
        x0, x1, top = plot.px(b["start"]), plot.px(b["end"]), plot.py(b["count"])
        plot.parts.append(f'<rect x="{x0 + 1:.1f}" y="{top:.1f}" width="{max(1.0, x1 - x0 - 2):.1f}" '
                          f'height="{plot.py(0) - top:.1f}" fill="{COLOR}"/>')
    plot.line((0, plot.y0), (0, plot.y1), dashed=True)
    return plot.svg()


def importance_svg(items: list[dict], metric: str) -> str:
    items = items[:15]
    row, left, width = 22, 150, W - 150 - 24
    height = MT + row * len(items) + 30
    top = max([i["mean"] for i in items] + [1e-9])
    low = min([i["mean"] for i in items] + [0.0])
    span = top - low
    zero = left + (0 - low) / span * width
    parts = [f'<svg viewBox="0 0 {W} {height}" width="{W}" height="{height}" role="img" '
             f'xmlns="http://www.w3.org/2000/svg" font-size="11" fill="{TEXT}">']
    for n, item in enumerate(items):
        y = MT + n * row
        x0 = left + (min(item["mean"], 0) - low) / span * width
        w = abs(item["mean"]) / span * width
        parts.append(f'<text x="{left - 6}" y="{y + 14}" text-anchor="end">{_e(item["feature"])}</text>'
                     f'<rect x="{x0:.1f}" y="{y + 3}" width="{max(w, 0.5):.1f}" height="{row - 8}" fill="{COLOR}"/>'
                     f'<text x="{x0 + w + 4:.1f}" y="{y + 14}">{item["mean"]:.3g}</text>')
    parts.append(f'<line x1="{zero:.1f}" x2="{zero:.1f}" y1="{MT}" y2="{MT + row * len(items)}" stroke="{TEXT}"/>')
    parts.append(f'<text x="{left + width / 2}" y="{height - 8}" text-anchor="middle">'
                 f'打亂這個特徵後 {_e(METRICS.get(metric, (metric,))[0])} 下降多少</text></svg>')
    return "".join(parts)


def confusion_table(cm: dict) -> str:
    labels, matrix = cm["labels"], cm["matrix"]
    peak = max([v for row in matrix for v in row] + [1])
    head = "".join(f"<th scope=\"col\">預測 {_e(label)}</th>" for label in labels)
    rows = []
    for label, row in zip(labels, matrix):
        total = sum(row) or 1
        cells = "".join(
            f'<td style="background: rgba(31,95,168,{0.08 + 0.6 * v / peak:.2f})">{v}'
            f'<span class="pct">（{v / total:.0%}）</span></td>' for v in row)
        rows.append(f"<tr><th scope=\"row\">實際 {_e(label)}</th>{cells}</tr>")
    return f'<table class="cm"><thead><tr><th></th>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table>'


# ---------------------------------------------------------------- HTML

def _metric_rows(metrics: dict) -> str:
    rows = []
    for split in ("test", "validation", "train"):
        values = metrics.get(split)
        if not isinstance(values, dict):
            continue
        for name, value in values.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                label, help_text = METRICS.get(name, (name, ""))
                rows.append(f"<tr><td>{SPLIT_NAMES[split]}</td><th scope=\"row\">{_e(label)}</th>"
                            f"<td class=\"num\">{_fmt(value)}</td><td>{_e(help_text)}</td></tr>")
    if not rows:
        return "<p>這次訓練沒有指標。</p>"
    return ("<table><thead><tr><th>資料</th><th>指標</th><th>數值</th><th>怎麼看</th></tr></thead>"
            f"<tbody>{''.join(rows)}</tbody></table>")


def _cv_rows(cv: dict) -> str:
    rows = []
    for name, value in cv.items():
        if isinstance(value, dict) and "mean" in value:
            label, help_text = METRICS.get(name, (name, ""))
            folds = "、".join(_fmt(v) for v in value["values"])
            rows.append(f"<tr><th scope=\"row\">{_e(label)}</th><td class=\"num\">{_fmt(value['mean'])} ± "
                        f"{_fmt(value['std'])}</td><td>{folds}</td><td>{_e(help_text)}</td></tr>")
    note = "" if cv.get("stratified") or cv.get("method") != "kfold" else \
        "<p class=\"note\">有類別的資料筆數少於 K，各折未依類別比例分配。</p>"
    return (f"<p>{cv.get('rows', '—')} 筆資料分成 {cv.get('folds')} 折，輪流驗證。平均值越高（誤差類越低）越好；"
            "標準差越小代表結果越穩定，不是剛好碰到容易的資料。</p>" + note +
            "<table><thead><tr><th>指標</th><th>平均 ± 標準差</th><th>各折</th><th>怎麼看</th></tr></thead>"
            f"<tbody>{''.join(rows)}</tbody></table>")


def _charts(charts: dict | None, target: str) -> str:
    if not charts:
        return "<p>這次訓練沒有圖表資料（影像訓練、快速測試或舊版訓練只提供指標）。</p>"
    parts = [f"<p class=\"note\">{SUBSET_NOTES.get(charts.get('subset'), '')}（{charts.get('rows', 0)} 筆）</p>"]
    if charts.get("confusion_matrix"):
        parts.append("<h3>混淆矩陣</h3><p>每一列是實際類別、每一欄是模型預測；對角線（左上到右下）是預測正確的人數，"
                     "越集中在對角線越好。</p>" + confusion_table(charts["confusion_matrix"]))
    if charts.get("roc"):
        roc = charts["roc"]
        parts.append(f"<h3>ROC 曲線（陽性＝{_e(roc['positive'])}，AUC {_fmt(roc['auc'])}）</h3>"
                     "<p>曲線越往左上角彎越好；虛線是亂猜。</p>" + roc_svg(roc))
    regression = charts.get("regression")
    if regression and regression.get("points"):
        sampled = f"（共 {regression['total']} 筆，畫出 {len(regression['points'])} 筆）" if regression["sampled"] else ""
        parts.append(f"<h3>預測值與實際值{sampled}</h3><p>點越貼近虛線（預測＝實際）越好。</p>" +
                     scatter_svg(regression["points"], f"實際 {target}", f"預測 {target}", diagonal=True))
    if regression and regression.get("residuals"):
        parts.append("<h3>殘差分布</h3><p>殘差＝實際值 − 預測值。集中在 0 附近、左右大致對稱較好；"
                     "偏向一邊代表模型習慣高估或低估。</p>" + histogram_svg(regression["residuals"], "殘差"))
    importance = charts.get("feature_importance")
    if importance and importance.get("items"):
        parts.append("<h3>特徵重要性</h3><p>把一個特徵的值隨機打亂後分數下降越多，代表模型越依賴它。"
                     "這只代表模型的依賴程度，不代表因果關係；接近 0 或負值代表幾乎沒用到。</p>" +
                     importance_svg(importance["items"], importance["metric"]))
    return "".join(parts)


STYLE = """
body { font-family: "Noto Sans TC", "Microsoft JhengHei", sans-serif; color: #24292f; max-width: 900px;
       margin: 24px auto; padding: 0 16px; line-height: 1.6; }
h1 { font-size: 1.5rem; margin-bottom: 0; } h2 { font-size: 1.2rem; border-bottom: 1px solid #d0d7de;
padding-bottom: 4px; margin-top: 28px; } h3 { font-size: 1.05rem; margin-bottom: 4px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 0.92rem; }
th, td { border: 1px solid #d0d7de; padding: 4px 8px; text-align: left; vertical-align: top; }
td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
table.cm { width: auto; } table.cm td { text-align: center; min-width: 5rem; }
.pct { color: #57606a; font-size: 0.85em; } .note { color: #57606a; } .meta { color: #57606a; margin-top: 0; }
svg { max-width: 100%; height: auto; display: block; margin: 8px 0; }
@media print { body { margin: 0; max-width: none; } h2, h3, table, svg { break-inside: avoid; } }
"""


def data_text(data: dict | None) -> str:
    """一句話說明這次訓練用了幾位病人、哪些沒用與原因、補了幾位的缺值（metrics.json 的 data）。"""
    if not isinstance(data, dict):
        return ""
    used = data.get("used") or {}
    names = {"train": "訓練", "validation": "驗證", "test": "測試"}
    parts = "、".join(f"{names[k]} {used[k]} 位" for k in ("train", "validation", "test") if used.get(k))
    text = f"共 {data.get('total', sum(used.values()))} 位病人，{parts}。"
    left = data.get("left_out") or {}
    target = sum(v.get("missing_target", 0) for v in left.values())
    feature = sum(v.get("missing_feature", 0) for v in left.values())
    filled = sum((data.get("filled") or {}).values())
    columns = "、".join(f"{c} {n} 位" for c, n in (data.get("missing_columns") or {}).items())
    if target:
        text += f"目標欄位缺值的 {target} 位沒有使用。"
    if feature:
        text += f"特徵有缺值的 {feature} 位沒有使用（缺值：{columns}）。"
    if filled:
        text += f"有 {filled} 位的缺值（{columns}）已用訓練資料的中位數或最常見的值補上。"
    return text


PRIMARY = {"tabular_classification": ("auc", "accuracy"), "tabular_regression": ("r2",),
           "image_classification": ("accuracy",), "image_segmentation": ("dice", "pixel_accuracy"),
           "image_detection": ("mean_iou",)}
PERCENT = {"accuracy", "sensitivity", "specificity", "baseline_accuracy", "pixel_accuracy"}


def _numbers(value: Any) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    return {k: v for k, v in value.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}


def _sources(metrics: dict) -> list[tuple[str, dict[str, float]]]:
    """結論用的數字來源，依可靠程度：K 折平均、測試集、驗證集、訓練集。"""
    out = []
    cv = metrics.get("cv")
    if isinstance(cv, dict) and cv.get("folds"):
        out.append((f"{cv['folds']} 折平均", {k: v["mean"] for k, v in cv.items() if isinstance(v, dict) and "mean" in v}))
    for split, label in (("test", "測試集"), ("validation", "驗證集"), ("train", "訓練集，可能過度樂觀")):
        scores = _numbers(metrics.get(split))
        if scores:
            out.append((label, scores))
    return out


def _step(value: float, levels: list[tuple[float, str]], last: str) -> str:
    return next((name for at, name in levels if value >= at), last)


def grade(name: str, value: float, baseline: float | None = None) -> str | None:
    """等級門檻與網頁 platform/web/src/pages/training/metrics.ts 的 grade() 相同。"""
    if name == "auc":
        return _step(value, [(0.9, "優秀"), (0.8, "良好"), (0.7, "尚可"), (0.55, "偏弱")], "接近亂猜")
    if name == "r2":
        return _step(value, [(0.9, "優秀"), (0.7, "良好"), (0.5, "尚可"), (0.2, "偏弱")], "幾乎沒有預測能力")
    if name == "accuracy" and baseline is not None:
        return _step(value - baseline + 1e-9, [(0.2, "良好"), (0.1, "尚可"), (0.05, "偏弱")], "沒有比全部猜最常見的類別好")
    if name == "dice":
        return _step(value, [(0.8, "良好"), (0.7, "尚可")], "偏弱")
    if name == "mean_iou":
        return _step(value, [(0.7, "良好"), (0.5, "尚可")], "偏弱")
    return None


def headline_number(name: str, value: float) -> str:
    def half_up(v: float) -> int:
        return math.floor(v + 0.5 + 1e-9)
    if name in PERCENT:
        return f"{half_up(value * 100)}%"
    return f"{half_up(value * 100) / 100:.2f}"


def verdict(kind: str, metrics: dict, executor: str = "template") -> str:
    """一句結論，例如「良好（AUC 0.84，5 折平均）」；與網頁的訓練清單、結果頁同一個數字與等級。沒有指標時回空字串。"""
    sources = _sources(metrics or {})
    for name in PRIMARY.get(kind, ()):
        for label, scores in sources:
            if name in scores:
                value = scores[name]
                g = "快速測試，沒有意義" if executor == "fake" else grade(name, value, scores.get("baseline_accuracy"))
                shown = {"auc": "AUC", "r2": "R²"}.get(name, METRICS.get(name, (name,))[0])
                numbers = f"{shown} {headline_number(name, value)}，{label}"
                return f"{g}（{numbers}）" if g else numbers
    return ""


def build(*, run: dict, charts: dict | None, generated_by: str, now: datetime | None = None) -> str:
    """run 為 service.run_out() 的結果。"""
    config, metrics = run["config"], run.get("metrics") or {}
    tabular = config.get("tabular") or {}
    model = run["artifacts"].get("model.pkl") or run["artifacts"].get("model.h5") or {}
    now = now or datetime.now(timezone.utc)
    facts = [
        ("訓練種類", KIND_NAMES.get(run["kind"], run["kind"])),
        ("演算法", ALGORITHM_NAMES.get(tabular.get("algorithm"), tabular.get("algorithm")) if tabular else "卷積神經網路（Keras）"),
        ("驗證方式", validation_text(config)),
        ("要預測的結果（Target）", tabular.get("target")),
        ("用來預測的資料（Feature）", "、".join(tabular.get("features") or [])),
        ("前處理步驟", " → ".join(s.get("id", "") for s in tabular.get("steps") or []) or "無"),
        ("超參數", "、".join(f"{k} = {v}" for k, v in (config.get("hyperparameters") or {}).items()) or "預設值"),
        ("資料版本", f"#{run['dataset_version_id']}"),
        ("亂數種子", run["seed"]),
        ("建立者", run["created_by"]),
        ("開始／結束", f"{run.get('started_at') or '—'} ／ {run.get('finished_at') or '—'}"),
        ("模型檔 SHA-256", model.get("sha256", "—")),
    ]
    if not tabular:
        facts = [f for f in facts if f[0] not in ("要預測的結果（Target）", "用來預測的資料（Feature）", "前處理步驟")]
    fact_rows = "".join(f"<tr><th scope=\"row\">{_e(k)}</th><td>{_e(v if v is not None else '—')}</td></tr>"
                        for k, v in facts)
    cv = metrics.get("cv")
    return f"""<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>訓練報表：{_e(run['name'])}（訓練 #{run['id']}）</title><style>{STYLE}</style></head>
<body>
<h1>訓練報表：{_e(run['name'])}（訓練 #{run['id']}）</h1>
<p class="meta">產生時間 {now.strftime('%Y-%m-%d %H:%M')} UTC，產生者 {_e(generated_by)}。用瀏覽器的「列印」可存成 PDF。</p>
<h2>設定</h2>
<table><tbody>{fact_rows}</tbody></table>
<h2>模型表現</h2>
{f'<p class="verdict"><strong>整體表現：{_e(verdict(run["kind"], metrics, run.get("executor", "template")))}</strong></p>' if verdict(run["kind"], metrics) else ''}
{f'<p class="data-usage">{_e(data_text(metrics.get("data")))}</p>' if metrics.get("data") else ''}
{_metric_rows(metrics)}
{f'<h2>K 折交叉驗證</h2>{_cv_rows(cv)}' if isinstance(cv, dict) else ''}
<h2>圖表</h2>
{_charts(charts, tabular.get('target') or '')}
<h2>注意</h2>
<p>以上結果只代表這次訓練所用的資料。同一份資料、設定與亂數種子重跑會得到相同的結果；
用在臨床之前，仍需以新的院內資料驗證，並由專業人員判斷。</p>
</body></html>
"""
