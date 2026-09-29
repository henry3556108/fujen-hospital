import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { pageHandlers } from './pages';
import { enableMockPersistence, persistModuleStates } from './support';

export const worker = setupWorker(...handlers, ...pageHandlers);

// WP2／WP3／WP4 頁面的模擬狀態在同一個分頁內重新載入後保留（sessionStorage）
enableMockPersistence();
worker.events.on('response:mocked', persistModuleStates);
