// 影像標註工作台的純函式：WC、旋轉座標、RLE、DICOMweb 解析（TC-B02-01 的運算基礎）。
import { describe, expect, it } from 'vitest';
import { decodePixels, firstPart, parseInstances, parseSeries, type InstanceInfo } from '../../src/pages/labeling/dicomweb';
import {
  WINDOW_PRESETS,
  boxFromPoints,
  canvasToImage,
  defaultWindow,
  fitTransform,
  imageToCanvas,
  labelValue,
  layoutCells,
  nextLayout,
  paintDisc,
  renderGray,
  rleDecode,
  rleEncode,
  rotate,
  usedLabels,
  windowedGray,
  type Rotation,
} from '../../src/pages/labeling/imaging';

describe('window level', () => {
  it('TC-B02-01 has at least 3 organ presets, each with its own number hotkey', () => {
    expect(WINDOW_PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(WINDOW_PRESETS.map((p) => p.hotkey)).size).toBe(WINDOW_PRESETS.length);
    expect(new Set(WINDOW_PRESETS.map((p) => `${p.center}/${p.width}`)).size).toBe(WINDOW_PRESETS.length);
  });

  it('maps values linearly inside the window and clips outside (DICOM C.11.2.1.2)', () => {
    const w = { center: 40, width: 400 };
    expect(windowedGray(-1000, w)).toBe(0);
    expect(windowedGray(-160, w)).toBe(0);
    expect(windowedGray(240, w)).toBe(255);
    expect(windowedGray(3000, w)).toBe(255);
    expect(windowedGray(40, w)).toBeGreaterThanOrEqual(127);
    expect(windowedGray(40, w)).toBeLessThanOrEqual(129);
    expect(windowedGray(140, w)).toBeGreaterThan(windowedGray(40, w));
  });

  it('applies rescale slope and intercept before windowing, and can invert', () => {
    const module = { rows: 1, columns: 3, slope: 1, intercept: -1024 };
    const pixels = Uint16Array.from([0, 1064, 4000]); // -1024 HU、40 HU、2976 HU
    const rgba = renderGray(pixels, module, { center: 40, width: 400 });
    expect([rgba[0], rgba[8]]).toEqual([0, 255]);
    expect(rgba[4]).toBeGreaterThan(120);
    expect(rgba[3]).toBe(255);
    const inverted = renderGray(pixels, module, { center: 40, width: 400 }, true);
    expect([inverted[0], inverted[8]]).toEqual([255, 0]);
  });

  it('different presets give different pictures of the same pixels', () => {
    const module = { rows: 1, columns: 4, slope: 1, intercept: -1024 };
    const pixels = Uint16Array.from([200, 900, 1100, 1500]);
    const pictures = WINDOW_PRESETS.map((p) => Array.from(renderGray(pixels, module, p)).join(','));
    expect(new Set(pictures).size).toBe(WINDOW_PRESETS.length);
  });

  it('falls back to a sensible default window', () => {
    const module = { rows: 1, columns: 3, slope: 1, intercept: 0 };
    expect(defaultWindow('CT', [0, 1, 2], module)).toEqual({ center: 40, width: 400 });
    expect(defaultWindow('MR', [100, 300, 500], module)).toEqual({ center: 300, width: 400 });
    expect(defaultWindow('MR', [7, 7, 7], module)).toEqual({ center: 128, width: 256 });
  });
});

