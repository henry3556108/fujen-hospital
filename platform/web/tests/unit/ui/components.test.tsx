import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import {
  Badge,
  BarList,
  Card,
  CodeBlock,
  ConfirmProgress,
  EmptyState,
  InfoList,
  OptionCard,
  OptionCardGroup,
  PageHeader,
  Pagination,
  ProgressBar,
  SegmentBar,
  SegmentedTabs,
  SidePanel,
  SlideOver,
  SplitLayout,
  StatTile,
  StatusDot,
  Stepper,
  Toggle,
  formatPercent,
  pageItems,
  stepState,
} from '../../../src/components/ui';

const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('PageHeader', () => {
  it('shows an h1, the grey subtitle, actions and breadcrumbs', () => {
    inRouter(
      <PageHeader
        title="研究資料"
        subtitle="胸腔影像研究"
        actions={<button type="button">加入資料</button>}
        breadcrumbs={[{ label: '使用模型', to: '/models' }, { label: '模型結果' }]}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: '研究資料' })).toBeInTheDocument();
    expect(screen.getByText('胸腔影像研究')).toHaveClass('ui-page-header__subtitle');
    expect(screen.getByRole('button', { name: '加入資料' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: '目前位置' });
    expect(within(crumbs).getByRole('link', { name: '使用模型' })).toHaveAttribute('href', '/models');
    expect(within(crumbs).getByText('模型結果')).toHaveAttribute('aria-current', 'page');
  });
});

describe('Card', () => {
  it('is a section named by its title, with an extra slot', () => {
    inRouter(
      <Card title="最近處理" extra={<a href="/x">查看全部</a>}>
        內容
      </Card>,
    );
    const region = screen.getByRole('region', { name: '最近處理' });
    expect(within(region).getByRole('heading', { level: 2, name: '最近處理' })).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: '查看全部' })).toBeInTheDocument();
    expect(region).toHaveTextContent('內容');
  });
});

