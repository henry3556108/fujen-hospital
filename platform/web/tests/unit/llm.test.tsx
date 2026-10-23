import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../src/mocks/server';
import { renderApp } from '../render';

const chatForm = () => screen.findByRole('form', { name: '送出訊息' });

async function send(user: ReturnType<typeof import('@testing-library/user-event').default.setup>, text: string) {
  const form = await chatForm();
  await user.type(within(form).getByLabelText('訊息'), text);
  await user.click(within(form).getByRole('button', { name: '送出' }));
}

describe('LLM No-code 開發', () => {
  it('/llm opens the 對話 tab for a coder', async () => {
    await renderApp('/llm', 'ca01');
    expect(await screen.findByRole('heading', { level: 1, name: '語言模型' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '對話測試' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '對話' })).toHaveAttribute('aria-current', 'page');
  });

  it('TC-A03-05 viewer typing /llm/playground is denied', async () => {
    await renderApp('/llm/playground', 'vw01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
    expect(screen.getByText(/沒有 Coding 權限/)).toBeInTheDocument();
  });

  it('TC-B07-03 free chat and chat with knowledge base show replies and sources', async () => {
    const { user } = await renderApp('/llm/playground', 'ca01');
    await send(user, '你好');
    const log = screen.getByRole('list', { name: '對話內容' });
    expect(await within(log).findByText('[fake-llm] echo: 你好')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('對話模式'), 'kb');
    expect(within(log).queryByText('[fake-llm] echo: 你好')).toBeNull();          // 換模式開新對話
    expect(screen.getByText('請先選擇參考文件。')).toBeInTheDocument();
    await user.selectOptions(await screen.findByLabelText('參考文件'), '1');
    await send(user, '門診時間');
    expect(await within(log).findByText('出處：outpatient_hours.pdf')).toBeInTheDocument();
  });

  it('TC-B07-08 model outage shows a retry prompt, keeps the message and retries', async () => {
    let calls = 0;
    server.use(
      http.post('*/api/projects/:pid/llm/chat', () => {
        calls++;
        if (calls === 1) {
          return HttpResponse.json({ detail: { code: 'llm_unavailable', message: '模型服務中斷，請稍後重試', retry: true } }, { status: 503 });
        }
        return HttpResponse.json({ session_id: 1, mode: 'free', model: 'm', call_id: 2, latency_ms: 1,
          message: { id: 2, role: 'assistant', content: '恢復了', sources: [], call_id: 2 } });
      }),
    );
    const { user } = await renderApp('/llm/playground', 'ca01');
    await send(user, '還在嗎');
    const failed = await screen.findByTestId('chat-failed');
    expect(within(failed).getByRole('alert')).toHaveTextContent('模型服務中斷，請稍後重試');
    expect(within(failed).getByRole('alert')).toHaveTextContent('可以直接重試');
    expect(within(await chatForm()).getByLabelText('訊息')).not.toBeDisabled();
    await user.click(within(failed).getByRole('button', { name: '重試' }));
    expect(await screen.findByText('恢復了')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-failed')).toBeNull();
  });

  it('TC-B07-05 generation params are saved with PUT and shown after reload', async () => {
    const { user, unmount } = await renderApp('/llm/playground', 'ca01');
    const form = await screen.findByRole('form', { name: '生成參數' });
    const temp = within(form).getByLabelText('Temperature');
    await user.clear(temp);
    await user.type(temp, '0.35');
    await user.type(within(form).getByLabelText('回答規則（System Prompt）'), '院內助理');
    await user.click(within(form).getByRole('button', { name: '儲存設定' }));
    expect(await within(form).findByText('已儲存生成參數')).toBeInTheDocument();
    unmount();
    await renderApp('/llm/playground', 'ca01');
    const again = await screen.findByRole('form', { name: '生成參數' });
    await waitFor(() => expect(within(again).getByLabelText('Temperature')).toHaveValue(0.35));
    expect(within(again).getByLabelText('回答規則（System Prompt）')).toHaveValue('院內助理');
  });

  it('TC-B07-06 uploading documents sends every file and shows per-file results', async () => {
    // jsdom 的 File 經 MSW 在 Node 解析 multipart 時會遺失檔名，所以這裡固定回應內容，只驗證送出的檔案數與畫面
    let parts = 0;
    server.use(
      http.post('*/api/projects/:pid/llm/knowledge-bases/:id/documents', async ({ request }) => {
        parts = (await request.formData()).getAll('files').length;
        return HttpResponse.json({ kb_id: 1, counts: { indexed: 1, duplicate: 0, failed: 1 }, results: [
          { filename: 'a.txt', status: 'indexed', reason: '', document: null },
          { filename: 'bad.exe', status: 'failed', reason: '不支援的檔案格式', document: null }] }, { status: 201 });
      }),
    );
    const { user } = await renderApp('/llm/docs', 'ca01');
    const table = await screen.findByRole('table', { name: '參考文件集' });
    await user.click(within(await within(table).findByRole('row', { name: /院內作業規範/ })).getByRole('button', { name: '管理文件' }));
    const input = await screen.findByLabelText(/選擇檔案/);
    // 直接觸發 change：瀏覽器的 accept 只是提示，使用者仍可選到其他格式，要由伺服器擋下
    fireEvent.change(input, { target: { files: [new File(['門診'], 'a.txt', { type: 'text/plain' }), new File(['MZ'], 'bad.exe')] } });
    await user.click(screen.getByRole('button', { name: '加入文件' }));
    expect(await screen.findByText('可使用 1 份、重複 0 份、未完成 1 份')).toBeInTheDocument();
    expect(parts).toBe(2);
    const results = screen.getByRole('list', { name: '上傳結果' });
    expect(within(results).getByText('bad.exe：未完成（不支援的檔案格式）')).toBeInTheDocument();
    expect(within(results).getByText('a.txt：可使用')).toBeInTheDocument();
  });

  it('TC-B07-02 creates and searches prompts', async () => {
    const { user } = await renderApp('/llm/prompts', 'ca01');
    const form = await screen.findByRole('form', { name: '新增問答範本' });
    await user.type(within(form).getByLabelText('標題（必填）'), '衛教單張');
    await user.type(within(form).getByLabelText(/^內容/), '請寫衛教單張');
    await user.type(within(form).getByLabelText(/^tag/), '衛教, 病人');
    await user.click(within(form).getByRole('button', { name: '新增問答範本' }));
    expect(await within(form).findByText('已新增問答範本「衛教單張」')).toBeInTheDocument();
    await user.type(screen.getByLabelText('搜尋（標題、內容、tag）'), '衛教');
    await user.click(screen.getByRole('button', { name: '搜尋' }));
    const table = screen.getByRole('table', { name: '問答範本' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
    expect(within(table).getByText('病人', { exact: false })).toBeInTheDocument();
  });

  it('TC-B08-02 / TC-B08-04 wiki create, edit, version and ask', async () => {
    const { user } = await renderApp('/llm/wiki', 'ca01');
    const create = await screen.findByRole('form', { name: '新增頁面' });
    await user.type(within(create).getByLabelText('路徑'), 'sop/visiting');
    await user.type(within(create).getByLabelText('標題'), '探病規定');
    await user.type(within(create).getByLabelText(/^內容/), '探病時間 11 點');
    await user.click(within(create).getByRole('button', { name: '儲存' }));
    const edit = await screen.findByRole('form', { name: '編輯頁面' });
    await user.clear(within(edit).getByLabelText(/^內容/));
    await user.type(within(edit).getByLabelText(/^內容/), '探病時間 18 點');
    await user.click(within(edit).getByRole('button', { name: '儲存' }));
    await user.click(await screen.findByRole('button', { name: /^版本 1/ }));
    expect(await screen.findByLabelText('舊版內容')).toHaveTextContent('探病時間 11 點');
    const ask = screen.getByRole('form', { name: '以這頁問 LLM' });
    await user.type(within(ask).getByLabelText('問題'), '晚上可以探病嗎');
    await user.click(within(ask).getByRole('button', { name: '送出' }));
    expect(await within(ask).findByText(/脈絡來源 wiki_api/)).toBeInTheDocument();
  });
});
