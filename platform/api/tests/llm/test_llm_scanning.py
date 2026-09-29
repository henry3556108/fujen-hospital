"""知識庫文件也是上傳區，要掃毒（TC-D01-06）：一份被攔不影響同批其他份；掃毒服務中斷時全部拒絕。"""
from sqlalchemy import select

from app.models import AuditLog
from app.scanning import FakeScanner, eicar

from docs_support import FILES


def _upload(client, base, coder, files):
    kb = client.post(f"{base}/knowledge-bases", headers=coder, json={"name": "掃毒測試"}).json()
    body = client.post(f"{base}/knowledge-bases/{kb['id']}/documents", headers=coder,
                       files=[("files", (name, data, "text/plain")) for name, data in files]).json()
    return body


def test_tc_d01_06_knowledge_base_infected_document_fails_alone(app, client, session, llm, coder, base):
    app.state.scanner = FakeScanner()
    body = _upload(client, base, coder, [("hand_hygiene.txt", FILES["hand_hygiene.txt"]),
                                         ("bad.txt", b"note\n" + eicar())])
    assert body["counts"] == {"indexed": 1, "duplicate": 0, "failed": 1}
    bad = next(r for r in body["results"] if r["filename"] == "bad.txt")
    assert bad["reason"] == "掃毒攔截：Eicar-Signature" and bad["document"] is None
    row = session.scalar(select(AuditLog).where(AuditLog.action == "llm.kb.documents.add"))
    assert row.result == "partial" and {"filename": "bad.txt", "status": "failed",
                                         "reason": "掃毒攔截：Eicar-Signature"} in row.detail["files"]


def test_tc_d01_06_knowledge_base_scanner_offline_rejects_every_document(app, client, llm, coder, base):
    app.state.scanner = FakeScanner(offline=True)
    body = _upload(client, base, coder, [("hand_hygiene.txt", FILES["hand_hygiene.txt"])])
    assert body["counts"] == {"indexed": 0, "duplicate": 0, "failed": 1}
    assert body["results"][0]["reason"].startswith("未能掃毒，已拒絕")
