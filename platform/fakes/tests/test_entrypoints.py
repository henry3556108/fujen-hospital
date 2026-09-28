"""`python -m fakes.llm --port 8101` / `python -m fakes.autolabel --port 8102` start uvicorn."""

import pytest
import uvicorn

from fakes import autolabel, llm


@pytest.fixture
def captured(monkeypatch):
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: calls.append((app, kw)))
    return calls


@pytest.mark.parametrize(
    ("module", "default_port", "port"),
    [(llm, 8101, 8201), (autolabel, 8102, 8202)],
)
def test_main_runs_uvicorn_on_requested_port(captured, module, default_port, port):
    module.main(["--port", str(port), "--host", "127.0.0.1"])
    module.main([])
    (app1, kw1), (app2, kw2) = captured
    assert app1 is module.app and app2 is module.app
    assert kw1["port"] == port and kw1["host"] == "127.0.0.1"
    assert kw2["port"] == default_port and kw2["host"] == "0.0.0.0"
