import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProjectSummary } from '../../src/pages/admin/UsersPage';

const user = { id: 9, username: 'md09', account_type: 'user' as const };

describe('帳號管理：所屬專案摘要', () => {
  it('1 個專案顯示名稱連結', () => {
    render(
      <MemoryRouter>
        <ProjectSummary user={user} list={[{ id: 1, name: 'P1-lung-ct', role: 'Viewer' }]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'P1-lung-ct' })).toHaveAttribute('href', '/admin/projects/1');
  });

  it('多個專案顯示「N 個專案」，滑過可看全部、展開列出連結', () => {
    render(
      <MemoryRouter>
        <ProjectSummary
          user={user}
          list={[
            { id: 1, name: 'P1-lung-ct', role: 'Viewer' },
            { id: 2, name: 'P2-tabular', role: 'Medical Doctor' },
          ]}
        />
      </MemoryRouter>,
    );
    const summary = screen.getByText('2 個專案');
    expect(summary).toHaveAttribute('title', 'P1-lung-ct（Viewer）、P2-tabular（Medical Doctor）');
    expect(screen.getByRole('link', { name: 'P2-tabular', hidden: true })).toHaveAttribute('href', '/admin/projects/2');
  });

  it('沒有專案時顯示未加入', () => {
    render(
      <MemoryRouter>
        <ProjectSummary user={user} list={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('未加入')).toBeInTheDocument();
  });
});
