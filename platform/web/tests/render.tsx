import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App';
import { TestAuthAdapter } from '../src/auth/testAdapter';

/** 以 test 登入模式、在指定路徑渲染整個 App；username 為 null 代表未登入。 */
export async function renderApp(path: string, username: string | null = 'admin01') {
  const auth = new TestAuthAdapter();
  if (username) await auth.login({ username });
  const user = userEvent.setup();
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <App auth={auth} apiBase="" />
    </MemoryRouter>,
  );
  return { ...utils, user, auth };
}
