// 工作台工具列的圖示（設計稿 A03：移動、放大、WC、圈選、塗抹、復原、更多工具）。
// 共用 Icon 沒有這幾個，先放在標註區自己用。

export type ToolIconName = 'hand' | 'zoom' | 'contrast' | 'select' | 'brush' | 'undo' | 'more';

const PATHS: Record<Exclude<ToolIconName, 'select'>, string> = {
  hand: 'M13 2a1.5 1.5 0 0 0-1.5 1.5V11h-1V4.5a1.5 1.5 0 0 0-3 0V13l-1.8-1.9a1.5 1.5 0 0 0-2.2 2l4.2 5.3A6 6 0 0 0 12.4 22H14a6 6 0 0 0 6-6V7.5a1.5 1.5 0 0 0-3 0V11h-1V3.5A1.5 1.5 0 0 0 14.5 2H13Z',
  zoom: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16a6.47 6.47 0 0 0 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5Zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z',
  contrast: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18V4a8 8 0 0 1 0 16Z',
  brush: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm17.71-10.21a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z',
  undo: 'M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62A7.95 7.95 0 0 1 12.5 10.5c3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8Z',
  more: 'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
};

export function ToolIcon({ name }: { name: ToolIconName }) {
  return (
    <svg className="lb-tool__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      {name === 'select' ? (
        <rect x="4" y="4" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2" />
      ) : (
        <path d={PATHS[name]} fill="currentColor" />
      )}
    </svg>
  );
}