describe('rotation and layout', () => {
  it('rotates in 90 degree steps both ways', () => {
    expect(rotate(0, 'cw')).toBe(90);
    expect(rotate(270, 'cw')).toBe(0);
    expect(rotate(0, 'ccw')).toBe(270);
    expect(rotate(rotate(rotate(rotate(90, 'cw'), 'cw'), 'cw'), 'cw')).toBe(90);
  });

  it('cycles layouts', () => {
    expect([layoutCells('1x1'), layoutCells('1x2'), layoutCells('2x2')]).toEqual([1, 2, 4]);
    expect(nextLayout('1x1')).toBe('1x2');
    expect(nextLayout('2x2')).toBe('1x1');
  });

  it.each([0, 90, 180, 270] as Rotation[])('canvas ↔ image round trip at %i°', (rotation) => {
    const t = fitTransform(512, 384, 64, 48, rotation);
    for (const [x, y] of [
      [0, 0],
      [64, 48],
      [10.5, 40.25],
    ]) {
      const [cx, cy] = imageToCanvas(t, x, y);
      const [bx, by] = canvasToImage(t, cx, cy);
      expect(bx).toBeCloseTo(x, 6);
      expect(by).toBeCloseTo(y, 6);
      expect(cx).toBeGreaterThanOrEqual(-1e-6);
      expect(cx).toBeLessThanOrEqual(512 + 1e-6);
      expect(cy).toBeGreaterThanOrEqual(-1e-6);
      expect(cy).toBeLessThanOrEqual(384 + 1e-6);
    }
  });

  it('rotating 90° clockwise moves the top-left corner to the top-right', () => {
    const [x0] = imageToCanvas(fitTransform(400, 400, 64, 64, 0), 0, 0);
    const [x90, y90] = imageToCanvas(fitTransform(400, 400, 64, 64, 90), 0, 0);
    expect(x0).toBeCloseTo(0);
    expect(x90).toBeCloseTo(400);
    expect(y90).toBeCloseTo(0);
  });

  it('builds a valid integer box from two points in any order and rejects empty ones', () => {
    expect(boxFromPoints([10.2, 20.7], [3.9, 5.1], 64, 64)).toEqual([3, 5, 11, 21]);
    expect(boxFromPoints([-5, -5], [200, 30], 64, 64)).toEqual([0, 0, 64, 30]);
    expect(boxFromPoints([5, 5], [5, 5], 64, 64)).toBeNull();
    expect(boxFromPoints([70, 5], [90, 9], 64, 64)).toBeNull();
  });
});

describe('masks', () => {
  it('RLE round trip', () => {
    const mask = Uint8Array.from([0, 0, 1, 1, 1, 2, 0, 0]);
    expect(rleEncode(mask)).toEqual([
      [0, 2],
      [1, 3],
      [2, 1],
      [0, 2],
    ]);
    expect(Array.from(rleDecode(rleEncode(mask), mask.length))).toEqual(Array.from(mask));
    expect(rleEncode(new Uint8Array(0))).toEqual([]);
  });

  it('paints a disc, reports change, and stays inside the image', () => {
    const mask = new Uint8Array(8 * 8);
    expect(paintDisc(mask, 8, 8, 4, 4, 2, 1)).toBe(true);
    expect(mask[4 * 8 + 4]).toBe(1);
    expect(mask[0]).toBe(0);
    expect(paintDisc(mask, 8, 8, 4, 4, 2, 1)).toBe(false);
    expect(paintDisc(mask, 8, 8, 0, 0, 3, 2)).toBe(true);
    expect(mask[0]).toBe(2);
    expect(paintDisc(mask, 8, 8, 100, 100, 3, 2)).toBe(false);
    expect(rleEncode(mask).reduce((n, [, run]) => n + run, 0)).toBe(64);
  });

  it('assigns label values and lists labels that are actually used', () => {
    let names: Record<string, number> = { background: 0 };
    let lung: number;
    let nodule: number;
    [names, lung] = labelValue(names, 'lung');
    [names, nodule] = labelValue(names, 'nodule');
    expect([lung, nodule]).toEqual([1, 2]);
    expect(labelValue(names, 'lung')[1]).toBe(1);
    expect(usedLabels(Uint8Array.from([0, 2, 2]), names)).toEqual(['nodule']);
  });
});

