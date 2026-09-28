from cryptography.hazmat.primitives.asymmetric import rsa

from app.models import User


def test_me_returns_current_user(client, add_user):
    _, headers = add_user("pi01")
    response = client.get("/api/me", headers=headers)
    assert response.status_code == 200
    assert response.json()["username"] == "pi01"


def test_tc_ss_02_missing_token_is_401(client):
    assert client.get("/api/me").status_code == 401


def test_tc_ss_03_bad_tokens_are_401(client, add_user, make_token, idp):
    user, _ = add_user("pi01")
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    bad_tokens = [
        make_token(user.idp_subject, "pi01", key=other_key),          # 錯誤簽章
        make_token(user.idp_subject, "pi01", expires_in=-10),        # 已過期
        make_token(user.idp_subject, "pi01", issuer="http://evil"),  # 別的 issuer
        make_token(user.idp_subject, "pi01", audience="other-app"),  # 別的 audience
        "not-a-jwt",
    ]
    for token in bad_tokens:
        response = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401, token


def test_deleted_user_with_valid_token_is_401(client, add_user, session):
    user, headers = add_user("ra01")
    session.delete(session.get(User, user.id))
    session.commit()
    assert client.get("/api/me", headers=headers).status_code == 401


def test_in_memory_idp_password_lifecycle(idp):
    subject = idp.create_user("md01", "old-pass")
    assert idp.find_subject("md01") == subject
    idp.reset_password(subject, "new-pass")
    assert idp.check_password("md01", "new-pass")
    assert not idp.check_password("md01", "old-pass")
    idp.delete_user(subject)
    assert idp.find_subject("md01") is None
