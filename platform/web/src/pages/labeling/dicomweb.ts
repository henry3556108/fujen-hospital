// 經 Gateway 的專案範圍 DICOMweb（/dicomweb/projects/{pid}）取序列、中繼資料與 frame 像素。
// 只支援未壓縮的單色影像（8 或 16 bit）；其他格式請改用 OHIF 開啟。

type DicomJson = Record<string, { vr?: string; Value?: unknown[] } | undefined>;

export interface SeriesInfo {
  seriesInstanceUid: string;
  modality: string;
  description: string;
}

export interface InstanceInfo {
  sopInstanceUid: string;
  seriesInstanceUid: string;
  instanceNumber: number;
  modality: string;
  rows: number;
  columns: number;
  bitsAllocated: number;
  pixelRepresentation: number;
  samplesPerPixel: number;
  photometric: string;
  slope: number;
  intercept: number;
  windowCenter: number | null;
  windowWidth: number | null;
}

export class DicomwebError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DicomwebError';
  }
}

function first(ds: DicomJson, tag: string): unknown {
  return ds[tag]?.Value?.[0];
}
function str(ds: DicomJson, tag: string): string {
  const v = first(ds, tag);
  return v === undefined || v === null ? '' : String(v);
}
function num(ds: DicomJson, tag: string, fallback: number): number {
  const v = Number(first(ds, tag));
  return Number.isFinite(v) ? v : fallback;
}
function optionalNum(ds: DicomJson, tag: string): number | null {
  const v = first(ds, tag);
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseSeries(body: unknown): SeriesInfo[] {
  if (!Array.isArray(body)) return [];
  return (body as DicomJson[]).map((ds) => ({
    seriesInstanceUid: str(ds, '0020000E'),
    modality: str(ds, '00080060'),
    description: str(ds, '0008103E'),
  }));
}

export function parseInstances(body: unknown): InstanceInfo[] {
  if (!Array.isArray(body)) return [];
  return (body as DicomJson[])
    .map((ds) => ({
      sopInstanceUid: str(ds, '00080018'),
      seriesInstanceUid: str(ds, '0020000E'),
      instanceNumber: num(ds, '00200013', 0),
      modality: str(ds, '00080060'),
      rows: num(ds, '00280010', 0),
      columns: num(ds, '00280011', 0),
      bitsAllocated: num(ds, '00280100', 16),
      pixelRepresentation: num(ds, '00280103', 0),
      samplesPerPixel: num(ds, '00280002', 1),
      photometric: str(ds, '00280004') || 'MONOCHROME2',
      slope: num(ds, '00281053', 1),
      intercept: num(ds, '00281052', 0),
      windowCenter: optionalNum(ds, '00281050'),
      windowWidth: optionalNum(ds, '00281051'),
    }))
    .sort((a, b) => a.instanceNumber - b.instanceNumber || a.sopInstanceUid.localeCompare(b.sopInstanceUid));
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** multipart/related 的第一個 part 的內容（frame 像素）。 */
export function firstPart(body: Uint8Array, contentType: string): Uint8Array {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType);
  if (!m) throw new DicomwebError(0, '影像回應缺少 multipart boundary');
  const delimiter = ascii(`--${m[2]}`);
  const start = indexOf(body, delimiter);
  if (start < 0) throw new DicomwebError(0, '影像回應的格式不正確');
  const headerEnd = indexOf(body, ascii('\r\n\r\n'), start);
  if (headerEnd < 0) throw new DicomwebError(0, '影像回應的格式不正確');
  const dataStart = headerEnd + 4;
  const end = indexOf(body, ascii(`\r\n--${m[2]}`), dataStart);
  return body.subarray(dataStart, end < 0 ? body.length : end);
}

/** 未壓縮像素（little endian）→ 數值陣列。 */
export function decodePixels(data: Uint8Array, info: InstanceInfo): Int16Array | Uint16Array | Uint8Array {
  if (info.samplesPerPixel !== 1 || !info.photometric.startsWith('MONOCHROME')) {
    throw new DicomwebError(0, '工作台只支援單色影像，彩色影像請改用 OHIF 開啟');
  }
  const n = info.rows * info.columns;
  if (info.bitsAllocated === 8) {
    if (data.length < n) throw new DicomwebError(0, '影像資料長度不足');
    return data.subarray(0, n);
  }
  if (info.bitsAllocated !== 16) throw new DicomwebError(0, `不支援 ${info.bitsAllocated} bit 影像`);
  if (data.length < n * 2) throw new DicomwebError(0, '影像資料長度不足（可能是壓縮格式，請改用 OHIF 開啟）');
  const view = new DataView(data.buffer, data.byteOffset, n * 2);
  const out = info.pixelRepresentation === 1 ? new Int16Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = info.pixelRepresentation === 1 ? view.getInt16(i * 2, true) : view.getUint16(i * 2, true);
  }
  return out;
}

export interface DicomwebClient {
  series(studyUid: string): Promise<SeriesInfo[]>;
  instances(studyUid: string, seriesUid: string): Promise<InstanceInfo[]>;
  pixels(studyUid: string, info: InstanceInfo): Promise<Int16Array | Uint16Array | Uint8Array>;
}

const MESSAGES: Record<number, string> = {
  401: '登入已失效，請重新登入',
  403: '你沒有權限檢視這個研究，或研究不在本專案的 Accession 清單內',
  404: '找不到影像',
};

export function createDicomwebClient(opts: {
  base: string;
  projectId: number;
  getToken: () => Promise<string | null>;
}): DicomwebClient {
  const root = `${opts.base}/dicomweb/projects/${opts.projectId}`;
  async function get(path: string, accept: string): Promise<Response> {
    const token = await opts.getToken();
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
    } catch {
      throw new DicomwebError(0, '無法連線到影像服務，請確認網路或稍後再試');
    }
    if (!res.ok) throw new DicomwebError(res.status, MESSAGES[res.status] ?? `影像服務錯誤（HTTP ${res.status}）`);
    return res;
  }
  const cache = new Map<string, Promise<Int16Array | Uint16Array | Uint8Array>>();
  return {
    async series(studyUid) {
      return parseSeries(await (await get(`/studies/${studyUid}/series`, 'application/dicom+json')).json());
    },
    async instances(studyUid, seriesUid) {
      const res = await get(`/studies/${studyUid}/series/${seriesUid}/metadata`, 'application/dicom+json');
      return parseInstances(await res.json());
    },
    pixels(studyUid, info) {
      const key = `${studyUid}/${info.sopInstanceUid}`;
      let hit = cache.get(key);
      if (!hit) {
        hit = (async () => {
          const res = await get(
            `/studies/${studyUid}/series/${info.seriesInstanceUid}/instances/${info.sopInstanceUid}/frames/1`,
            'multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1',
          );
          const body = new Uint8Array(await res.arrayBuffer());
          return decodePixels(firstPart(body, res.headers.get('content-type') ?? ''), info);
        })();
        hit.catch(() => cache.delete(key));
        cache.set(key, hit);
      }
      return hit;
    },
  };
}
