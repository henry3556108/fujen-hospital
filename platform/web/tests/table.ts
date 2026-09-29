import { within } from '@testing-library/react';

/** 一列的所有儲存格文字（th 與 td，依畫面順序）。 */
export function cellsOf(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll('th,td')).map((c) => c.textContent ?? '');
}

/** 表格內容（不含表頭列）。 */
export function bodyRows(table: HTMLElement): string[][] {
  return within(table).getAllByRole('row').slice(1).map(cellsOf);
}
