// 共用版面元件（照設計稿 ui/png、ui2/png）。用法與對應頁面見同目錄 README.md。
import './ui.css';

export { PageHeader, type Crumb } from './PageHeader';
export { Card } from './Card';
export { StatTile, type StatTone } from './StatTile';
export { Stepper, stepState, type Step, type StepState } from './Stepper';
export { OptionCard, OptionCardGroup } from './OptionCard';
export { SidePanel, SplitLayout, InfoList } from './SidePanel';
export { SlideOver } from './SlideOver';
export { ProgressBar, ConfirmProgress, SegmentBar, formatPercent, type ProgressTone } from './ProgressBar';
export { BarList, type BarListItem } from './BarList';
export { Pagination, pageItems } from './Pagination';
export { Toggle } from './Toggle';
export { SegmentedTabs, tabPanelId, type SegmentedTab } from './SegmentedTabs';
export { Badge, StatusDot, type BadgeTone } from './Badge';
export { EmptyState } from './EmptyState';
export { DicomThumb, DicomThumbView, fetchThumbnail, clearDicomThumbCache } from './DicomThumb';
export { CodeBlock } from './CodeBlock';
// 沿用的既有元件，一併從這裡匯出
export { StatusBadge } from '../StatusBadge';
export { Tabs, type TabItem } from '../Tabs';
export { Alert, ApiErrorAlert } from '../Alert';
export { ConfirmDialog } from '../ConfirmDialog';
export { Icon, type IconName } from '../Icon';
