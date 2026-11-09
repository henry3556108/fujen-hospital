"""卸載／刪除模型的保護。

招標八、6 驗收時「模型使用掛掉」：卸載會把模型從模型服務刪掉，模型又是全平台共用，
任何一個專案有 coding 權限的人按「卸載」或「刪除模型」，所有專案的對話與 RAG 都會失敗。
"""
import dataclasses

from app.permissions import Role


def detail(response):
    return response.json()["detail"]


def test_default_models_cannot_be_unloaded_or_deleted(client, llm, whitelist, install, admin, coder, base):
    install("small")
    llm.settings = dataclasses.replace(llm.settings, chat_model="small")   # 把 small 當成平台預設的對話模型
    client.post(f"{base}/models/small/load", headers=coder)
    for headers in (coder, admin):
        response = client.post(f"{base}/models/small/unload", headers=headers)
        assert response.status_code == 409 and "預設的對話模型" in str(detail(response)), response.text
        response = client.delete(f"{base}/models/small", headers=headers)
        assert response.status_code == 409 and "預設的對話模型" in str(detail(response)), response.text
    assert [r.name for r in llm.runtime.loaded()] == ["small"]


def test_only_installer_or_admin_can_unload(client, llm, whitelist, install, admin, coder, base, project, member):
    other = member(project, "pi01", Role.PRINCIPAL_INVESTIGATOR)
    install("small")
    client.post(f"{base}/models/small/load", headers=coder)
    response = client.post(f"{base}/models/small/unload", headers=other)
    assert response.status_code == 403, response.text
    assert [r.name for r in llm.runtime.loaded()] == ["small"]
    assert client.post(f"{base}/models/small/unload", headers=admin).status_code == 200


def test_model_used_by_a_published_service_is_kept(client, llm, whitelist, install, coder, base):
    install("small")
    client.post(f"{base}/models/small/load", headers=coder)
    published = client.post(f"{base}/services", headers=coder, json={"slug": "rx-qa", "name": "x", "model": "small"})
    assert published.status_code == 201, published.text
    response = client.post(f"{base}/models/small/unload", headers=coder)
    assert response.status_code == 409 and "rx-qa" in str(detail(response))
    client.delete(f"{base}/services/{published.json()['id']}", headers=coder)
    assert client.post(f"{base}/models/small/unload", headers=coder).status_code == 200
