import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAuthAdapter } from './auth/adapter';

async function bootstrap() {
  // API 模擬只在 dev server 開啟，production build 會整段移除。
  if (__DEV_SERVER__ && import.meta.env.VITE_API_MOCK === '1') {
    const { worker } = await import('./mocks/browser');
    await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
  }
  const auth = await createAuthAdapter();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <p>{auth.mode}</p>
    </StrictMode>,
  );
}

void bootstrap();
