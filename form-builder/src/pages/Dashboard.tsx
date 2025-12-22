import { useNavigate } from 'react-router-dom';
import {
  FileText,
  Eye,
  CheckCircle,
  Plus,
  Pencil,
  BarChart3,
  Trash2
} from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { formatRelativeTime } from '../lib/utils';

export function Dashboard() {
  const navigate = useNavigate();
  const { forms, createForm, setActiveForm, deleteForm } = useFormStore();
  const { getResponsesByFormId } = useResponseStore();

  const handleCreateForm = () => {
    const form = createForm('Untitled Form');
    setActiveForm(form.id);
    navigate(`/builder/${form.id}`);
  };

  const totalForms = forms.length;
  const totalResponses = forms.reduce(
    (sum, form) => sum + getResponsesByFormId(form.id).length,
    0
  );
  const avgCompletionRate = 89; // Mock data

  const recentForms = [...forms]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);

  return (
    <div className="min-h-screen">
      <Header title="Dashboard" />

      <div className="p-6 max-w-7xl mx-auto">
        {/* Welcome Section */}
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            Welcome back!
          </h2>
          <p className="text-gray-600">
            Here's an overview of your forms and responses.
          </p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 bg-primary-100 rounded-lg">
                <FileText className="h-6 w-6 text-primary-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{totalForms}</p>
                <p className="text-sm text-gray-500">Total Forms</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 bg-blue-100 rounded-lg">
                <Eye className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{totalResponses}</p>
                <p className="text-sm text-gray-500">Total Responses</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 bg-green-100 rounded-lg">
                <CheckCircle className="h-6 w-6 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{avgCompletionRate}%</p>
                <p className="text-sm text-gray-500">Avg. Completion Rate</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Recent Forms */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Recent Forms</h3>
          <Button onClick={handleCreateForm} leftIcon={<Plus className="h-4 w-4" />}>
            New Form
          </Button>
        </div>

        {recentForms.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <FileText className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                No forms yet
              </h3>
              <p className="text-gray-500 mb-4">
                Create your first form to get started
              </p>
              <Button onClick={handleCreateForm} leftIcon={<Plus className="h-4 w-4" />}>
                Create Form
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {recentForms.map((form) => {
              const responses = getResponsesByFormId(form.id);
              return (
                <Card key={form.id} className="hover:shadow-md transition-shadow">
                  <CardContent className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="p-2 bg-gray-100 rounded-lg">
                        <FileText className="h-5 w-5 text-gray-600" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium text-gray-900">
                            {form.title}
                          </h4>
                          <Badge
                            variant={form.status === 'published' ? 'success' : 'default'}
                          >
                            {form.status}
                          </Badge>
                        </div>
                        <p className="text-sm text-gray-500">
                          Updated {formatRelativeTime(form.updatedAt)} • {responses.length} responses
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/builder/${form.id}`)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/preview/${form.id}`)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/analytics/${form.id}`)}
                      >
                        <BarChart3 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteForm(form.id)}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
