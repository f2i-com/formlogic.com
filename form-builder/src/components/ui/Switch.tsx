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
      track: 'w-8 h-4',
      thumb: 'h-3 w-3',
      translate: 'translate-x-4',
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
        'flex items-start gap-3 cursor-pointer',
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
          'relative inline-flex shrink-0 rounded-full transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2',
          sizes[size].track,
          checked ? 'bg-primary-600' : 'bg-gray-200'
        )}
      >
        <span
          className={cn(
            'pointer-events-none inline-block rounded-full bg-white shadow-sm',
            'transform transition-transform',
            sizes[size].thumb,
            'translate-x-0.5 translate-y-0.5',
            checked && sizes[size].translate
          )}
        />
      </button>
      {(label || description) && (
        <div className="flex flex-col">
          {label && (
            <span className="text-sm font-medium text-gray-900">{label}</span>
          )}
          {description && (
            <span className="text-sm text-gray-500">{description}</span>
          )}
        </div>
      )}
    </label>
  );
}
