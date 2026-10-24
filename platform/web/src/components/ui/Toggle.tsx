import './ui.css';

/** 開關（設計稿 A03「顯示標註範圍」）。role="switch"，文字一直顯示。 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  hideLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  hideLabel?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={hideLabel ? label : undefined}
      disabled={disabled}
      className={`ui-toggle ${checked ? 'ui-toggle--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-toggle__track" aria-hidden="true">
        <span className="ui-toggle__thumb" />
      </span>
      {!hideLabel && <span className="ui-toggle__label">{label}</span>}
    </button>
  );
}
