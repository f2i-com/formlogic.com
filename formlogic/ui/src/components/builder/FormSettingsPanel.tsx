import { useState, useEffect, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { X, Settings, Layout, Bell, Shield, Link2, Zap } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import { WebhookManager } from './WebhookManager';
import { EncryptionSettings } from './EncryptionSettings';
import { DataPlacementCard } from './DataPlacementCard';
import { normalizeFormSettings, type FormSettings } from '../../types/form';

interface FormSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: FormSettings;
  onSave: (settings: FormSettings) => void;
  formId?: string;
  /** E2EE: whether the form is already end-to-end encrypted (read-only status then). */
  isPrivate?: boolean;
  /** E2EE: fired after a successful one-way enable so the builder refreshes its badge. */
  onEncryptionEnabled?: () => void;
}

type SettingsTab = 'presentation' | 'behavior' | 'notifications' | 'access' | 'webhooks';

export function FormSettingsModal({ isOpen, onClose, settings, onSave, formId, isPrivate, onEncryptionEnabled }: FormSettingsModalProps) {
  const [editedSettings, setEditedSettings] = useState<FormSettings>(() => normalizeFormSettings(settings));
  const [activeTab, setActiveTab] = useState<SettingsTab>('presentation');

  // Re-seed the edit buffer every time the modal opens so it reflects the CURRENT
  // form.settings (the modal stays mounted, so without this it keeps stale
  // first-mount values and Save would clobber e.g. a version-restored settings).
  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- re-seed draft from prop when modal opens; must run on open to avoid stale buffer
      setEditedSettings(normalizeFormSettings(settings));
      setActiveTab('presentation');
    }
  }, [isOpen, settings]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isOpen);

  if (!isOpen) return null;

  const updateSettings = (updates: Partial<FormSettings>) => {
    setEditedSettings((prev) => ({ ...prev, ...updates }));
  };

  const handleSave = () => {
    onSave(editedSettings);
    toast.success('Settings saved', 'Form settings have been updated');
    onClose();
  };

  const tabs = [
    { id: 'presentation' as const, label: 'Presentation', icon: <Layout className="h-4 w-4" /> },
    { id: 'behavior' as const, label: 'Behavior', icon: <Settings className="h-4 w-4" /> },
    { id: 'notifications' as const, label: 'Notifications', icon: <Bell className="h-4 w-4" /> },
    { id: 'access' as const, label: 'Access', icon: <Shield className="h-4 w-4" /> },
    ...(formId ? [{ id: 'webhooks' as const, label: 'Webhooks', icon: <Zap className="h-4 w-4" /> }] : []),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="form-settings-title" className="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col border border-gray-200 dark:border-slate-800 focus:outline-none" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-slate-800 bg-gradient-to-r from-gray-50 to-slate-50 dark:from-slate-900 dark:to-slate-800/50">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-gradient-to-br from-primary-500 to-primary-600 rounded-xl flex items-center justify-center shadow-sm">
              <Settings className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h2 id="form-settings-title" className="text-lg font-semibold text-gray-900 dark:text-white">Form settings</h2>
              <p className="text-sm text-gray-500 dark:text-slate-400">Configure how your form behaves</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 min-h-11 min-w-11 inline-flex items-center justify-center hover:bg-gray-200/70 dark:hover:bg-slate-800 rounded-lg motion-safe:transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            aria-label="Close"
            title="Close"
          >
            <X className="h-5 w-5 text-gray-500 dark:text-slate-400" />
          </button>
        </div>

        {/* Tabs. Below 640px the labels are hidden, so without an accessible name these
            became five anonymous icons — "button" five times to a screen reader, and no
            tooltip for anyone else. The name always ships; only its VISIBILITY is
            responsive. Marked up as a real tablist so the five panels are announced as
            one set rather than five loose buttons. */}
        <div role="tablist" aria-label="Form settings sections" className="flex border-b border-gray-200 dark:border-slate-800 px-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-label={tab.label}
              title={tab.label}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex min-h-11 items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 motion-safe:transition-colors -mb-px cursor-pointer rounded-t-md focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500',
                activeTab === tab.id
                  ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                  : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
              )}
            >
              {tab.icon}
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        {/* Fixed-height body so switching tabs doesn't resize the dialog (the vh cap
            keeps the header/footer visible on short viewports). */}
        <div className="h-[460px] max-h-[60vh] overflow-y-auto p-6">
          {/* Presentation Tab */}
          {activeTab === 'presentation' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">Form layout</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Presentation mode</label>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { value: 'focused', label: 'Focused', desc: 'One question at a time' },
                        { value: 'classic', label: 'Classic', desc: 'All questions visible' },
                        { value: 'both', label: 'Both', desc: 'User can switch' },
                      ].map((mode) => (
                        <button
                          key={mode.value}
                          type="button"
                          onClick={() => updateSettings({ presentationMode: mode.value as FormSettings['presentationMode'] })}
                          className={cn(
                            'p-3 rounded-lg border-2 text-left motion-safe:transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                            editedSettings.presentationMode === mode.value
                              ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10'
                              : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
                          )}
                        >
                          <p className="font-medium text-gray-900 dark:text-white text-sm">{mode.label}</p>
                          <p className="text-xs text-gray-500 dark:text-slate-400">{mode.desc}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  {editedSettings.presentationMode === 'both' && (
                    <div>
                      <label className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Default mode</label>
                      <select
                        value={editedSettings.defaultPresentationMode}
                        onChange={(e) => updateSettings({ defaultPresentationMode: e.target.value as 'focused' | 'classic' })}
                        className="w-full px-3 py-2.5 border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 hover:border-gray-400 dark:hover:border-slate-600 text-gray-900 dark:text-white text-sm motion-safe:transition-all duration-150 ease-in-out appearance-none cursor-pointer"
                      >
                        <option value="focused">Focused (one at a time)</option>
                        <option value="classic">Classic (scrollable)</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>

              <div className="border-t border-gray-200 dark:border-slate-800 pt-6">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">Navigation</h3>
                <div className="space-y-4">
                  <Switch
                    checked={editedSettings.showProgressBar}
                    onChange={(checked) => updateSettings({ showProgressBar: checked })}
                    label="Show progress bar"
                    description="Display completion progress to respondents"
                  />
                  <Switch
                    checked={editedSettings.allowBackNavigation}
                    onChange={(checked) => updateSettings({ allowBackNavigation: checked })}
                    label="Allow back navigation"
                    description="Let users go back to previous questions"
                  />
                </div>
              </div>

              <div className="border-t border-gray-200 dark:border-slate-800 pt-6">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">Submit button</h3>
                <Input
                  label="Button text"
                  value={editedSettings.submitButtonText}
                  onChange={(e) => updateSettings({ submitButtonText: e.target.value })}
                  placeholder="Submit"
                />
              </div>

              <div className="border-t border-gray-200 dark:border-slate-800 pt-6">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">Review dashboard</h3>
                <Switch
                  checked={editedSettings.showNigoDashboard === true}
                  onChange={(checked) => updateSettings({ showNigoDashboard: checked })}
                  label="Show NIGO dashboard"
                  description="Display a Not-In-Good-Order checklist summarizing missing required fields"
                />
              </div>
            </div>
          )}

          {/* Behavior Tab */}
          {activeTab === 'behavior' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">After submission</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-slate-400 mb-2">
                      <div className="flex items-center gap-2">
                        <Link2 className="h-4 w-4" />
                        Redirect URL (optional)
                      </div>
                    </label>
                    <Input
                      value={editedSettings.redirectUrl || ''}
                      onChange={(e) => updateSettings({ redirectUrl: e.target.value || undefined })}
                      placeholder="https://example.com/thank-you"
                    />
                    <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                      Leave empty to show the default thank you screen
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-200 dark:border-slate-800 pt-6">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">Response limits</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Response quota (optional)</label>
                    <Input
                      type="number"
                      min={1}
                      value={editedSettings.quotaLimit || ''}
                      onChange={(e) => {
                        if (!e.target.value) { updateSettings({ quotaLimit: undefined }); return; }
                        const val = parseInt(e.target.value);
                        updateSettings({ quotaLimit: isNaN(val) ? undefined : Math.max(1, val) });
                      }}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                      Maximum number of responses to accept
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Notifications Tab */}
          {activeTab === 'notifications' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">Email notifications</h3>
                <div className="space-y-4">
                  <Switch
                    checked={editedSettings.notifications.emailNotifications}
                    onChange={(checked) => updateSettings({
                      notifications: { ...editedSettings.notifications, emailNotifications: checked }
                    })}
                    label="Send email on new response"
                    description="Receive an email whenever someone submits the form"
                  />

                  {editedSettings.notifications.emailNotifications && (
                    <Input
                      label="Notification email"
                      type="email"
                      value={editedSettings.notifications.notificationEmail || ''}
                      onChange={(e) => updateSettings({
                        notifications: { ...editedSettings.notifications, notificationEmail: e.target.value }
                      })}
                      placeholder="your@email.com"
                    />
                  )}
                </div>
              </div>

              <div className="bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 rounded-lg p-4">
                <p className="text-sm text-blue-700 dark:text-blue-400">
                  Email notifications require a backend email service to be configured.
                </p>
              </div>
            </div>
          )}

          {/* Access Tab */}
          {activeTab === 'access' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">Form availability</h3>
                <div className="space-y-4">
                  <Switch
                    checked={editedSettings.isClosed}
                    onChange={(checked) => updateSettings({ isClosed: checked })}
                    label="Close form"
                    description="Stop accepting new responses"
                  />

                  <Switch
                    checked={editedSettings.singleRecord === true}
                    onChange={(checked) => updateSettings({ singleRecord: checked || undefined })}
                    label="Single record (settings-style)"
                    description="The form holds one record that members edit in place — opening it in an app jumps straight to editing instead of a blank form"
                  />

                  {editedSettings.isClosed && (
                    <div>
                      <label className="block text-sm text-gray-600 dark:text-slate-400 mb-2">Closed message</label>
                      <textarea
                        value={editedSettings.closedMessage || ''}
                        onChange={(e) => updateSettings({ closedMessage: e.target.value })}
                        placeholder="This form is no longer accepting responses."
                        className="w-full px-3 py-2.5 border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900/50 text-gray-900 dark:text-white placeholder:text-gray-500 dark:placeholder:text-slate-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 hover:border-gray-400 dark:hover:border-slate-600 motion-safe:transition-all duration-150 ease-in-out min-h-[80px]"
                      />
                    </div>
                  )}
                </div>
              </div>

              {editedSettings.isClosed && (
                <div className="bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200 dark:border-yellow-500/20 rounded-lg p-4">
                  <p className="text-sm text-yellow-700 dark:text-yellow-400">
                    When closed, visitors will see the closed message instead of the form.
                  </p>
                </div>
              )}

              {/* E2EE: one-way "Encrypt this form" action (private mode is irreversible),
                  or read-only status when already private. Owner + cloud forms only —
                  the builder passes isPrivate only in that context. */}
              {formId && isPrivate !== undefined && (
                <div className="border-t border-gray-200 dark:border-slate-800 pt-6">
                  <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3">End-to-end encryption</h3>
                  <EncryptionSettings
                    formId={formId}
                    isPrivate={isPrivate}
                    onEnabled={() => onEncryptionEnabled?.()}
                  />
                  {/* Data-node placement (owner-signed storage baseline) — Private forms only;
                      hides itself while the DATA_NODES flag is off. */}
                  {isPrivate && <DataPlacementCard formId={formId} />}
                </div>
              )}
            </div>
          )}

          {/* Webhooks Tab */}
          {activeTab === 'webhooks' && formId && (
            <WebhookManager formId={formId} />
          )}

        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            Save settings
          </Button>
        </div>
      </div>
    </div>
  );
}
