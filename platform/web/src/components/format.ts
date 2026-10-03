/** API 的時間字串有時不帶時區（資料庫讀回的 UTC 時間），一律當成 UTC。 */
export function parseApiTime(value: string): Date {
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasZone ? value : `${value}Z`);
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = parseApiTime(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('zh-TW', { hour12: false });
}

/** DICOM 日期 YYYYMMDD → YYYY-MM-DD */
export function formatDicomDate(value: string | null | undefined): string {
  if (!value) return '—';
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : value;
}

/** 數值顯示：整數原樣，小數最多 digits 位有效位數；極小的 p 值用科學記號。 */
export function formatNumber(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  const abs = Math.abs(value);
  if (abs !== 0 && abs < 0.0001) return value.toExponential(2);
  return Number(value.toPrecision(digits)).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/**
 * 統計量（平均、標準差、百分位數）的畫面顯示：100 以上留 1 位小數、1 以上留 2 位、小於 1 取 3 位有效數字。
 * 只用在畫面；下載與 API 保留完整精度（TC-B04-01 以 pandas 比對 API 數值）。
 */
export function formatStat(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : null;
  if (digits !== null) return value.toLocaleString('en-US', { maximumFractionDigits: digits });
  return formatNumber(value, 3);
}
