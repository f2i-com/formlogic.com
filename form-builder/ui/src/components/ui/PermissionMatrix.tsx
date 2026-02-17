import { cn } from '../../lib/utils';
import type { PermissionAction } from '../../types/app';
import { APP_PERMISSION_LABELS, APP_LEVEL_PERMISSIONS, FORM_LEVEL_PERMISSIONS } from '../../types/app';

interface PermissionMatrixProps {
  permissions: Array<{ formId: string | null; permission: PermissionAction }>;
  forms: Array<{ formId: string; displayName: string }>;
  onChange: (permissions: Array<{ formId: string | null; permission: PermissionAction }>) => void;
  disabled?: boolean;
}

export function PermissionMatrix({ permissions, forms, onChange, disabled = false }: PermissionMatrixProps) {
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

  return (
    <div className="space-y-6">
      {/* App-level permissions */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-3">App-Level Permissions</h4>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {APP_LEVEL_PERMISSIONS.map((perm) => (
            <label
              key={perm}
              className={cn(
                'flex items-center gap-2 p-2 rounded-lg border border-gray-200 dark:border-slate-700 text-sm',
                !disabled && 'cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800',
                hasPermission(null, perm) && 'bg-primary-50 dark:bg-primary-500/10 border-primary-300 dark:border-primary-500/30'
              )}
            >
              <input
                type="checkbox"
                checked={hasPermission(null, perm)}
                onChange={() => togglePermission(null, perm)}
                disabled={disabled}
                aria-label={APP_PERMISSION_LABELS[perm]}
                className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              />
              <span className="text-gray-700 dark:text-slate-300">{APP_PERMISSION_LABELS[perm]}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Per-form permissions matrix */}
      {forms.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-3">Per-Form Permissions</h4>
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700">
                  <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-slate-400">Form</th>
                  {FORM_LEVEL_PERMISSIONS.map((perm) => (
                    <th key={perm} className="px-3 py-2 text-center font-medium text-gray-600 dark:text-slate-400 whitespace-nowrap text-xs">
                      {APP_PERMISSION_LABELS[perm].replace('Responses', '').trim()}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {forms.map((form) => (
                  <tr key={form.formId} className="border-b border-gray-100 dark:border-slate-700/50">
                    <td className="px-4 py-2 text-gray-900 dark:text-slate-200 font-medium">{form.displayName}</td>
                    {FORM_LEVEL_PERMISSIONS.map((perm) => (
                      <td key={perm} className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={hasPermission(form.formId, perm)}
                          onChange={() => togglePermission(form.formId, perm)}
                          disabled={disabled}
                          aria-label={`${APP_PERMISSION_LABELS[perm]} for ${form.displayName}`}
                          className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
