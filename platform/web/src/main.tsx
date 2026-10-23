import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { createAuthAdapter } from './auth/adapter';
import { platformEnv } from './runtimeConfig';
import './theme/tokens.css';
import './styles/app.css';

async function bootstrap() {
  // API 模擬只在 dev server 開啟，任何 vite build 都會整段移除。
  if (__DEV_SERVER__ && import.meta.env.VITE_API_MOCK === '1') {
    const { worker } = await import('./mocks/browser');
    await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
  }
  const auth = await createAuthAdapter();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <App auth={auth} apiBase={platformEnv().VITE_API_BASE ?? ''} />
      </BrowserRouter>
    </StrictMode>,
  );
}

void bootstrap();
