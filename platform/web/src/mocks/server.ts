import { setupServer } from 'msw/node';
import { handlers } from './handlers';
import { pageHandlers } from './pages';

export const server = setupServer(...handlers, ...pageHandlers);
