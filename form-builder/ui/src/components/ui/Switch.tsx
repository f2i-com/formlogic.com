import { cn } from '../../lib/utils';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  size = 'md',
}: SwitchProps) {
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

  return (
    <label
      className={cn(
        'flex items-start gap-3 cursor-pointer select-none',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={cn(
          'relative inline-flex shrink-0 rounded-full transition-all duration-200',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2',
          sizes[size].track,
          checked
            ? 'bg-primary-600 shadow-inner'
            : 'bg-gray-300 hover:bg-gray-400'
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
        <div className="flex flex-col pt-0.5">
          {label && (
            <span className="text-sm font-medium text-gray-900 leading-tight">{label}</span>
          )}
          {description && (
            <span className="text-sm text-gray-500 leading-snug mt-0.5">{description}</span>
          )}
        </div>
      )}
    </label>
  );
}
