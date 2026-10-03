"""B-04 示範用的參考值：直接用 pandas、scikit-learn、statsmodels、lifelines 計算 data/tabular/cohort_01.csv。

不呼叫平台的任何程式碼，只用公開套件；平台畫面顯示的值必須與這裡一致（畫面取 4 位有效數字）。
在 repo 根目錄執行（借用 platform/libs/tabular 的套件環境）：

    uv run --project platform/libs/tabular python docs/acceptance-kit/m1/tools/expected_stats.py
"""
import warnings
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from lifelines import CoxPHFitter, KaplanMeierFitter
from lifelines.statistics import multivariate_logrank_test
from sklearn.impute import SimpleImputer
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import OneHotEncoder

CSV = Path(__file__).resolve().parent.parent / "data" / "tabular" / "cohort_01.csv"


def _round(x: float, exp: int) -> Decimal:
    """以 x 的精確二進位值四捨五入到 10**exp（與瀏覽器 toPrecision、toLocaleString 相同的進位方式）。"""
    return Decimal(float(x)).quantize(Decimal(1).scaleb(exp), rounding=ROUND_HALF_UP)


def _plain(d: Decimal) -> str:
    sign, text = ("-", f"{-d:f}") if d < 0 else ("", f"{d:f}")
    whole, _, frac = text.partition(".")
    frac = frac.rstrip("0")
    return sign + f"{int(whole):,}" + (f".{frac}" if frac else "")


def g(x, digits: int = 4) -> str:
    """與平台畫面 formatNumber 相同：整數原樣、小於 0.0001 用科學記號、其餘取 digits 位有效數字。"""
    if x is None or np.isnan(float(x)):
        return "—"
    x = float(x)
    if x.is_integer():
        return f"{int(x):,}"
    if abs(x) < 0.0001:
        exp = Decimal(x).adjusted()
        mant = _round(x / 10 ** exp, -2)
        if abs(mant) >= 10:
            exp, mant = exp + 1, _round(x / 10 ** (exp + 1), -2)
        return f"{mant:.2f}e{exp:+d}"
    exp = Decimal(x).adjusted()
    return _plain(_round(float(_round(x, exp - digits + 1)), -6))


def stat(x) -> str:
    """與平台描述統計表 formatStat 相同：100 以上 1 位小數、1 以上 2 位小數、小於 1 取 3 位有效數字。"""
    x = float(x)
    if x.is_integer():
        return f"{int(x):,}"
    if abs(x) >= 100:
        return _plain(_round(x, -1))
    if abs(x) >= 1:
        return _plain(_round(x, -2))
    return g(x, 3)


df = pd.read_csv(CSV)
print(f"# 參考值：{CSV.name}（{len(df)} 列、{len(df.columns)} 欄）\n")

print("## TC-B04-01 描述統計（pandas.Series.describe；畫面取整，滑鼠移到數字上可看到完整值）")
print("| 欄位 | 筆數 | 缺值 | 相異值 | 平均 | 標準差 | 最小 | P25 | 中位數 | P75 | 最大 |")
print("|---|---|---|---|---|---|---|---|---|---|---|")
for c in ["age", "bmi", "sbp", "dbp", "glucose", "time_to_event"]:
    d = df[c].astype(float).describe()
    print(f"| {c} | {int(d['count'])} | {int(df[c].isna().sum())} | {df[c].nunique()} | {stat(d['mean'])} | {stat(d['std'])} "
          f"| {stat(d['min'])} | {stat(d['25%'])} | {stat(d['50%'])} | {stat(d['75%'])} | {stat(d['max'])} |")
for c in ["diagnosis", "event"]:
    print(f"| {c} | {df[c].count()} | 0 | 2 | {round(df[c].mean() * 100)}% 為 1 | | {df[c].min()} | | | | {df[c].max()} |")
print()
for c in ["sex", "smoker", "study_accession"]:
    vc = df[c].value_counts()
    print(f"- {c}：筆數 {df[c].count()}、缺值 {df[c].isna().sum()}、相異值 {df[c].nunique()}、"
          f"最常見值 {vc.index[0]}（{vc.iloc[0]} 次）；全部 " + "、".join(f"{k} {v}" for k, v in vc.items()))
counts, edges = np.histogram(df["age"].dropna(), bins=10)
print("- age 分布（numpy.histogram，預設 10 組）：" + "、".join(
    f"{g(edges[i])}–{g(edges[i + 1])}：{counts[i]}" for i in range(10)))
print(f"- 前 5 列 patient_id：{'、'.join(df['patient_id'].head(5))}\n")

print("## TC-B04-04 補值與 One-Hot（scikit-learn）")
imp = SimpleImputer(strategy="mean").fit(df[["glucose"]])
filled = imp.transform(df[["glucose"]])[:, 0]
missing_rows = list(df.index[df["glucose"].isna()] + 1)
print(f"- glucose 缺值 {df['glucose'].isna().sum()} 格（第 {missing_rows} 列，從 1 起算），以平均值 {imp.statistics_[0]:.6g} 補上；"
      f"補值後缺值 {int(np.isnan(filled).sum())}")
