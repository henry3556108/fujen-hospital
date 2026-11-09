// 大型語言模型照設計稿重做（A08、B13～B16）：流程圖、範本挑選、文件 ⋮ 刪除、Markdown 工具列與預覽、版本唯讀。
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../src/mocks/server';
import { renderApp } from '../render';
import { FlowChart, flowOrder, sampleInput } from '../../src/pages/llm/WorkflowsPage';
import { applyEdit, renderMarkdown } from '../../src/pages/llm/markdown';
import { uniqueSources } from '../../src/pages/llm/PlaygroundPage';
import { modelState } from '../../src/pages/llm/ModelsPage';
import type { CatalogModel } from '../../src/pages/llm/api';

const DEF = {
  state: { question: '', mode: 'x' },
  entry: 'ask',
  nodes: [
    { id: 'final', type: 'template', output: 'answer' },
    { id: 'ask', type: 'condition', key: 'question', operator: 'not_empty', then: 'search', else: 'final' },
    { id: 'search', type: 'retrieve', kb_id: 1, output: 'context' },
  ],
  edges: [['search', 'final'], ['final', 'END']],
};

describe('LangGraph 工作流：流程圖', () => {
  it('walks from entry along edges; condition goes then before else', () => {
    expect(flowOrder(DEF).map((n) => n.id)).toEqual(['ask', 'search', 'final']);
    expect(flowOrder({ nodes: [{ id: 'a', type: 'llm' }, { id: 'b', type: 'llm' }] }).map((n) => n.id)).toEqual(['a', 'b']);
    expect(JSON.parse(sampleInput(DEF))).toEqual({ question: '', mode: 'x' });
  });

  it('draws boxes with kinds, branches and the run status', () => {
    render(<FlowChart def={DEF} statuses={new Map([['search', 'failed']])} describe={(n) => (n.type === 'retrieve' ? '院內作業規範' : '')} />);
    const chart = screen.getByRole('list', { name: '節點流程圖' });
    const items = within(chart).getAllByRole('listitem');
    expect(items).toHaveLength(4); // 三個節點＋結束
    expect(items[0]).toHaveTextContent('條件判斷');
    expect(items[0]).toHaveTextContent('符合 → search；不符合 → final');
    expect(items[1]).toHaveTextContent('查 RAG 知識庫：院內作業規範');
    expect(items[1]).toHaveTextContent('失敗');
    expect(items[3]).toHaveTextContent('結束');
  });

  it('creates a flow, runs it and keeps the latest result per node', async () => {
    const { user } = await renderApp('/llm/workflows', 'ca01');
    const form = await screen.findByRole('form', { name: '新增工作流' });
    await user.type(within(form).getByLabelText('名稱'), '摘要流程');
    await user.click(within(form).getByRole('button', { name: '新增工作流' }));
    expect(await screen.findByRole('form', { name: '流程設定' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: '節點流程圖' })).getAllByRole('listitem')).toHaveLength(4);
    await user.click(screen.getByRole('tab', { name: '執行輸入' }));
    expect(JSON.parse((screen.getByLabelText('執行輸入（JSON）') as HTMLTextAreaElement).value)).toEqual({ question: '' });
    await user.click(screen.getByRole('button', { name: /執行流程/ }));
    const result = await screen.findByRole('region', { name: '上次執行結果' });
    expect(within(result).getByText('執行成功')).toBeInTheDocument();
    expect(within(result).getByText('答覆：…')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '執行結果' }));
    expect(within(screen.getByRole('list', { name: '逐節點結果' })).getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('對話與 RAG 知識庫', () => {
  it('sources are listed once per document paragraph', () => {
    const s = { document_id: 1, filename: 'a.pdf', chunk_index: 0, score: 1 };
    expect(uniqueSources([s, { ...s, score: 0.5 }, { ...s, chunk_index: 2 }])).toHaveLength(2);
  });

  it('picks a shared prompt template from the left list', async () => {
    const { user } = await renderApp('/llm/chat', 'ca01');
    await user.click(await screen.findByRole('tab', { name: '公開 Prompt' }));
    await user.click(await screen.findByRole('button', { name: '出院摘要' }));
    expect(screen.getByRole('button', { name: '出院摘要' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('form', { name: '送出訊息' })).toHaveTextContent('使用 Prompt：出院摘要');
  });

  it('deletes a document from its ⋮ menu after confirming', async () => {
    let docs = [{ id: 7, kb_id: 1, filename: 'hours.pdf', format: 'pdf', chunks: 3, size: 12_900_000, uploaded_by: 'ca01', uploaded_at: '2026-10-23T02:15:00Z' }];
    const deleted: string[] = [];
    server.use(
      http.get('*/api/projects/:pid/llm/knowledge-bases/:id/documents', () => HttpResponse.json(docs)),
      http.delete('*/api/projects/:pid/llm/knowledge-bases/:id/documents/:doc', ({ params }) => {
        deleted.push(String(params.doc));
        docs = [];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = await renderApp('/llm/docs', 'ca01');
    const table = await screen.findByRole('table', { name: 'RAG 知識庫' });
    await user.click(within(await within(table).findByRole('row', { name: /院內作業規範/ })).getByRole('button', { name: '管理文件' }));
    const list = await screen.findByRole('list', { name: '文件與處理狀態' });
    const item = within(list).getAllByRole('listitem')[0];
    expect(item).toHaveTextContent('可使用');
    expect(item).toHaveTextContent('上傳日期 2026/10/23 · 12.3 MB');
    await user.click(within(item).getByRole('button', { name: /更多操作/ }));
    await user.click(screen.getByRole('menuitem', { name: '刪除文件' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '刪除' }));
    expect(await screen.findByText('這個 RAG 知識庫還沒有文件，按「加入文件」上傳。')).toBeInTheDocument();
    expect(deleted).toEqual(['7']);
  });
});

describe('模型管理', () => {
  const m = (over: Partial<CatalogModel>) => ({ name: 'x', installed: false, loaded: false, ...over }) as CatalogModel;
  it('status badge follows the design words', () => {
    expect(modelState(m({ loaded: true, installed: true }), []).label).toBe('已載入');
    expect(modelState(m({ installed: true }), []).label).toBe('已下載');
    expect(modelState(m({}), [{ name: 'x', status: 'pending' } as never]).label).toBe('申請中');
    expect(modelState(m({}), []).label).toBe('可申請');
  });

  it('search and token both have labels; empty list shows a row instead of a bare header', async () => {
    server.use(http.get('*/api/projects/:pid/llm/models/catalog', () => HttpResponse.json([])));
    await renderApp('/llm/models', 'ca01');
    expect(await screen.findByText('白名單內還沒有模型。')).toBeInTheDocument();
    expect(screen.getByLabelText('搜尋模型')).toBeInTheDocument();
    expect(screen.getByLabelText('下載 Token（選填）')).toBeInTheDocument();
  });
});

describe('RAG 知識庫：空狀態', () => {
  it('shows an empty row when there is no document set', async () => {
    server.use(http.get('*/api/projects/:pid/llm/knowledge-bases', () => HttpResponse.json([])));
    await renderApp('/llm/docs', 'ca01');
    const table = await screen.findByRole('table', { name: 'RAG 知識庫' });
    expect(await within(table).findByText(/尚無 RAG 知識庫/)).toBeInTheDocument();
  });
});

describe('Wiki 知識庫：Markdown', () => {
  it('toolbar wraps the selection or prefixes the line', () => {
    expect(applyEdit('abc', 0, 3, { wrap: ['**', '**'], placeholder: 'x' })).toEqual({ value: '**abc**', start: 2, end: 5 });
    expect(applyEdit('line', 4, 4, { prefix: '- ', placeholder: '項目' }).value).toBe('line- 項目');
    expect(applyEdit('a\nb', 0, 3, { prefix: '1. ', placeholder: '項目' }).value).toBe('1. a\n1. b');
  });

  it('preview renders headings, lists and safe links only', () => {
    render(<div data-testid="md">{renderMarkdown('# 研究流程\n說明 **重點**\n\n1. 收集\n2. 標註\n\n[外部](javascript:alert(1)) [院內](https://x.test)')}</div>);
    const md = screen.getByTestId('md');
    expect(within(md).getByRole('heading', { name: '研究流程' })).toBeInTheDocument();
    expect(within(md).getAllByRole('listitem')).toHaveLength(2);
    expect(within(md).getByText('重點').tagName).toBe('STRONG');
    expect(within(md).getAllByRole('link')).toHaveLength(1);
  });

  it('preview tab shows the rendered page and old versions open read-only', async () => {
    const { user } = await renderApp('/llm/wiki', 'ca01');
    const create = await screen.findByRole('form', { name: '新增頁面' });
    await user.type(within(create).getByLabelText('頁面路徑'), 'sop/a');
    await user.type(within(create).getByLabelText('標題'), '研究流程');
    await user.type(within(create).getByLabelText(/^內容/), '# 第一版');
    await user.click(within(create).getByRole('button', { name: '儲存文件' }));
    const edit = await screen.findByRole('form', { name: '編輯頁面' });
    await user.click(within(edit).getByRole('tab', { name: '預覽' }));
    expect(within(edit).getByRole('heading', { name: '第一版' })).toBeInTheDocument();
    await user.click(within(edit).getByRole('tab', { name: '編輯' }));
    await user.click(within(edit).getByRole('button', { name: '儲存文件' }));
    await waitFor(() => expect(screen.getByRole('list', { name: '版本紀錄' })).toHaveTextContent('第 2 版（目前）'));
    await user.click(screen.getByRole('button', { name: /^第 1 版/ }));
    expect(await screen.findByLabelText('舊版內容')).toHaveTextContent('# 第一版');
    expect(screen.getByRole('dialog')).toHaveTextContent('第 1 版（唯讀）');
  });
});
