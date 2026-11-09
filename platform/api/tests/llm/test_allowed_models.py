"""對話模型清單不列出模型服務裡沒有的模型（招標八、6 驗收時選到舊模型回 503）。"""
from types import SimpleNamespace

from app.llm.calls import allowed_models
from app.llm.client import LlmError, OllamaClient


class Client(OllamaClient):
    def __init__(self, names=None):
        self.names = names

    def models(self):
        if self.names is None:
            raise LlmError("down")
        return self.names


def run(client):
    settings = SimpleNamespace(chat_model="gemma", embed_model="embed")
    session = SimpleNamespace(scalars=lambda _q: ["embed", "gemma", "stale", "real"])
    return allowed_models(session, SimpleNamespace(settings=settings, client=client))


def test_lists_only_models_the_runtime_has():
    assert run(Client(["gemma", "real", "embed"])) == ["gemma", "real"]


def test_keeps_the_list_when_the_runtime_cannot_answer():
    assert run(Client(None)) == ["gemma", "real", "stale"]


def test_other_clients_are_not_filtered():
    assert run(object()) == ["gemma", "real", "stale"]
