// jsdom 的 FormData／File／Blob 與 Node 內建 fetch（undici）不相容：經 fetch 送出時檔名變成 "blob"、內容遺失。
// 會上傳檔案的測試在檔案開頭 import 本模組，把這三個全域換成 Node 內建版本（瀏覽器不受影響）。
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';

const nativeFormData = (await new Response(new URLSearchParams()).formData()).constructor as typeof FormData;

Object.assign(globalThis, { FormData: nativeFormData, File: NodeFile, Blob: NodeBlob });

export function makeFile(content: string | Uint8Array, name: string, type = 'application/octet-stream'): File {
  return new File([content as BlobPart], name, { type });
}
