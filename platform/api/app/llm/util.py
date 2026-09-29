from datetime import datetime, timezone


def iso(value: datetime | None) -> str | None:
    """一律輸出帶時區的 UTC 時間。SQLite 讀回來的時間沒有時區資訊，補上 UTC，讓同一筆資料每次輸出都相同。"""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()
