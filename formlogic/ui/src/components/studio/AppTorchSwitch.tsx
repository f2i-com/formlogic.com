import { useState } from 'react';
import type { OwnerEnginePolicy } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import { toast } from '../../stores/toastStore';
import { Switch } from '../ui/Switch';

/**
 * Whether this app's Python may use torch (settings.torch; absent = on). torch runs in each
 * visitor's browser, on their device, never on this server; the site's administrator can turn it
 * off for every app (the engine policy), and then this switch says so and cannot turn it on. The
 * server enforces both: a version that declares torch where it is off is refused, and an app
 * already installed with it is not served.
 */
export function AppTorchSwitch({ appId, policy, disabled }: { appId: string; policy: OwnerEnginePolicy | undefined; disabled?: boolean }) {
  const app = useAppStore(s => s.apps.find(candidate => candidate.id === appId));
  const updateApp = useAppStore(s => s.updateApp);
  const [saving, setSaving] = useState(false);
  if (!app || !policy) return null;
  const siteAllows = policy.torch !== false;
  const change = async (checked: boolean) => {
    setSaving(true);
    try {
      if (await updateApp(app.id, { settings: { ...app.settings, torch: checked } })) {
        toast.success(checked ? 'torch allowed' : 'torch turned off', checked ? 'This app’s Python may use torch.' : 'A version of this app that uses torch will be refused.');
      }
    } finally { setSaving(false); }
  };
  return <Switch
    label="Allow torch (machine learning)"
    description={siteAllows
      ? 'Python in this app may use torch. It runs in each visitor’s browser, on their device, not on this server. Off: a version that uses it is refused.'
      : 'This site does not allow torch, so this app cannot use it. Ask the site administrator.'}
    checked={siteAllows && app.settings?.torch !== false}
    disabled={disabled || saving || !siteAllows}
    onChange={checked => void change(checked)}
  />;
}
