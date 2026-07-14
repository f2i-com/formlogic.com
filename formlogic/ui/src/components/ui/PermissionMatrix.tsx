import { useEffect, useRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';
import type { PermissionAction } from '../../types/app';
import { APP_PERMISSION_LABELS, APP_LEVEL_PERMISSIONS, FORM_LEVEL_PERMISSIONS } from '../../types/app';

/** Checkbox that supports the native indeterminate ("mixed") state for check-all toggles. */
function TriStateCheckbox({ indeterminate, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !props.checked;
  }, [indeterminate, props.checked]);
  return <input ref={ref} type="checkbox" className={className} {...props} />;
}

interface PermissionMatrixProps {
  permissions: Array<{ formId: string | null; permission: PermissionAction }>;
  forms: Array<{ formId: string; displayName: string }>;
  onChange: (permissions: Array<{ formId: string | null; permission: PermissionAction }>) => void;
  disabled?: boolean;
  /** Disable only the app-level (not per-form) toggles — e.g. for non-owners,
      whose app-level grants the backend rejects. */
  appLevelDisabled?: boolean;
}

export function PermissionMatrix({ permissions, forms, onChange, disabled = false, appLevelDisabled = false }: PermissionMatrixProps) {
  const hasPermission = (formId: string | null, permission: PermissionAction): boolean => {
    return permissions.some((p) => p.formId === formId && p.permission === permission);
  };

  const togglePermission = (formId: string | null, permission: PermissionAction) => {
    if (disabled) return;
    const exists = hasPermission(formId, permission);
    if (exists) {
      onChange(permissions.filter((p) => !(p.formId === formId && p.permission === permission)));
    } else {
      onChange([...permissions, { formId, permission }]);
    }
  };

  // Grant or revoke a batch of (formId, permission) pairs in ONE onChange call,
  // preserving the existing contract (a single full-array update).
  const setMany = (targets: Array<{ formId: string | null; permission: PermissionAction }>, on: boolean) => {
    if (disabled) return;
    if (on) {
      const next = [...permissions];
      for (const t of targets) {
        if (!next.some((p) => p.formId === t.formId && p.permission === t.permission)) next.push(t);
      }
      onChange(next);
    } else {
      onChange(permissions.filter((p) => !targets.some((t) => t.formId === p.formId && t.permission === p.permission)));
    }
  };

  const columnState = (perm: PermissionAction) => {
    const count = forms.filter((f) => hasPermission(f.formId, perm)).length;
    return { all: forms.length > 0 && count === forms.length, some: count > 0 };
  };

  const rowState = (formId: string) => {
    const count = FORM_LEVEL_PERMISSIONS.filter((perm) => hasPermission(formId, perm)).length;
    return { all: count === FORM_LEVEL_PERMISSIONS.length, some: count > 0 };
  };

  const checkboxClass =
    'h-4 w-4 rounded border-gray-300 dark:border-slate-600 text-primary-600 accent-primary-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-900 cursor-pointer disabled:cursor-not-allowed';

  return (
    <div className="space-y-6">
      {/* App-level permissions */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-3">
          App-level permissions
          {appLevelDisabled && <span className="ml-2 text-xs font-normal text-gray-400 dark:text-slate-500">(Owner only)</span>}
        </h4>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {APP_LEVEL_PERMISSIONS.map((perm) => (
            <label
              key={perm}
              className={cn(
                'flex items-center gap-2 p-2.5 rounded-xl border border-gray-200/80 dark:border-slate-700/60 text-sm transition-all duration-200',
                !disabled && !appLevelDisabled && 'cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800',
                appLevelDisabled && 'opacity-60',
                hasPermission(null, perm) && 'bg-primary-50 dark:bg-primary-500/10 border-primary-300 dark:border-primary-500/30'
              )}
            >
              <input
                type="checkbox"
                checked={hasPermission(null, perm)}
                onChange={() => { if (!appLevelDisabled) togglePermission(null, perm); }}
                disabled={disabled || appLevelDisabled}
                aria-label={APP_PERMISSION_LABELS[perm]}
                className="rounded border-gray-300 text-primary-600 accent-primary-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-900"
              />
              <span className="text-gray-700 dark:text-slate-300">{APP_PERMISSION_LABELS[perm]}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Per-form permissions matrix */}
      {forms.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-3">Per-form permissions</h4>
          <div className="overflow-x-auto rounded-xl border border-gray-200/80 dark:border-slate-700/60">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50/80 dark:bg-slate-800/80 border-b border-gray-200/80 dark:border-slate-700/60">
                  <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-slate-400">Form</th>
                  {FORM_LEVEL_PERMISSIONS.map((perm) => {
                    const col = columnState(perm);
                    return (
                      <th key={perm} title={APP_PERMISSION_LABELS[perm]} className="px-3 py-2 text-center font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap text-xs">
                        <span className="block">{APP_PERMISSION_LABELS[perm].replace(/\s*responses\s*/i, ' ').trim() || APP_PERMISSION_LABELS[perm]}</span>
                        <TriStateCheckbox
                          checked={col.all}
                          indeterminate={col.some && !col.all}
                          onChange={() => setMany(forms.map((f) => ({ formId: f.formId, permission: perm })), !col.all)}
                          disabled={disabled}
                          aria-label={`${APP_PERMISSION_LABELS[perm]} for all forms`}
                          title={`${APP_PERMISSION_LABELS[perm]} — toggle for all forms`}
                          className={cn(checkboxClass, 'mt-1.5')}
                        />
                      </th>
                    );
                  })}
                  <th className="px-3 py-2 text-center font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap text-xs" title="All permissions for this form">
                    All
                  </th>
                </tr>
              </thead>
              <tbody>
                {forms.map((form) => {
                  const row = rowState(form.formId);
                  return (
                    <tr key={form.formId} className="border-b border-gray-100 dark:border-slate-700/40 last:border-b-0">
                      <td className="px-4 py-2 text-gray-900 dark:text-slate-200 font-medium">{form.displayName}</td>
                      {FORM_LEVEL_PERMISSIONS.map((perm) => (
                        <td key={perm} className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={hasPermission(form.formId, perm)}
                            onChange={() => togglePermission(form.formId, perm)}
                            disabled={disabled}
                            aria-label={`${APP_PERMISSION_LABELS[perm]} for ${form.displayName}`}
                            className={checkboxClass}
                          />
                        </td>
                      ))}
                      <td className="px-3 py-2 text-center">
                        <TriStateCheckbox
                          checked={row.all}
                          indeterminate={row.some && !row.all}
                          onChange={() => setMany(FORM_LEVEL_PERMISSIONS.map((permission) => ({ formId: form.formId, permission })), !row.all)}
                          disabled={disabled}
                          aria-label={`All permissions for ${form.displayName}`}
                          title={`Toggle all permissions for ${form.displayName}`}
                          className={checkboxClass}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
