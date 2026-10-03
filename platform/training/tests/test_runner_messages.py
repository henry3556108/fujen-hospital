"""訓練失敗時給使用者看的訊息：只顯示繁體中文原因，Python 堆疊放在技術細節（2026-10-03 使用性測試）。"""
from trainer.runner import DETAILS, clip, failure_message

LOG = """Traceback (most recent call last):
  File "/work/template/runtime.py", line 131, in main
    card = train(config, Path(args.data), out)
  File "/work/template/tabularkit.py", line 44, in feature_matrix
    raise TabularError(f"...")
tabular.errors.TabularError: 前處理後找不到特徵欄位：smoker_current
"""


def test_reason_comes_first_and_stack_goes_to_details():
    message = failure_message(1, LOG)
    reason, details = message.split(DETAILS)
    assert reason == "前處理後找不到特徵欄位：smoker_current"
    assert "Traceback" in details and "訓練程式以 1 結束" in details


def test_unknown_errors_and_timeouts_still_explain_in_chinese():
    assert failure_message(1, "segfault").startswith("訓練程式發生錯誤")
    assert failure_message(124, "\n訓練超過時限 60 秒").startswith("訓練超過時限")


def test_long_messages_keep_the_reason():
    message = failure_message(1, "x\n" * 2000 + "ValueError: 訓練資料的目標欄位只有一種類別")
    clipped = clip(message)
    assert len(clipped) <= 1000 and clipped.startswith("訓練資料的目標欄位只有一種類別" + DETAILS)
