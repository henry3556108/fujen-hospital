"""物件儲存帳號佈建（一次性）：建立 bucket、只能讀寫該 bucket 的 policy、平台 API 專用帳號。

平台 API 不使用 MinIO root：root 金鑰只給 MinIO 本身與這支佈建程式。可重複執行。
    python -m app.storage_init
環境變數：MINIO_ENDPOINT、MINIO_ROOT_USER、MINIO_ROOT_PASSWORD（管理用）；S3_BUCKET、S3_ACCESS_KEY、S3_SECRET_KEY（要建立的帳號）。
"""
import os
import sys
import time
from collections.abc import Mapping

_REQUIRED = ("MINIO_ENDPOINT", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY")


def bucket_policy(bucket: str) -> dict:
    """最小權限：列出 bucket、讀寫刪物件。不含建立／刪除 bucket、其他 bucket、任何管理動作。"""
    return {
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
             "Resource": [f"arn:aws:s3:::{bucket}"]},
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
             "Resource": [f"arn:aws:s3:::{bucket}/*"]},
        ],
    }


def settings_from_env(env: Mapping[str, str]) -> dict:
    missing = [n for n in _REQUIRED if not env.get(n)]
    if missing:
        raise RuntimeError(f"缺少環境變數：{', '.join(missing)}")
    if env["S3_ACCESS_KEY"] == env["MINIO_ROOT_USER"]:
        raise RuntimeError("S3_ACCESS_KEY 不可以與 root 相同：平台 API 要用自己的帳號")
    if len(env["S3_SECRET_KEY"]) < 8:
        raise RuntimeError("S3_SECRET_KEY 至少 8 個字元（MinIO 的限制）")
    return {"endpoint": env["MINIO_ENDPOINT"], "root_user": env["MINIO_ROOT_USER"],
            "root_password": env["MINIO_ROOT_PASSWORD"], "bucket": env["S3_BUCKET"],
            "access_key": env["S3_ACCESS_KEY"], "secret_key": env["S3_SECRET_KEY"],
            "secure": env.get("S3_SECURE", "false").lower() == "true"}


def provision(s3, admin, *, bucket: str, access_key: str, secret_key: str) -> None:
    policy_name = f"{access_key}-rw"
    if not s3.bucket_exists(bucket):
        s3.make_bucket(bucket)
    admin.policy_add(policy_name, policy=bucket_policy(bucket))
    admin.user_add(access_key, secret_key)
    admin.policy_set(policy_name, user=access_key)


def main(env: Mapping[str, str] = os.environ, *, attempts: int = 30, wait: float = 2.0) -> int:
    from minio import Minio, MinioAdmin
    from minio.credentials import StaticProvider

    s = settings_from_env(env)
    s3 = Minio(s["endpoint"], access_key=s["root_user"], secret_key=s["root_password"], secure=s["secure"])
    admin = MinioAdmin(endpoint=s["endpoint"], credentials=StaticProvider(s["root_user"], s["root_password"]),
                       secure=s["secure"])
    for attempt in range(1, attempts + 1):
        try:
            provision(s3, admin, bucket=s["bucket"], access_key=s["access_key"], secret_key=s["secret_key"])
        except Exception as exc:  # MinIO 還沒起來：等一下再試
            print(f"物件儲存尚未就緒（第 {attempt} 次）：{type(exc).__name__}: {exc}", file=sys.stderr)
            time.sleep(wait)
            continue
        print(f"物件儲存已就緒：bucket {s['bucket']}、帳號 {s['access_key']}（只能讀寫這個 bucket）")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
