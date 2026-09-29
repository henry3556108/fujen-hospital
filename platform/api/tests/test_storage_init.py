"""物件儲存帳號佈建：平台 API 只拿得到「讀寫自己那個 bucket」的帳號，不用 MinIO root。"""
import pytest

from app.storage_init import bucket_policy, provision, settings_from_env


def test_policy_is_limited_to_the_bucket():
    policy = bucket_policy("platform")
    actions = {a for st in policy["Statement"] for a in st["Action"]}
    resources = {r for st in policy["Statement"] for r in st["Resource"]}
    assert all(st["Effect"] == "Allow" for st in policy["Statement"])
    assert actions == {"s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"}
    assert resources == {"arn:aws:s3:::platform", "arn:aws:s3:::platform/*"}
    assert not any("*" in a or a.startswith("admin:") for a in actions)      # 沒有萬用字元、沒有管理權限
    object_statement = next(st for st in policy["Statement"] if "s3:PutObject" in st["Action"])
    assert object_statement["Resource"] == ["arn:aws:s3:::platform/*"]


class FakeS3:
    def __init__(self, buckets=()):
        self.buckets, self.made = set(buckets), []

    def bucket_exists(self, name):
        return name in self.buckets

    def make_bucket(self, name):
        self.buckets.add(name)
        self.made.append(name)


class FakeAdmin:
    def __init__(self):
        self.calls = []

    def policy_add(self, name, policy=None, policy_file=None):
        self.calls.append(("policy_add", name, policy))

    def user_add(self, access_key, secret_key):
        self.calls.append(("user_add", access_key, secret_key))

    def policy_set(self, name, user=None, group=None):
        self.calls.append(("policy_set", name, user))


def test_provision_creates_bucket_policy_user_and_is_repeatable():
    s3, admin = FakeS3(), FakeAdmin()
    for _ in range(2):
        provision(s3, admin, bucket="platform", access_key="platform-api", secret_key="s3cret-value")
    assert s3.made == ["platform"]                                           # 第二次不重建 bucket
    assert admin.calls[:3] == [
        ("policy_add", "platform-api-rw", bucket_policy("platform")),
        ("user_add", "platform-api", "s3cret-value"),
        ("policy_set", "platform-api-rw", "platform-api"),
    ]


def test_settings_reject_root_account_for_api():
    env = {"MINIO_ENDPOINT": "minio:9000", "MINIO_ROOT_USER": "root", "MINIO_ROOT_PASSWORD": "root-secret",
           "S3_BUCKET": "platform", "S3_ACCESS_KEY": "platform-api", "S3_SECRET_KEY": "platform-secret"}
    assert settings_from_env(env)["access_key"] == "platform-api"
    with pytest.raises(RuntimeError, match="不可以與 root 相同"):
        settings_from_env({**env, "S3_ACCESS_KEY": "root"})
    with pytest.raises(RuntimeError, match="至少 8 個字元"):
        settings_from_env({**env, "S3_SECRET_KEY": "short"})
    with pytest.raises(RuntimeError, match="缺少環境變數：MINIO_ROOT_PASSWORD"):
        settings_from_env({k: v for k, v in env.items() if k != "MINIO_ROOT_PASSWORD"})
