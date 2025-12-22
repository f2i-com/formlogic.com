import { useState } from 'react';
import { X, Settings, Layout, Bell, Shield, Link2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import type { FormSettings } from '../../types/form';

interface FormSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: FormSettings;
  onSave: (settings: FormSettings) => void;
}

type SettingsTab = 'presentation' | 'behavior' | 'notifications' | 'access';

export function FormSettingsModal({ isOpen, onClose, settings, onSave }: FormSettingsModalProps) {
  const [editedSettings, setEditedSettings] = useState<FormSettings>(settings);
  const [activeTab, setActiveTab] = useState<SettingsTab>('presentation');

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
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <Settings className="h-5 w-5 text-primary-600" />
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Form Settings</h2>
              <p className="text-sm text-gray-500">Configure how your form behaves</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors -mb-px',
                activeTab === tab.id
                  ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              )}
            >
              {tab.icon}
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Presentation Tab */}
          {activeTab === 'presentation' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-medium text-gray-900 mb-3">Form Layout</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-600 mb-2">Presentation Mode</label>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { value: 'focused', label: 'Focused', desc: 'One question at a time' },
                        { value: 'classic', label: 'Classic', desc: 'All questions visible' },
                        { value: 'both', label: 'Both', desc: 'User can switch' },
                      ].map((mode) => (
                        <button
                          key={mode.value}
                          onClick={() => updateSettings({ presentationMode: mode.value as FormSettings['presentationMode'] })}
                          className={cn(
                            'p-3 rounded-lg border-2 text-left transition-all',
                            editedSettings.presentationMode === mode.value
                              ? 'border-primary-500 bg-primary-50'
                              : 'border-gray-200 hover:border-gray-300'
                          )}
                        >
                          <p className="font-medium text-gray-900 text-sm">{mode.label}</p>
                          <p className="text-xs text-gray-500">{mode.desc}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  {editedSettings.presentationMode === 'both' && (
                    <div>
                      <label className="block text-sm text-gray-600 mb-2">Default Mode</label>
                      <select
                        value={editedSettings.defaultPresentationMode}
                        onChange={(e) => updateSettings({ defaultPresentationMode: e.target.value as 'focused' | 'classic' })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      >
                        <option value="focused">Focused (One at a time)</option>
                        <option value="classic">Classic (Scrollable)</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>

              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-sm font-medium text-gray-900 mb-3">Navigation</h3>
                <div className="space-y-4">
                  <Switch
                    checked={editedSettings.showProgressBar}
                    onChange={(checked) => updateSettings({ showProgressBar: checked })}
                    label="Show Progress Bar"
                    description="Display completion progress to respondents"
                  />
                  <Switch
                    checked={editedSettings.allowBackNavigation}
                    onChange={(checked) => updateSettings({ allowBackNavigation: checked })}
                    label="Allow Back Navigation"
                    description="Let users go back to previous questions"
                  />
                </div>
              </div>

              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-sm font-medium text-gray-900 mb-3">Submit Button</h3>
                <Input
                  label="Button Text"
                  value={editedSettings.submitButtonText}
                  onChange={(e) => updateSettings({ submitButtonText: e.target.value })}
                  placeholder="Submit"
                />
              </div>
            </div>
          )}

          {/* Behavior Tab */}
          {activeTab === 'behavior' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-medium text-gray-900 mb-3">After Submission</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-600 mb-2">
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
                    <p className="text-xs text-gray-500 mt-1">
                      Leave empty to show the default thank you screen
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-sm font-medium text-gray-900 mb-3">Response Limits</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-600 mb-2">Response Quota (optional)</label>
                    <Input
                      type="number"
                      min={0}
                      value={editedSettings.quotaLimit || ''}
                      onChange={(e) => updateSettings({ quotaLimit: e.target.value ? parseInt(e.target.value) : undefined })}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-gray-500 mt-1">
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
                <h3 className="text-sm font-medium text-gray-900 mb-3">Email Notifications</h3>
                <div className="space-y-4">
                  <Switch
                    checked={editedSettings.notifications.emailNotifications}
                    onChange={(checked) => updateSettings({
                      notifications: { ...editedSettings.notifications, emailNotifications: checked }
                    })}
                    label="Send Email on New Response"
                    description="Receive an email whenever someone submits the form"
                  />

                  {editedSettings.notifications.emailNotifications && (
                    <Input
                      label="Notification Email"
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

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-sm text-blue-700">
                  Email notifications require a backend email service to be configured.
                </p>
              </div>
            </div>
          )}

          {/* Access Tab */}
          {activeTab === 'access' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-medium text-gray-900 mb-3">Form Availability</h3>
                <div className="space-y-4">
                  <Switch
                    checked={editedSettings.isClosed}
                    onChange={(checked) => updateSettings({ isClosed: checked })}
                    label="Close Form"
                    description="Stop accepting new responses"
                  />

                  {editedSettings.isClosed && (
                    <div>
                      <label className="block text-sm text-gray-600 mb-2">Closed Message</label>
                      <textarea
                        value={editedSettings.closedMessage || ''}
                        onChange={(e) => updateSettings({ closedMessage: e.target.value })}
                        placeholder="This form is no longer accepting responses."
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 min-h-[80px]"
                      />
                    </div>
                  )}
                </div>
              </div>

              {editedSettings.isClosed && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <p className="text-sm text-yellow-700">
                    When closed, visitors will see the closed message instead of the form.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            Save Settings
          </Button>
        </div>
      </div>
    </div>
  );
}
