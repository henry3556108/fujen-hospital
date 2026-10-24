import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../../src/mocks/server';
import { clearDicomThumbCache, DicomThumbView } from '../../../src/components/ui';

const ROOT = 'http://api.test/dicomweb/projects/7';
const getToken = async () => 'tok-1';

describe('DicomThumb', () => {
  let created: number;
  const revoke = vi.fn();
  beforeEach(() => {
    created = 0;
    revoke.mockClear();
    clearDicomThumbCache();
    URL.createObjectURL = vi.fn(() => `blob:thumb-${++created}`);
    URL.revokeObjectURL = revoke;
  });
  afterEach(() => vi.restoreAllMocks());

  it('loads the given series thumbnail with the bearer token and frees the URL on unmount', async () => {
    let auth: string | null = null;
    server.use(
      http.get(`${ROOT}/studies/1.2.3/series/1.2.3.4/thumbnail`, ({ request }) => {
        auth = request.headers.get('authorization');
        return new HttpResponse(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
      }),
    );
    const { unmount } = render(
      <DicomThumbView base="http://api.test" projectId={7} studyUid="1.2.3" seriesUid="1.2.3.4" getToken={getToken} alt="CASE-093 縮圖" />,
    );
    const img = await screen.findByRole('img', { name: 'CASE-093 縮圖' });
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', 'blob:thumb-1');
    expect(auth).toBe('Bearer tok-1');
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:thumb-1');
  });

  it('without a series, asks the study for its first series', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${ROOT}/studies/9.9/series`, () => {
        seen.push('series');
        return HttpResponse.json([{ '0020000E': { vr: 'UI', Value: ['9.9.1'] } }, { '0020000E': { vr: 'UI', Value: ['9.9.2'] } }]);
      }),
      http.get(`${ROOT}/studies/9.9/series/9.9.1/thumbnail`, () => {
        seen.push('thumb');
        return new HttpResponse(new Uint8Array([1]), { headers: { 'Content-Type': 'image/jpeg' } });
      }),
    );
    render(<DicomThumbView base="http://api.test" projectId={7} studyUid="9.9" getToken={getToken} />);
    await waitFor(() => expect(screen.getByTestId('dicom-thumb')).toHaveAttribute('data-status', 'ok'));
    expect(seen).toEqual(['series', 'thumb']);
  });

  it('shows a grey placeholder when the request fails', async () => {
    server.use(http.get(`${ROOT}/studies/5.5/series/5.5.1/thumbnail`, () => new HttpResponse(null, { status: 403 })));
    render(<DicomThumbView base="http://api.test" projectId={7} studyUid="5.5" seriesUid="5.5.1" getToken={getToken} />);
    await waitFor(() => expect(screen.getByTestId('dicom-thumb')).toHaveAttribute('data-status', 'error'));
    expect(screen.getByRole('img', { name: '影像縮圖（無法載入）' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '影像縮圖' })).toBeNull();
  });

  it('waits until it scrolls into view when IntersectionObserver exists', async () => {
    let trigger: ((entries: Partial<IntersectionObserverEntry>[]) => void) | null = null;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (e: Partial<IntersectionObserverEntry>[]) => void) {
          trigger = cb;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    let calls = 0;
    server.use(
      http.get(`${ROOT}/studies/4.4/series/4.4.1/thumbnail`, () => {
        calls += 1;
        return new HttpResponse(new Uint8Array([1]), { headers: { 'Content-Type': 'image/jpeg' } });
      }),
    );
    render(<DicomThumbView base="http://api.test" projectId={7} studyUid="4.4" seriesUid="4.4.1" getToken={getToken} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
    expect(screen.getByTestId('dicom-thumb')).toHaveAttribute('data-status', 'idle');
    trigger!([{ isIntersecting: true }]);
    await waitFor(() => expect(screen.getByTestId('dicom-thumb')).toHaveAttribute('data-status', 'ok'));
    expect(calls).toBe(1);
    expect(disconnect).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
