import fs from 'node:fs';
import path from 'node:path';
import { psql, q } from '../e2e-acceptance/ops';

// OPS 情境（F1、F2、G1～G4、V1）共用：示範租戶專案與 FHIR 來源檔。

export const FHIR_PROJECT = '手冊-FHIR資料交換';
const SAMPLE = '/mnt/c/Users/skyland/Desktop/workspace/sample-data/M2/clinical';
const KC = 'http://localhost:38180/realms/ai-platform/protocol/openid-connect/token';
const GW = 'http://localhost:38980';

/** admin01 的存取權杖（給鏡頭外的 API 前置作業用） */
export function adminToken(): string {
  return q(
    `curl -s -X POST ${KC} -d grant_type=password -d client_id=ai-platform-web -d username=admin01 --data-urlencode 'password=Admin01-dev!' | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p'`,
  );
}

/** 確保示範租戶專案存在（沒有就建立），回傳專案編號 */
export function ensureFhirProject(): number {
  let id = psql(`select id from projects where name='${FHIR_PROJECT}'`);
  if (!id) {
    const t = adminToken();
    q(
      `curl -s -X POST ${GW}/api/admin/projects -H "Authorization: Bearer ${t}" -H 'Content-Type: application/json' -d '{"name":"${FHIR_PROJECT}","description":"操作手冊 FHIR 示範租戶"}'`,
    );
    id = psql(`select id from projects where name='${FHIR_PROJECT}'`);
  }
  if (!id) throw new Error('建立示範租戶專案失敗');
  return Number(id);
}

/** 準備來源檔（HL7 20 則合併、含錯誤訊息的 HL7、CSV、JSON），放在本次輸出資料夾 */
export function fhirData() {
  const dir = path.resolve(process.env.MANUAL_OUT || 'test-results/manual', 'fhir-data');
  fs.mkdirSync(dir, { recursive: true });
  const read = (f: string) => fs.readFileSync(path.join(SAMPLE, f), 'utf8').replace(/[\r\n]+$/, '');
  const hl7s = fs
    .readdirSync(path.join(SAMPLE, 'hl7'))
    .filter((f) => f.endsWith('.hl7'))
    .sort()
    .map((f) => read(`hl7/${f}`));
  const bad = [read('hl7/adt_a01_0001.hl7'), ...fs.readdirSync(path.join(SAMPLE, 'invalid')).sort().map((f) => read(`invalid/${f}`))];
  const out = {
    hl7: path.join(dir, '入院訊息-20則.hl7'),
    hl7Bad: path.join(dir, '入院訊息-有錯誤.hl7'),
    csv: path.join(dir, '門診紀錄.csv'),
    json: path.join(dir, '檢驗結果.json'),
  };
  fs.writeFileSync(out.hl7, hl7s.join('\r\n') + '\r\n');
  fs.writeFileSync(out.hl7Bad, bad.join('\r\n') + '\r\n');
  fs.copyFileSync(path.join(SAMPLE, 'encounters.csv'), out.csv);
  fs.copyFileSync(path.join(SAMPLE, 'labs.json'), out.json);
  return out;
}

/** 模擬外部系統在 60 秒內大量查詢示範租戶（只讀 GET），觸發流量告警；回傳 HTTP 狀態碼統計 */
export function fhirBurst(projectId: number, n = 140): string {
  const t = adminToken();
  return q(
    `for i in $(seq 1 ${n}); do curl -s -o /dev/null -w '%{http_code}\\n' "${GW}/fhir/projects/${projectId}/Patient?_count=1" -H "Authorization: Bearer ${t}"; done | sort | uniq -c`,
  );
}
