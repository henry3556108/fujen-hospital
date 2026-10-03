// AI 模型部署頁（元件層級，MSW 模擬）。TC-B06-05、TC-B06-06；權限。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { trainingMock } from '../../src/mocks/training';
import { renderApp } from '../render';

const saved: string[] = [];
beforeEach(() => {
  saved.length = 0;
  // jsdom 沒有 Blob URL；下載只檢查存檔的檔名
  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('AI 模型部署', () => {
  it('TC-B06-05 downloads a model three times without failure', async () => {
    const { user } = await renderApp('/deployment', 'pi01');
    const table = await screen.findByRole('table', { name: '可部署的模型' });
    for (let i = 0; i < 3; i += 1) {
      await user.click(within(table).getByRole('button', { name: '下載模型「diagnosis-rf-run1」' }));
      await waitFor(() => expect(saved).toHaveLength(i + 1));
    }
    expect(saved).toEqual(Array(3).fill('diagnosis-rf-run1.pkl'));
    expect(screen.getByText(/^已下載 diagnosis-rf-run1\.pkl（SHA-256：f{64}）$/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('TC-B06-06 shares with colleagues using a Chinese display name; the technical details are collapsed for IT staff', async () => {
    const { user } = await renderApp('/deployment', 'pi01');
    const form = await screen.findByRole('form', { name: '分享給同事使用' });
    await user.selectOptions(within(form).getByLabelText('模型'), within(form).getByRole('option', { name: /^diagnosis-rf-run1/ }));
    const title = within(form).getByLabelText('顯示名稱（同事看到的名稱，可用中文）');
    expect(title).toHaveValue('diagnosis-rf');
    expect(within(form).getByTestId('share-explain')).toHaveTextContent('點左側「推論服務管理」，在模型清單找到「diagnosis-rf-run1」');
    await user.clear(title);
    await user.type(title, '心臟科確診預測');
    await user.type(within(form).getByLabelText('分享給（同事的帳號，以逗號分隔）'), 'md01, pi01');
    await user.click(within(form).getByRole('button', { name: '分享給同事使用' }));
    expect(await screen.findByText('已把「心臟科確診預測」分享給 md01、pi01。他們登入後點左側「推論服務管理」，選模型「diagnosis-rf-run1」就能預測。')).toBeInTheDocument();
    expect(trainingMock().deployments[0]).toMatchObject({ name: 'model-101', title: '心臟科確診預測' });

    const table = await screen.findByRole('table', { name: '已分享的模型' });
    const row = within(table).getByRole('row', { name: /心臟科確診預測/ });
    expect(row).toHaveTextContent('diagnosis-rf-run1');
    expect(row).toHaveTextContent('md01、pi01');
    expect(row).not.toHaveTextContent('/api/inference');
    const details = screen.getByTestId('it-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText('給資訊人員：程式呼叫方式')).toBeInTheDocument();
    expect(within(details).getByRole('table', { name: '程式呼叫端點' })).toHaveTextContent('POST /api/inference/model-101/predict');
    expect(within(details).getByLabelText('「model-101」的呼叫範例')).toHaveTextContent('"rows"');
    expect(details).toHaveTextContent('403');

    // 不存在的帳號：顯示伺服器訊息，分享對象不變
    await user.click(within(row).getByRole('button', { name: '修改分享對象「心臟科確診預測」' }));
    const access = screen.getByRole('form', { name: '修改分享對象' });
    const input = within(access).getByLabelText(/分享給/);
    await user.clear(input);
    await user.type(input, 'md01, ghost');
    await user.click(within(access).getByRole('button', { name: '儲存分享對象' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('帳號不存在：ghost');
    expect(trainingMock().deployments[0].allowed_users).toEqual(['md01', 'pi01']);

    await user.clear(input);
    await user.type(input, 'user01');
    await user.click(within(access).getByRole('button', { name: '儲存分享對象' }));
    expect(await screen.findByText(/^已更新「心臟科確診預測」的分享對象：user01。注意：user01 不是本專案有推論權限的成員/)).toBeInTheDocument();

    await user.click(within(table).getByRole('button', { name: '停止分享「心臟科確診預測」' }));
    await user.click(within(screen.getByRole('dialog', { name: '停止分享' })).getByRole('button', { name: '停止分享' }));
    expect(await screen.findByText(/^已停止分享「心臟科確診預測」/)).toBeInTheDocument();
    expect(await screen.findByText('還沒有分享任何模型。')).toBeInTheDocument();
    expect(trainingMock().deployments).toHaveLength(0);
  });

  it('sharing needs at least one colleague', async () => {
    const { user } = await renderApp('/deployment', 'pi01');
    const form = await screen.findByRole('form', { name: '分享給同事使用' });
    await user.click(within(form).getByRole('button', { name: '分享給同事使用' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('請填要分享的同事帳號');
  });

  it('a model trained on 建模管理 can be shared and md01 finds it on 推論服務管理 and predicts', async () => {
    const s = trainingMock();
    s.models.push({ id: 1001, project_id: 1, name: '心臟科訓練-run1', kind: 'tabular_classification', format: 'pkl', sha256: 'a'.repeat(64),
      filename: 'run1.pkl', created_by: 'pi01', created_at: '2026-09-30T00:00:00Z',
      card: { target: 'diagnosis', features: ['age'], classes: ['0', '1'], inputs: [{ name: 'age', type: 'number', min: 20, max: 90 }] } });
    const first = await renderApp('/deployment', 'pi01');
    const form = await screen.findByRole('form', { name: '分享給同事使用' });
    await first.user.selectOptions(within(form).getByLabelText('模型'), '1001');
    expect(within(form).getByLabelText('顯示名稱（同事看到的名稱，可用中文）')).toHaveValue('心臟科訓練');
    await first.user.type(within(form).getByLabelText('分享給（同事的帳號，以逗號分隔）'), 'md01');
    await first.user.click(within(form).getByRole('button', { name: '分享給同事使用' }));
    await screen.findByText(/^已把「心臟科訓練」分享給 md01/);
    first.unmount();

    const second = await renderApp('/inference', 'md01');
    const models = await screen.findByRole('table', { name: '模型清單' });
    const row = within(models).getByRole('row', { name: /心臟科訓練-run1/ });
    expect(row).toHaveTextContent('pi01 分享給你');
    expect(within(row).getByRole('button', { name: '已選擇' })).toBeDisabled();
    await second.user.click(screen.getByRole('button', { name: '批次推論' }));
    expect(await screen.findByTestId('table-summary', {}, { timeout: 10_000 })).toHaveTextContent(/^共 20 位/);
  });

  it('users with Prediction but no Training see the models but no deploy or download actions', async () => {
    await renderApp('/deployment', 'vw01');
    const table = await screen.findByRole('table', { name: '可部署的模型' });
    expect(within(table).getByRole('row', { name: /diagnosis-rf-run1/ })).toBeInTheDocument();
    expect(screen.getByText(/分享模型、下載模型需要 Training 權限/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: '分享給同事使用' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^下載模型/ })).toBeNull();
    expect(screen.queryByRole('table', { name: '已分享的模型' })).toBeNull();
  });
});
