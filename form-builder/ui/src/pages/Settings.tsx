import { useState, useEffect } from 'react';
import { Header } from '../components/layout/Header';
import { Card, CardContent, CardHeader } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Switch } from '../components/ui/Switch';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/toastStore';

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

export function Settings() {
  const user = useAuthStore((state) => state.user);
  const updateProfile = useAuthStore((state) => state.updateProfile);
  const isLoading = useAuthStore((state) => state.isLoading);

  // Profile form state
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [hasProfileChanges, setHasProfileChanges] = useState(false);

  // Preferences state
  const [preferences, setPreferences] = useState<UserPreferences>(getStoredPreferences);

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

  const handleDeleteAccount = () => {
    // For now, just show a confirmation message
    // In production, this would call an API endpoint
    toast.warning('Not Implemented', 'Account deletion is not yet available. Contact support for assistance.');
  };

  return (
    <div className="min-h-screen">
      <Header title="Settings" />

      <div className="p-6 max-w-3xl mx-auto space-y-6">
        {/* Profile Settings */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">Profile</h2>
          </CardHeader>
          <CardContent className="space-y-4">
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
            <Button
              onClick={handleSaveProfile}
              disabled={!hasProfileChanges || isLoading}
              isLoading={isLoading}
            >
              {hasProfileChanges ? 'Save Changes' : 'No Changes'}
            </Button>
          </CardContent>
        </Card>

        {/* Notification Settings */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">Notifications</h2>
          </CardHeader>
          <CardContent className="space-y-4">
            <Switch
              checked={preferences.emailNotifications}
              onChange={(checked) => handlePreferenceChange('emailNotifications', checked)}
              label="Email notifications"
              description="Receive email notifications for new form responses"
            />
            <Switch
              checked={preferences.weeklyDigest}
              onChange={(checked) => handlePreferenceChange('weeklyDigest', checked)}
              label="Weekly digest"
              description="Get a weekly summary of form activity"
            />
          </CardContent>
        </Card>

        {/* Default Form Settings */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">Default Form Settings</h2>
          </CardHeader>
          <CardContent className="space-y-4">
            <Switch
              checked={preferences.showProgressBar}
              onChange={(checked) => handlePreferenceChange('showProgressBar', checked)}
              label="Show progress bar"
              description="Display progress bar on forms by default"
            />
            <Switch
              checked={preferences.allowBackNavigation}
              onChange={(checked) => handlePreferenceChange('allowBackNavigation', checked)}
              label="Allow back navigation"
              description="Allow respondents to go back to previous questions"
            />
          </CardContent>
        </Card>

        {/* Danger Zone */}
        <Card className="border-red-200">
          <CardHeader>
            <h2 className="text-lg font-semibold text-red-600">Danger Zone</h2>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              Once you delete your account, there is no going back. Please be certain.
            </p>
            <Button variant="danger" onClick={handleDeleteAccount}>
              Delete Account
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
