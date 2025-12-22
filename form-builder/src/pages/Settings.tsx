import { Header } from '../components/layout/Header';
import { Card, CardContent, CardHeader } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Switch } from '../components/ui/Switch';

export function Settings() {
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
            <Input label="Name" placeholder="Your name" defaultValue="John Doe" />
            <Input
              label="Email"
              type="email"
              placeholder="your@email.com"
              defaultValue="john@example.com"
            />
            <Button>Save Changes</Button>
          </CardContent>
        </Card>

        {/* Notification Settings */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">Notifications</h2>
          </CardHeader>
          <CardContent className="space-y-4">
            <Switch
              checked={true}
              onChange={() => {}}
              label="Email notifications"
              description="Receive email notifications for new form responses"
            />
            <Switch
              checked={false}
              onChange={() => {}}
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
              checked={true}
              onChange={() => {}}
              label="Show progress bar"
              description="Display progress bar on forms by default"
            />
            <Switch
              checked={true}
              onChange={() => {}}
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
            <Button variant="danger">Delete Account</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
