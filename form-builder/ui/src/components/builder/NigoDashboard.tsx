import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
} from 'lucide-react';
import type { FormField } from '../../types/form';
import {
  useNigoDashboard,
} from '../../hooks/useNigoDashboard';
import type {
  FieldStatus,
  NigoFieldState,
} from '../../hooks/useNigoDashboard';

interface NigoDashboardProps {
  fields: FormField[];
  formData: Record<string, unknown>;
  visibleFields: string[] | Set<string>;
  requiredFields: string[] | Set<string>;
  onFieldClick?: (fieldId: string) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

const STATUS_DOT_COLORS: Record<FieldStatus, string> = {
  red: 'bg-red-500',
  yellow: 'bg-yellow-500',
  green: 'bg-green-500',
};

const PROGRESS_BAR_COLORS: Record<string, string> = {
  low: '#ef4444',    // red-500
  mid: '#eab308',    // yellow-500
  high: '#22c55e',   // green-500
};

function getProgressBarColor(score: number): string {
  if (score < 50) return PROGRESS_BAR_COLORS.low;
  if (score < 80) return PROGRESS_BAR_COLORS.mid;
  return PROGRESS_BAR_COLORS.high;
}

function OverallStatusBadge({ status }: { status: FieldStatus }) {
  if (status === 'green') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
        <CheckCircle className="w-3 h-3" />
        Good
      </span>
    );
  }
  if (status === 'yellow') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 dark:bg-yellow-900/30 px-2 py-0.5 text-xs font-medium text-yellow-700 dark:text-yellow-400">
        <AlertTriangle className="w-3 h-3" />
        Review
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
      <AlertCircle className="w-3 h-3" />
      Incomplete
    </span>
  );
}

function FieldRow({
  field,
  onClick,
}: {
  field: NigoFieldState;
  onClick?: (fieldId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick?.(field.fieldId)}
      className="w-full flex items-start gap-2 px-3 py-2 text-left rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
    >
      <span
        className={`mt-1.5 w-2.5 h-2.5 rounded-full flex-shrink-0 ${STATUS_DOT_COLORS[field.status]}`}
        aria-hidden="true"
      />
      <span className="sr-only">
        {field.status === 'green' ? 'Complete' : field.status === 'yellow' ? 'Needs review' : 'Incomplete'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {field.label}
          {field.required && (
            <span className="ml-1 text-red-400 dark:text-red-500">*</span>
          )}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
          {field.message}
        </p>
      </div>
    </button>
  );
}

export function NigoDashboard({
  fields,
  formData,
  visibleFields,
  requiredFields,
  onFieldClick,
  collapsed: controlledCollapsed,
  onToggleCollapsed,
}: NigoDashboardProps) {
  const dashboard = useNigoDashboard(fields, formData, visibleFields, requiredFields);
  const [internalCollapsed, setInternalCollapsed] = useState(false);

  const isControlled = controlledCollapsed !== undefined;
  const isCollapsed = controlledCollapsed ?? internalCollapsed;

  const handleToggle = () => {
    if (isControlled && onToggleCollapsed) {
      onToggleCollapsed();
    } else {
      setInternalCollapsed((prev) => !prev);
    }
  };

  const progressColor = getProgressBarColor(dashboard.score);

  return (
    <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-xl shadow-lg overflow-hidden flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-slate-800">
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              NIGO Dashboard
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Completion: {dashboard.completedCount}/{dashboard.totalCount}
            </p>
          </div>
          <OverallStatusBadge status={dashboard.overallStatus} />
        </div>
        <button
          type="button"
          onClick={handleToggle}
          className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          aria-label={isCollapsed ? 'Expand dashboard' : 'Collapse dashboard'}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronUp className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Progress Bar (hidden when collapsed) */}
      {!isCollapsed && <div className="px-4 py-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
            {dashboard.score}% complete
          </span>
          {dashboard.isValidating && (
            <span className="text-xs text-gray-400 dark:text-gray-500 italic">
              Validating...
            </span>
          )}
        </div>
        <div className="w-full h-2 bg-gray-100 dark:bg-slate-800 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500 ease-out"
            style={{
              width: `${dashboard.score}%`,
              backgroundColor: progressColor,
            }}
          />
        </div>
      </div>}

      {/* Field List (hidden when collapsed). flex-1 so it fills whatever height the (capped) panel has and
          scrolls internally — the callers bound the panel's max-height to the viewport, so the whole panel
          always fits and only this list scrolls. */}
      {!isCollapsed && (
        <div className="flex-1 min-h-0 overflow-y-auto px-1 pb-2">
          {dashboard.fields.length === 0 ? (
            <p className="px-4 py-3 text-sm text-gray-400 dark:text-gray-500 text-center">
              No fields to evaluate
            </p>
          ) : (
            dashboard.fields.map((field) => (
              <FieldRow
                key={field.fieldId}
                field={field}
                onClick={onFieldClick}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
