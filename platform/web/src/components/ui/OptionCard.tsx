import type { ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';
import './ui.css';

/**
 * 卡片式單選（設計稿 A06「1. 選擇訓練種類」影像分類／物件偵測／影像分割）。
 * 內部是原生 radio，同一組請給相同 name；外層建議包 OptionCardGroup（fieldset＋legend）。
 */
export function OptionCard({
  name,
  value,
  title,
  description,
  icon,
  selected,
  disabled,
  onSelect,
}: {
  name: string;
  value: string;
  title: string;
  description?: ReactNode;
  icon?: IconName;
  selected: boolean;
  disabled?: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    <label className={`ui-option ${selected ? 'ui-option--selected' : ''} ${disabled ? 'ui-option--disabled' : ''}`}>
      <input
        type="radio"
        className="ui-option__radio"
        name={name}
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(value)}
      />
      <span className="ui-option__body">
        <span className="ui-option__title">
          {icon && <Icon name={icon} className="ui-option__icon" />}
          {title}
        </span>
        {description && <span className="ui-option__desc">{description}</span>}
      </span>
    </label>
  );
}

/** 一組 OptionCard：fieldset＋legend，卡片橫排、窄螢幕自動換行。 */
export function OptionCardGroup({ legend, children, hideLegend }: { legend: string; children: ReactNode; hideLegend?: boolean }) {
  return (
    <fieldset className="ui-option-group">
      <legend className={hideLegend ? 'visually-hidden' : 'ui-option-group__legend'}>{legend}</legend>
      <div className="ui-option-group__items">{children}</div>
    </fieldset>
  );
}
