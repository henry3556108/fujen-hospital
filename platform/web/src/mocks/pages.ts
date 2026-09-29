// WP2／WP3／WP4 頁面的模擬 API。由 mocks/server.ts、mocks/browser.ts 掛上。
import { imagingHandlers } from './imaging';
import { schedulingHandlers } from './scheduling';
import { tabularHandlers } from './tabular';

export const pageHandlers = [...schedulingHandlers, ...imagingHandlers, ...tabularHandlers];
