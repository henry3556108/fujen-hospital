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

  it('TC-B06-06 deploys with authorised users, shows the endpoint, edits access and undeploys', async () => {
    const { user } = await renderApp('/deployment', 'pi01');
    const form = await screen.findByRole('form', { name: '部署模型' });
    await user.selectOptions(within(form).getByLabelText('模型'), within(form).getByRole('option', { name: /^diagnosis-rf-run1/ }));
    await user.type(within(form).getByLabelText('部署名稱（小寫英數字與 -）'), 'diagnosis-api');
    await user.type(within(form).getByLabelText('授權帳號（以逗號分隔）'), 'md01, pi01');
    await user.click(within(form).getByRole('button', { name: '部署' }));
    expect(await screen.findByText('已部署「diagnosis-api」：POST /api/inference/diagnosis-api/predict')).toBeInTheDocument();

    const table = await screen.findByRole('table', { name: '線上部署清單' });
    const row = within(table).getByRole('row', { name: /diagnosis-api/ });
    expect(row).toHaveTextContent('diagnosis-rf-run1');
    expect(row).toHaveTextContent('POST /api/inference/diagnosis-api/predict');
    expect(row).toHaveTextContent('md01、pi01');
    expect(screen.getByLabelText('「diagnosis-api」的呼叫範例')).toHaveTextContent('"rows"');

    // 不存在的帳號：顯示伺服器訊息，授權清單不變
    await user.click(within(row).getByRole('button', { name: '管理授權「diagnosis-api」' }));
    const access = screen.getByRole('form', { name: '修改授權帳號' });
    const input = within(access).getByLabelText(/授權帳號/);
    await user.clear(input);
    await user.type(input, 'md01, ghost');
    await user.click(within(access).getByRole('button', { name: '儲存授權帳號' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('帳號不存在：ghost');
    expect(trainingMock().deployments[0].allowed_users).toEqual(['md01', 'pi01']);

    await user.clear(input);
    await user.type(input, 'ra01');
    await user.click(within(access).getByRole('button', { name: '儲存授權帳號' }));
    expect(await screen.findByText('已更新「diagnosis-api」的授權帳號：ra01')).toBeInTheDocument();
    await waitFor(() => expect(within(table).getByRole('row', { name: /diagnosis-api/ })).toHaveTextContent('ra01'));

    await user.click(within(table).getByRole('button', { name: '取消部署「diagnosis-api」' }));
    await user.click(within(screen.getByRole('dialog', { name: '取消部署' })).getByRole('button', { name: '取消部署' }));
    expect(await screen.findByText('已取消部署「diagnosis-api」，端點不再接受呼叫。')).toBeInTheDocument();
    expect(await screen.findByText('還沒有線上部署。')).toBeInTheDocument();
    expect(trainingMock().deployments).toHaveLength(0);
  });

  it('invalid deployment names show the server message', async () => {
    const { user } = await renderApp('/deployment', 'pi01');
    const form = await screen.findByRole('form', { name: '部署模型' });
    await user.type(within(form).getByLabelText('部署名稱（小寫英數字與 -）'), 'Bad Name');
    await user.click(within(form).getByRole('button', { name: '部署' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('部署名稱只能用小寫英數字與連字號');
  });

  it('a model trained on 建模管理 can be deployed', async () => {
    const s = trainingMock();
    s.models.push({ id: 1001, project_id: 1, name: 'new-model-run1', kind: 'image_detection', format: 'h5', sha256: 'a'.repeat(64),
      filename: 'new-model-run1.h5', created_by: 'pi01', created_at: '2026-09-30T00:00:00Z', card: { label_names: ['nodule'] } });
    const { user } = await renderApp('/deployment', 'pi01');
    const form = await screen.findByRole('form', { name: '部署模型' });
    await user.selectOptions(within(form).getByLabelText('模型'), '1001');
    await user.type(within(form).getByLabelText('部署名稱（小寫英數字與 -）'), 'nodule-det');
    await user.click(within(form).getByRole('button', { name: '部署' }));
    await screen.findByText('已部署「nodule-det」：POST /api/inference/nodule-det/predict');
    expect(screen.getByLabelText('「nodule-det」的呼叫範例')).toHaveTextContent('files=@');
  });

  it('users with Prediction but no Training see the models but no deploy or download actions', async () => {
    await renderApp('/deployment', 'vw01');
    const table = await screen.findByRole('table', { name: '可部署的模型' });
    expect(within(table).getByRole('row', { name: /diagnosis-rf-run1/ })).toBeInTheDocument();
    expect(screen.getByText(/部署模型、下載模型與管理授權帳號需要 Training 權限/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: '部署模型' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^下載模型/ })).toBeNull();
    expect(screen.queryByRole('table', { name: '線上部署清單' })).toBeNull();
  });
});
