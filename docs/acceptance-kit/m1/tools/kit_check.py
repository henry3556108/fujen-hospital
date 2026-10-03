"""M1 驗收示範用的核對小工具（只讀，不寫入任何資料）。

沿用批次匯入程式的登入（importer login 存的 token），經 Gateway 讀取平台資料，與資料包的 manifest 比對。
在 platform/tools/importer 目錄執行（與匯入程式同一組環境變數 GATEWAY_URL、KEYCLOAK_URL）：

    uv run python ../../../docs/acceptance-kit/m1/tools/kit_check.py counts  --project <專案>
    uv run python ../../../docs/acceptance-kit/m1/tools/kit_check.py pairing --project <專案>
    uv run python ../../../docs/acceptance-kit/m1/tools/kit_check.py access  --project <專案>
    uv run python ../../../docs/acceptance-kit/m1/tools/kit_check.py pacs    --project <專案>

counts   TC-B01-02／06：專案內研究、序列、影像筆數，與 data/dicom/manifest.json 比對
pairing  TC-B01-04：每個標註檔配到哪個影像；makesense 檢查配到的 5 張影像是否正是 JSON 內指定的研究
access   TC-B01-08：以 API 與 DICOMweb 存取清單外的 5 個研究（各 5 次），另以清單內 1 個研究作對照
pacs     TC-B01-07：由平台節點向 PACS 查詢（C-FIND）data/pacs 的 2 個研究，計時並比對中繼資料；
         已取回（C-MOVE）的研究，再比對平台留存的中繼資料（查詢不會匯入任何影像）
"""
import argparse
import json
import sys
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
sys.path.insert(0, str(HERE.parents[3] / "platform" / "tools" / "importer"))
from importer.cli import Config, LoginRequired, access_token  # noqa: E402


def client() -> tuple[httpx.Client, Config]:
    cfg = Config()
    http = httpx.Client(timeout=30)
    try:
        token = access_token(cfg, http)
    except LoginRequired:
        sys.exit("尚未登入，請先執行：uv run python -m importer login")
    http.headers["Authorization"] = f"Bearer {token}"
    return http, cfg


def project_id(http: httpx.Client, cfg: Config, name: str) -> int:
    for p in http.get(f"{cfg.gateway}/api/me").raise_for_status().json()["projects"]:
        if p["name"] == name or str(p["id"]) == name:
            return p["id"]
    sys.exit(f"找不到專案或你不是成員：{name}")


def manifest(sub: str) -> dict:
    return json.loads((DATA / sub / "manifest.json").read_text())


def cmd_counts(http, cfg, pid):
    m = manifest("dicom")
    studies = {s["study_instance_uid"]: s for s in
               http.get(f"{cfg.gateway}/api/projects/{pid}/imaging/studies").raise_for_status().json()}
    found = [studies[s["study_instance_uid"]] for s in m["studies"] if s["study_instance_uid"] in studies]
    got = (len(found), sum(len(s["series"]) for s in found), sum(s["instances"] for s in found))
    want = (m["counts"]["studies"], m["counts"]["series"], m["counts"]["instances"])
    print(f"來源檔案（manifest）：研究 {want[0]}、序列 {want[1]}、影像 {want[2]}")
    print(f"平台專案內（同一批 UID）：研究 {got[0]}、序列 {got[1]}、影像 {got[2]}")
    print(f"專案內全部研究數：{len(studies)}")
    diff = sum(abs(a - b) for a, b in zip(got, want))
    print(f"筆數差異：{diff}")
    return 0 if diff == 0 else 1


def cmd_pairing(http, cfg, pid):
    files = http.get(f"{cfg.gateway}/api/projects/{pid}/imaging/files").raise_for_status().json()
    expected = {e["file"]: e for e in manifest("makesense")["exports"]}
    dicom = {s["accession_number"]: s for s in manifest("dicom")["studies"]}
    errors = 0
    for f in files:
        if f["role"] != "label":
            continue
        name = Path(f["filename"]).name
        if f["format"] == "makesense":
            acc = expected[name]["accession_number"]
            ok = f["pairing"] == "paired" and f["paired_sop_instance_uids"] == sorted(dicom[acc]["sop_instance_uids"])
            target = f"{len(f['paired_sop_instance_uids'])} 張 DICOM（應為 {acc} 的 5 張）"
        else:
            want = name.replace("_label", "_image")
            ok = f["pairing"] == "paired" and Path(f["paired_image"] or "").name == want
            target = f"{f['paired_image']}（應為 {want}）"
        errors += not ok
        print(f"{name:24} {f['pairing']:9} → {target}  {'正確' if ok else '錯誤'}")
    print(f"配對錯誤：{errors}")
    return 0 if errors == 0 else 1


