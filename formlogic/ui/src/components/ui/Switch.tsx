import { useId } from 'react';
import { cn } from '../../lib/utils';

// Every switch MUST have an accessible name (audit FL-27): either the visible
// `label` or an explicit `ariaLabel` — the union makes a nameless toggle a type
// error instead of a silent screen-reader gap.
type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
} & (
  | { label: string; ariaLabel?: string }
  | { label?: undefined; ariaLabel: string }
);

export function Switch({
  checked,
  onChange,
  label,
  ariaLabel,
  description,
  disabled,
  size = 'md',
}: SwitchProps) {
  // A native <label> only associates with form controls, never a <button>, so the
  // old markup left the toggle nameless to screen readers and the text non-clickable.
  // Use a plain container, wire the button's accessible name via aria-labelledby/
  // describedby, and let the text toggle it too.
  const id = useId();
  const labelId = `${id}-label`;
  const descId = `${id}-desc`;

  const sizes = {
    sm: {
      track: 'w-8 h-[18px]',
      thumb: 'h-3.5 w-3.5',
      translate: 'translate-x-[14px]',
    },
    md: {
      track: 'w-11 h-6',
      thumb: 'h-5 w-5',
      translate: 'translate-x-5',
    },
  };

  const toggle = () => {
    if (!disabled) onChange(!checked);
  };

  return (
    <div className={cn('flex items-start gap-3 select-none', disabled && 'opacity-50')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={label ? labelId : undefined}
        aria-label={!label ? ariaLabel : undefined}
        aria-describedby={description ? descId : undefined}
        disabled={disabled}
        onClick={toggle}
        className={cn(
          'relative inline-flex shrink-0 rounded-full transition-all duration-200',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
          // The track is only ~24px tall. Rather than distort the control, extend its
          // touch area vertically with a pseudo-element — a 44px tap target on phones
          // with no layout shift and no change to how the switch looks.
          "max-sm:before:absolute max-sm:before:-inset-y-2.5 max-sm:before:inset-x-0 max-sm:before:content-['']",
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
          sizes[size].track,
          checked
            ? 'bg-primary-600 shadow-inner'
            : 'bg-gray-300 dark:bg-slate-600 hover:bg-gray-400 dark:hover:bg-slate-500'
        )}
      >
        <span
          className={cn(
            'pointer-events-none inline-block rounded-full bg-white',
            'shadow-md ring-1 ring-black/5',
            'transform transition-transform duration-200 ease-out',
            sizes[size].thumb,
            'translate-x-0.5 translate-y-0.5',
            checked && sizes[size].translate
          )}
        />
      </button>
      {(label || description) && (
        <div
          className={cn('min-w-0 flex-1 flex flex-col pt-0.5', !disabled && 'cursor-pointer')}
          onClick={toggle}
        >
          {label && (
            <span id={labelId} className="text-sm font-medium text-gray-900 dark:text-white leading-tight">{label}</span>
          )}
          {description && (
            <span id={descId} className="text-sm text-gray-500 dark:text-slate-400 leading-snug mt-0.5">{description}</span>
          )}
        </div>
      )}
    </div>
  );
}