describe('dicomweb parsing', () => {
  const info: InstanceInfo = {
    sopInstanceUid: '1.2.3',
    seriesInstanceUid: '1.2',
    instanceNumber: 1,
    modality: 'CT',
    rows: 2,
    columns: 2,
    bitsAllocated: 16,
    pixelRepresentation: 0,
    samplesPerPixel: 1,
    photometric: 'MONOCHROME2',
    slope: 1,
    intercept: -1024,
    windowCenter: null,
    windowWidth: null,
  };

  function multipart(data: Uint8Array, boundary = 'b-123'): [Uint8Array, string] {
    const head = `--${boundary}\r\nContent-Location: http://x/frames/1\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const body = new Uint8Array(head.length + data.length + tail.length);
    body.set(Uint8Array.from(head, (c) => c.charCodeAt(0)));
    body.set(data, head.length);
    body.set(Uint8Array.from(tail, (c) => c.charCodeAt(0)), head.length + data.length);
    return [body, `multipart/related; type="application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1"; boundary=${boundary}`];
  }

  it('extracts the frame from a multipart response, including bytes that look like line breaks', () => {
    const data = Uint8Array.from([0x0d, 0x0a, 0x2d, 0x2d, 0x01, 0x02, 0xff, 0x00]);
    const [body, type] = multipart(data);
    expect(Array.from(firstPart(body, type))).toEqual(Array.from(data));
    const [quoted] = multipart(data, 'q');
    expect(Array.from(firstPart(quoted, 'multipart/related; boundary="q"'))).toEqual(Array.from(data));
    expect(() => firstPart(body, 'application/octet-stream')).toThrow(/boundary/);
  });

  it('decodes 16-bit little-endian pixels, signed and unsigned', () => {
    const bytes = Uint8Array.from([0x00, 0x04, 0xff, 0xff, 0x01, 0x00, 0x00, 0x80]);
    expect(Array.from(decodePixels(bytes, info))).toEqual([1024, 65535, 1, 32768]);
    expect(Array.from(decodePixels(bytes, { ...info, pixelRepresentation: 1 }))).toEqual([1024, -1, 1, -32768]);
    expect(Array.from(decodePixels(Uint8Array.from([1, 2, 3, 4]), { ...info, bitsAllocated: 8 }))).toEqual([1, 2, 3, 4]);
  });

  it('refuses what it cannot display, with a message that points to OHIF', () => {
    expect(() => decodePixels(new Uint8Array(3), info)).toThrow(/OHIF/);
    expect(() => decodePixels(new Uint8Array(12), { ...info, samplesPerPixel: 3, photometric: 'RGB' })).toThrow(/OHIF/);
  });

  it('reads series and instances from DICOM JSON and sorts by instance number', () => {
    expect(
      parseSeries([{ '0020000E': { Value: ['1.2'] }, '00080060': { Value: ['CT'] }, '0008103E': { Value: ['AX'] } }]),
    ).toEqual([{ seriesInstanceUid: '1.2', modality: 'CT', description: 'AX' }]);
    const ds = (sop: string, n: number) => ({
      '00080018': { Value: [sop] },
      '0020000E': { Value: ['1.2'] },
      '00200013': { Value: [n] },
      '00080060': { Value: ['CT'] },
      '00280010': { Value: [64] },
      '00280011': { Value: [32] },
      '00280100': { Value: [16] },
      '00280103': { Value: [0] },
      '00281052': { Value: ['-1024'] },
      '00281053': { Value: ['1'] },
    });
    const got = parseInstances([ds('1.2.3.2', 2), ds('1.2.3.1', 1)]);
    expect(got.map((i) => i.sopInstanceUid)).toEqual(['1.2.3.1', '1.2.3.2']);
    expect(got[0]).toMatchObject({ rows: 64, columns: 32, intercept: -1024, slope: 1, windowCenter: null });
    expect(parseInstances({ detail: 'x' })).toEqual([]);
  });
});