enc = OneHotEncoder(sparse_output=False).fit(df[["sex"]])
oh = enc.transform(df[["sex"]])
print(f"- sex One-Hot 產生欄位 {list(enc.get_feature_names_out(['sex']))}；sex_F 合計 {int(oh[:, 0].sum())}、sex_M 合計 {int(oh[:, 1].sum())}")
print(f"- 兩步驟後：{len(df)} 列、{len(df.columns) - 1 + oh.shape[1]} 欄（sex 換成 sex_F、sex_M）\n")

print("## TC-B04-05 相關矩陣（pandas.DataFrame.corr，pearson）與散佈圖")
num = ["age", "bmi", "sbp", "dbp", "glucose", "diagnosis", "time_to_event", "event"]
corr = df[num].corr()
print("| | " + " | ".join(num) + " |")
print("|---|" + "---|" * len(num))
for r in num:
    print(f"| {r} | " + " | ".join(f"{corr.loc[r, c]:.2f}" for c in num) + " |")
print(f"\n- 散佈圖 age 與 bmi：{len(df[['age', 'bmi']].dropna())} 點\n")

print("## TC-B04-07 四種統計")
y = df["diagnosis"]
X = sm.add_constant(df[["age", "bmi"]])
logit = sm.Logit(y, X).fit(disp=0)
ci = logit.conf_int()
print(f"### Logistic（statsmodels.Logit）：diagnosis ~ age + bmi，n={len(df)}，事件 {int(y.sum())}")
print(f"AUC {g(roc_auc_score(y, logit.predict()))}、Pseudo R² {g(logit.prsquared)}、AIC {g(logit.aic)}、BIC {g(logit.bic)}、LLR p 值 {g(logit.llr_pvalue)}\n")
print("| 變項 | 係數 | 標準誤 | z | p 值 | 95% CI | Odds Ratio | Odds Ratio 95% CI |")
print("|---|---|---|---|---|---|---|---|")
for n in X.columns:
    print(f"| {n} | {g(logit.params[n])} | {g(logit.bse[n])} | {g(logit.tvalues[n])} | {g(logit.pvalues[n])} "
          f"| {g(ci.loc[n, 0])} – {g(ci.loc[n, 1])} | {g(np.exp(logit.params[n]))} "
          f"| {g(np.exp(ci.loc[n, 0]))} – {g(np.exp(ci.loc[n, 1]))} |")

ols_X = sm.add_constant(df[["age", "bmi"]])
ols = sm.OLS(df["sbp"], ols_X).fit()
ci = ols.conf_int()
print(f"\n### Linear（statsmodels.OLS）：sbp ~ age + bmi，n={len(df)}")
print(f"R² {g(ols.rsquared)}、調整後 R² {g(ols.rsquared_adj)}、F {g(ols.fvalue)}、F 檢定 p 值 {g(ols.f_pvalue)}、AIC {g(ols.aic)}\n")
print("| 變項 | 係數 | 標準誤 | t | p 值 | 95% CI |")
print("|---|---|---|---|---|---|")
for n in ols_X.columns:
    print(f"| {n} | {g(ols.params[n])} | {g(ols.bse[n])} | {g(ols.tvalues[n])} | {g(ols.pvalues[n])} "
          f"| {g(ci.loc[n, 0])} – {g(ci.loc[n, 1])} |")

print("\n### Kaplan-Meier（lifelines）：time_to_event、event，依 sex 分組")
test = multivariate_logrank_test(df["time_to_event"], df["sex"], df["event"])
print(f"Log-rank 統計量 {g(test.test_statistic)}、p 值 {g(test.p_value)}、自由度 1\n")
print("| 組別 | 人數 | 事件數 | 中位存活時間 |")
print("|---|---|---|---|")
for s in sorted(df["sex"].unique()):
    part = df[df["sex"] == s]
    km = KaplanMeierFitter().fit(part["time_to_event"], part["event"])
    print(f"| {s} | {len(part)} | {int(part['event'].sum())} | {g(km.median_survival_time_)} |")

print("\n### Cox（lifelines.CoxPHFitter）：time_to_event、event，共變項 age、diagnosis")
with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    cph = CoxPHFitter().fit(df[["time_to_event", "event", "age", "diagnosis"]], "time_to_event", "event")
s = cph.summary
print(f"n={len(df)}，事件 {int(df['event'].sum())}；Concordance {g(cph.concordance_index_)}、Partial AIC {g(cph.AIC_partial_)}、"
      f"Log-likelihood {g(cph.log_likelihood_)}\n")
print("| 變項 | 係數 | 標準誤 | z | p 值 | 95% CI | Hazard Ratio | HR 95% CI |")
print("|---|---|---|---|---|---|---|---|")
for n in ["age", "diagnosis"]:
    r = s.loc[n]
    print(f"| {n} | {g(r['coef'])} | {g(r['se(coef)'])} | {g(r['z'])} | {g(r['p'])} | {g(r['coef lower 95%'])} – "
          f"{g(r['coef upper 95%'])} | {g(r['exp(coef)'])} | {g(r['exp(coef) lower 95%'])} – {g(r['exp(coef) upper 95%'])} |")
