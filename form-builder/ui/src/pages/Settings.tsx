import { useState, useEffect } from 'react';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Switch } from '../components/ui/Switch';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/toastStore';
import {
  User,
  Bell,
  Settings2,
  Mail,
  Calendar,
  LayoutGrid,
  ArrowLeft,
  Shield,
  Palette,
  Check,
  Lock,
} from 'lucide-react';
import { useUIStore } from '../stores/uiStore';

// Local preferences stored in localStorage
interface UserPreferences {
  emailNotifications: boolean;
  weeklyDigest: boolean;
  showProgressBar: boolean;
  allowBackNavigation: boolean;
}

const DEFAULT_PREFERENCES: UserPreferences = {
  emailNotifications: true,
  weeklyDigest: false,
  showProgressBar: true,
  allowBackNavigation: true,
};

function getStoredPreferences(): UserPreferences {
  try {
    const stored = localStorage.getItem('formlogic_user_preferences');
    if (stored) {
      return { ...DEFAULT_PREFERENCES, ...JSON.parse(stored) };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_PREFERENCES;
}

function savePreferences(prefs: UserPreferences): void {
  localStorage.setItem('formlogic_user_preferences', JSON.stringify(prefs));
}

// Section Header Component
function SectionHeader({
  icon: Icon,
  title,
  description,
  iconBg = 'bg-gray-100 dark:bg-slate-800',
  iconColor = 'text-gray-500 dark:text-slate-400',
}: {
  icon: React.ElementType;
  title: string;
  description?: string;
  iconBg?: string;
  iconColor?: string;
}) {
  return (
    <div className="flex items-start gap-4 mb-6">
      <div className={`p-2.5 rounded-lg ${iconBg}`}>
        <Icon className={`h-5 w-5 ${iconColor}`} />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
        {description && (
          <p className="text-sm text-gray-500 dark:text-slate-500 mt-0.5">{description}</p>
        )}
      </div>
    </div>
  );
}

export function Settings() {
  const user = useAuthStore((state) => state.user);
  const updateProfile = useAuthStore((state) => state.updateProfile);
  const isLoading = useAuthStore((state) => state.isLoading);

  // Profile form state
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [hasProfileChanges, setHasProfileChanges] = useState(false);

  // Theme
  const themeColor = useUIStore((state) => state.themeColor);

  // Preferences state
  const [preferences, setPreferences] = useState<UserPreferences>(getStoredPreferences);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  // Update form when user changes
  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setEmail(user.email || '');
    }
  }, [user]);

  // Track profile changes
  useEffect(() => {
    const nameChanged = name !== (user?.name || '');
    const emailChanged = email !== (user?.email || '');
    setHasProfileChanges(nameChanged || emailChanged);
  }, [name, email, user]);

  const handleSaveProfile = async () => {
    const result = await updateProfile({ name, email });
    if (result.success) {
      toast.success('Profile Updated', 'Your profile has been saved successfully.');
      setHasProfileChanges(false);
    } else {
      toast.error('Update Failed', result.error || 'Could not update your profile.');
    }
  };

  const handlePreferenceChange = (key: keyof UserPreferences, value: boolean) => {
    const newPrefs = { ...preferences, [key]: value };
    setPreferences(newPrefs);
    savePreferences(newPrefs);
    toast.success('Preference Saved', 'Your preference has been updated.');
  };

  const handleChangePassword = async () => {
    setPasswordError('');

    if (!currentPassword) {
      setPasswordError('Current password is required');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }

    setIsChangingPassword(true);
    const result = await updateProfile({ currentPassword, password: newPassword } as any);
    setIsChangingPassword(false);

    if (result.success) {
      toast.success('Password Changed', 'Your password has been updated successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } else {
      setPasswordError(result.error || 'Failed to change password');
    }
  };

  return (
    <div className="min-h-screen">
      <Header title="Settings" />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
        {/* Profile Settings */}
        <Card className="overflow-hidden">
          <CardContent className="p-6">
            <SectionHeader
              icon={User}
              title="Profile"
              description="Manage your personal information"
              iconBg="bg-indigo-500/10"
              iconColor="text-indigo-400"
            />
            <div className="space-y-4 ml-0 sm:ml-14">
              <Input
                label="Name"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Input
                label="Email"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <div className="pt-2">
                <Button
                  onClick={handleSaveProfile}
                  disabled={!hasProfileChanges || isLoading}
                  isLoading={isLoading}
                >
                  {hasProfileChanges ? 'Save Changes' : 'No Changes'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Notification Settings */}
        <Card className="overflow-hidden">
          <CardContent className="p-6">
            <SectionHeader
              icon={Bell}
              title="Notifications"
              description="Configure how you receive updates"
              iconBg="bg-blue-500/10"
              iconColor="text-blue-400"
            />
            <div className="space-y-1 ml-0 sm:ml-14">
              <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-gray-100 dark:bg-slate-800 rounded-lg">
                    <Mail className="h-4 w-4 text-gray-500 dark:text-slate-400" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900 dark:text-white">Email notifications</p>
                    <p className="text-sm text-gray-500 dark:text-slate-500">Receive email notifications for new form responses</p>
                  </div>
                </div>
                <Switch
                  checked={preferences.emailNotifications}
                  onChange={(checked) => handlePreferenceChange('emailNotifications', checked)}
                />
              </div>
              <div className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-gray-100 dark:bg-slate-800 rounded-lg">
                    <Calendar className="h-4 w-4 text-gray-500 dark:text-slate-400" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900 dark:text-white">Weekly digest</p>
                    <p className="text-sm text-gray-500 dark:text-slate-500">Get a weekly summary of form activity</p>
                  </div>
                </div>
                <Switch
                  checked={preferences.weeklyDigest}
                  onChange={(checked) => handlePreferenceChange('weeklyDigest', checked)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Appearance Settings */}
        <Card className="overflow-hidden">
          <CardContent className="p-6">
            <SectionHeader
              icon={Palette}
              title="Appearance"
              description="Customize the look and feel of your workspace"
              iconBg="bg-pink-500/10"
              iconColor="text-pink-400"
            />
            <div className="space-y-4 ml-0 sm:ml-14">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2 block">
                  Accent Color
                </label>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                  {[
                    { id: 'indigo', color: 'bg-indigo-500', label: 'Indigo' },
                    { id: 'lime', color: 'bg-lime-500', label: 'Lime' },
                    { id: 'rose', color: 'bg-rose-500', label: 'Rose' },
                    { id: 'orange', color: 'bg-orange-500', label: 'Orange' },
                    { id: 'cyan', color: 'bg-cyan-500', label: 'Cyan' },
                    { id: 'violet', color: 'bg-violet-500', label: 'Violet' },
                  ].map((theme) => {
                    const isSelected = themeColor === theme.id;
                    return (
                      <button
                        key={theme.id}
                        aria-label={`Select ${theme.label} accent color`}
                        aria-pressed={isSelected}
                        onClick={() => {
                          useUIStore.getState().setThemeColor(theme.id as any);
                          toast.success('Theme Updated', `Accent color changed to ${theme.label}`);
                        }}
                        className={`group relative flex flex-col items-center gap-2 p-3 rounded-xl border transition-all duration-200 ${isSelected
                          ? 'border-primary-500 bg-primary-500/5 ring-1 ring-primary-500/50'
                          : 'border-gray-200 dark:border-slate-800 hover:border-gray-300 dark:hover:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800'
                          }`}
                      >
                        <div className={`w-8 h-8 rounded-full ${theme.color} shadow-sm flex items-center justify-center`}>
                          {isSelected && <Check className="w-4 h-4 text-white" />}
                        </div>
                        <span className={`text-xs font-medium ${isSelected ? 'text-primary-600 dark:text-primary-400' : 'text-gray-600 dark:text-slate-400'
                          }`}>
                          {theme.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Default Form Settings */}
        <Card className="overflow-hidden">
          <CardContent className="p-6">
            <SectionHeader
              icon={Settings2}
              title="Default Form Settings"
              description="Set defaults for new forms you create"
              iconBg="bg-green-500/10"
              iconColor="text-green-400"
            />
            <div className="space-y-1 ml-0 sm:ml-14">
              <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-gray-100 dark:bg-slate-800 rounded-lg">
                    <LayoutGrid className="h-4 w-4 text-gray-500 dark:text-slate-400" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900 dark:text-white">Show progress bar</p>
                    <p className="text-sm text-gray-500 dark:text-slate-500">Display progress bar on forms by default</p>
                  </div>
                </div>
                <Switch
                  checked={preferences.showProgressBar}
                  onChange={(checked) => handlePreferenceChange('showProgressBar', checked)}
                />
              </div>
              <div className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-gray-100 dark:bg-slate-800 rounded-lg">
                    <ArrowLeft className="h-4 w-4 text-gray-500 dark:text-slate-400" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-900 dark:text-white">Allow back navigation</p>
                    <p className="text-sm text-gray-500 dark:text-slate-500">Allow respondents to go back to previous questions</p>
                  </div>
                </div>
                <Switch
                  checked={preferences.allowBackNavigation}
                  onChange={(checked) => handlePreferenceChange('allowBackNavigation', checked)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Security Section */}
        <Card className="overflow-hidden">
          <CardContent className="p-6">
            <SectionHeader
              icon={Shield}
              title="Security"
              description="Manage your account security"
              iconBg="bg-purple-500/10"
              iconColor="text-purple-400"
            />
            <div className="space-y-4 ml-0 sm:ml-14">
              <div className="flex items-center gap-2 mb-2">
                <Lock className="h-4 w-4 text-gray-500 dark:text-slate-400" />
                <h3 className="font-medium text-gray-900 dark:text-white">Change Password</h3>
              </div>
              <Input
                label="Current Password"
                type="password"
                placeholder="Enter current password"
                value={currentPassword}
                onChange={(e) => { setCurrentPassword(e.target.value); setPasswordError(''); }}
              />
              <Input
                label="New Password"
                type="password"
                placeholder="Enter new password (min 8 characters)"
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setPasswordError(''); }}
              />
              <Input
                label="Confirm New Password"
                type="password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setPasswordError(''); }}
              />
              {passwordError && (
                <p className="text-sm text-red-500">{passwordError}</p>
              )}
              <div className="pt-2">
                <Button
                  onClick={handleChangePassword}
                  disabled={!currentPassword || !newPassword || !confirmPassword || isChangingPassword}
                  isLoading={isChangingPassword}
                >
                  Change Password
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