describe('StatTile', () => {
  it('static tile shows label, value and unit', () => {
    render(<StatTile label="專案總數" value={12} unit="個" icon="folder" />);
    expect(screen.getByText('專案總數')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('becomes a button with onClick, or a link with to', async () => {
    const onClick = vi.fn();
    const { unmount } = render(<StatTile label="待處理事項" value={2} tone="warning" onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: /待處理事項/ }));
    expect(onClick).toHaveBeenCalledOnce();
    unmount();
    inRouter(<StatTile label="帳號總數" value={28} to="/admin/users" />);
    expect(screen.getByRole('link', { name: /帳號總數/ })).toHaveAttribute('href', '/admin/users');
  });
});

describe('Stepper', () => {
  const steps = [{ label: '選研究目的' }, { label: '確認資料' }, { label: '確認並送出', description: '最後一步' }];

  it('numbers steps itself once, marks done / current / todo', () => {
    render(<Stepper steps={steps} current={1} label="建立模型步驟" />);
    const list = screen.getByRole('list', { name: '建立模型步驟' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveClass('ui-stepper__step--done');
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[2]).toHaveClass('ui-stepper__step--todo');
    expect(items[2]).toHaveTextContent('3');
    expect(items[2]).toHaveTextContent('最後一步');
    // 不可出現「1. 1.」這種重複編號
    for (const li of items) expect(li.textContent).not.toMatch(/\d+\.\s*\d+\./);
    expect(stepState(0, 1)).toBe('done');
    expect(stepState(2, 3)).toBe('done');
  });
});

describe('OptionCard', () => {
  it('works as a radio group', async () => {
    function Demo() {
      const [v, setV] = useState('classify');
      return (
        <OptionCardGroup legend="選擇研究目的">
          <OptionCard name="task" value="classify" title="判斷影像類別" description="輸入影像後判斷類別" selected={v === 'classify'} onSelect={setV} />
          <OptionCard name="task" value="detect" title="圈出位置" selected={v === 'detect'} onSelect={setV} />
          <OptionCard name="task" value="segment" title="標出範圍" selected={v === 'segment'} onSelect={setV} disabled />
        </OptionCardGroup>
      );
    }
    render(<Demo />);
    const group = screen.getByRole('group', { name: '選擇研究目的' });
    expect(within(group).getByRole('radio', { name: /判斷影像類別/ })).toBeChecked();
    await userEvent.click(within(group).getByText('圈出位置'));
    expect(within(group).getByRole('radio', { name: /圈出位置/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /標出範圍/ })).toBeDisabled();
  });
});

describe('SidePanel / SplitLayout / InfoList', () => {
  it('renders a named complementary panel; close button only with onClose', async () => {
    const onClose = vi.fn();
    render(
      <SplitLayout side={<SidePanel title="資料集資訊" onClose={onClose}><InfoList items={[{ label: '影像總數', value: '120 筆' }]} /></SidePanel>}>
        <p>主內容</p>
      </SplitLayout>,
    );
    const panel = screen.getByRole('complementary', { name: '資料集資訊' });
    expect(within(panel).getByText('影像總數')).toBeInTheDocument();
    expect(within(panel).getByText('120 筆')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: '關閉' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('SlideOver', () => {
  it('opens as a modal dialog; Esc, the close button and the backdrop close it', async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <SlideOver open={false} title="加入資料" onClose={onClose}>
        內容
      </SlideOver>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(
      <SlideOver open title="加入資料" onClose={onClose} footer={<button type="button">確定</button>}>
        內容
      </SlideOver>,
    );
    const dialog = screen.getByRole('dialog', { name: '加入資料' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole('button', { name: '關閉' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByTestId('slideover-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('ProgressBar / ConfirmProgress / SegmentBar', () => {
  it('exposes a named progressbar with value text', () => {
    render(<ProgressBar label="已確認" value={92} max={120} />);
    const bar = screen.getByRole('progressbar', { name: '已確認' });
    expect(bar).toHaveAttribute('aria-valuenow', '92');
    expect(bar).toHaveAttribute('aria-valuemax', '120');
    expect(screen.getByText('92 / 120')).toBeInTheDocument();
  });

  it('confirmed / pending show two bars with percentages', () => {
    render(<ConfirmProgress confirmed={92} pending={28} totalLabel="筆影像" />);
    expect(screen.getByRole('progressbar', { name: '已確認' })).toHaveAttribute('aria-valuenow', '92');
    expect(screen.getByRole('progressbar', { name: '待確認' })).toHaveAttribute('aria-valuemax', '120');
    expect(screen.getByText('76.7%')).toBeInTheDocument();
    expect(screen.getByText('23.3%')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
  });

  it('segment bar describes each part', () => {
    render(<SegmentBar label="資料切分" segments={[{ label: '訓練資料', value: 70 }, { label: '驗證資料', value: 15 }, { label: '測試資料', value: 15 }]} />);
    expect(screen.getByRole('img', { name: '資料切分：訓練資料 70%、驗證資料 15%、測試資料 15%' })).toBeInTheDocument();
    expect(formatPercent(1, 0)).toBe('0.0%');
  });
});

describe('BarList', () => {
  it('lists each category with count and percent', () => {
    render(<BarList label="類別統計" items={[{ label: '正常', value: 72 }, { label: '異常', value: 48 }]} />);
    const list = screen.getByRole('list', { name: '類別統計' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('正常72（60.0%）');
    expect(rows[1]).toHaveTextContent('異常48（40.0%）');
  });

  it('shows empty text when there is nothing', () => {
    render(<BarList label="來源統計" items={[]} />);
    expect(screen.getByText('沒有資料')).toBeInTheDocument();
  });
});

describe('Pagination', () => {
  it('computes page items with gaps', () => {
    expect(pageItems(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageItems(1, 12)).toEqual([1, 2, 3, 4, 5, '…', 12]);
    expect(pageItems(6, 12)).toEqual([1, '…', 5, 6, 7, '…', 12]);
    expect(pageItems(12, 12)).toEqual([1, '…', 8, 9, 10, 11, 12]);
  });

  it('shows the range, moves pages and changes page size', async () => {
    const onPage = vi.fn();
    const onSize = vi.fn();
    render(<Pagination page={1} pageSize={10} total={120} onPageChange={onPage} onPageSizeChange={onSize} />);
    expect(screen.getByText('顯示第 1–10 筆，共 120 筆')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一頁' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '第 1 頁' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(screen.getByRole('button', { name: '下一頁' }));
    expect(onPage).toHaveBeenLastCalledWith(2);
    await userEvent.click(screen.getByRole('button', { name: '第 12 頁' }));
    expect(onPage).toHaveBeenLastCalledWith(12);
    await userEvent.selectOptions(screen.getByLabelText('每頁顯示'), '20');
    expect(onSize).toHaveBeenCalledWith(20);
  });

  it('handles an empty list', () => {
    render(<Pagination page={1} pageSize={10} total={0} onPageChange={() => undefined} />);
    expect(screen.getByText('顯示第 0–0 筆，共 0 筆')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一頁' })).toBeDisabled();
  });
});

describe('Toggle', () => {
  it('is a switch that flips', async () => {
    function Demo() {
      const [on, setOn] = useState(true);
      return <Toggle label="顯示標註範圍" checked={on} onChange={setOn} />;
    }
    render(<Demo />);
    const sw = screen.getByRole('switch', { name: '顯示標註範圍' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });
});

describe('SegmentedTabs', () => {
  it('selects by click and arrow keys', async () => {
    function Demo() {
      const [v, setV] = useState<'imaging' | 'tabular'>('imaging');
      return (
        <SegmentedTabs
          label="資料種類"
          value={v}
          onChange={setV}
          items={[
            { key: 'imaging', label: '影像' },
            { key: 'tabular', label: '表格' },
          ]}
        />
      );
    }
    render(<Demo />);
    const list = screen.getByRole('tablist', { name: '資料種類' });
    expect(within(list).getByRole('tab', { name: '影像' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(within(list).getByRole('tab', { name: '表格' }));
    expect(within(list).getByRole('tab', { name: '表格' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(within(list).getByRole('tab', { name: '表格' }), { key: 'ArrowRight' });
    expect(within(list).getByRole('tab', { name: '影像' })).toHaveAttribute('aria-selected', 'true');
    expect(within(list).getByRole('tab', { name: '影像' })).toHaveFocus();
  });
});

describe('Badge / StatusDot / EmptyState', () => {
  it('renders text with tone classes', () => {
    render(
      <>
        <Badge tone="success">已確認</Badge>
        <Badge tone="warning">待確認</Badge>
        <StatusDot tone="success">運作正常</StatusDot>
        <EmptyState title="還沒有資料" description="先加入影像" action={<button type="button">加入資料</button>} />
      </>,
    );
    expect(screen.getByText('已確認')).toHaveClass('ui-badge--success');
    expect(screen.getByText('待確認')).toHaveClass('ui-badge--warning');
    expect(screen.getByText('運作正常')).toHaveClass('ui-dot--success');
    expect(screen.getByText('還沒有資料')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加入資料' })).toBeInTheDocument();
  });
});

describe('CodeBlock', () => {
  it('shows line numbers and copies the raw code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const code = 'import joblib\nmodel = joblib.load("model.pkl")\n';
    const { container } = render(<CodeBlock code={code} title="predict.py" />);
    expect(container.querySelectorAll('.ui-code__ln')).toHaveLength(2);
    expect(screen.getByText('predict.py')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '複製' }));
    });
    expect(writeText).toHaveBeenCalledWith(code);
    expect(screen.getByRole('button', { name: '已複製' })).toBeInTheDocument();
  });
});