def cmd_access(http, cfg, pid):
    m = manifest("dicom")
    allow = set(http.get(f"{cfg.gateway}/api/projects/{pid}/imaging/accession-allowlist")
                .raise_for_status().json()["accession_numbers"])
    if not allow:
        sys.exit("這個專案沒有設定 Accession 清單")
    inside = next(s for s in m["studies"] if s["accession_number"] in allow)
    outside = [s for s in m["studies"] if s["accession_number"] not in allow][:5]
    base = f"{cfg.gateway}/dicomweb/projects/{pid}"
    print(f"對照組（清單內 {inside['accession_number']}）：")
    print(f"  API     /api/.../studies/<UID>       → HTTP "
          f"{http.get(f'{cfg.gateway}/api/projects/{pid}/imaging/studies/{inside['study_instance_uid']}').status_code}")
    print(f"  DICOMweb /studies/<UID>/metadata     → HTTP "
          f"{http.get(f'{base}/studies/{inside['study_instance_uid']}/metadata').status_code}")
    success = 0
    print("清單外存取（成功＝HTTP 200）：")
    for n, s in enumerate(outside, 1):
        uid = s["study_instance_uid"]
        a = http.get(f"{cfg.gateway}/api/projects/{pid}/imaging/studies/{uid}").status_code
        d = http.get(f"{base}/studies/{uid}/metadata").status_code
        success += (a == 200) + (d == 200)
        print(f"  {n}. {s['accession_number']}  API → HTTP {a}　DICOMweb → HTTP {d}")
    print(f"清單外存取成功：{success} 次（共 {2 * len(outside)} 次）")
    return 0 if success == 0 else 1


PACS_FIELDS = [("AccessionNumber", "accession_number"), ("PatientID", "patient_id"), ("PatientSex", "patient_sex"),
               ("StudyDate", "study_date"), ("StudyDescription", "study_description"), ("Modality", "modality")]


def cmd_pacs(http, cfg, pid):
    import time
    diffs = 0
    for s in manifest("pacs")["studies"]:
        uid = s["study_instance_uid"]
        start = time.monotonic()
        r = http.post(f"{cfg.gateway}/api/projects/{pid}/imaging/pacs/query", json={"StudyInstanceUID": uid})
        elapsed = time.monotonic() - start
        r.raise_for_status()
        answers = r.json()
        if not answers:
            print(f"{s['accession_number']}：PACS 沒有回覆這個研究（先把 data/pacs 放進 PACS，或專案清單不含它）")
            diffs += 1
            continue
        bad = [k for k, m in PACS_FIELDS if answers[0].get(k) != s[m]]
        diffs += len(bad)
        print(f"{s['accession_number']}：C-FIND 回應 {elapsed:.2f} 秒；中繼資料 {len(PACS_FIELDS)} 欄差異 {len(bad)} {bad or ''}")
        got = http.get(f"{cfg.gateway}/api/projects/{pid}/imaging/studies/{uid}")
        if got.status_code != 200:
            print("    尚未取回到本專案")
            continue
        g = got.json()
        stored = {"accession_number": g["accession_number"], "patient_id": g["patient_id"],
                  "patient_sex": g["patient_sex"], "study_date": g["study_date"],
                  "study_description": g["study_description"], "modality": g["series"][0]["modality"],
                  "series_description": g["series"][0]["series_description"], "instances": g["instances"]}
        want = {k: s[k] for k in stored if k != "instances"} | {"instances": len(s["files"])}
        bad = [k for k in stored if stored[k] != want[k]]
        diffs += len(bad)
        print(f"    已取回：平台留存 {len(stored)} 欄（含影像數 {g['instances']}）與來源差異 {len(bad)} {bad or ''}")
    print(f"中繼資料差異合計：{diffs}")
    return 0 if diffs == 0 else 1


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["counts", "pairing", "access", "pacs"])
    p.add_argument("--project", required=True)
    a = p.parse_args()
    http, cfg = client()
    pid = project_id(http, cfg, a.project)
    return {"counts": cmd_counts, "pairing": cmd_pairing, "access": cmd_access, "pacs": cmd_pacs}[a.command](http, cfg, pid)


if __name__ == "__main__":
    sys.exit(main())
