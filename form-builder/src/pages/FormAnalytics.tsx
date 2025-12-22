import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Users, Clock, CheckCircle, TrendingUp } from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Button } from '../components/ui/Button';
import { Card, CardContent, CardHeader } from '../components/ui/Card';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { formatDate } from '../lib/utils';

export default function FormAnalytics() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const { getForm } = useFormStore();
  const { getResponsesByFormId } = useResponseStore();

  const form = formId ? getForm(formId) : undefined;
  const responses = formId ? getResponsesByFormId(formId) : [];

  if (!form) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Form not found</p>
      </div>
    );
  }

  const avgCompletionTime = responses.length > 0
    ? Math.round(responses.reduce((sum, r) => sum + r.completionTime, 0) / responses.length / 1000)
    : 0;

  const completionRate = 89; // Mock data

  // Mock daily responses for chart
  const dailyResponses = [
    { day: 'Mon', count: 12 },
    { day: 'Tue', count: 19 },
    { day: 'Wed', count: 15 },
    { day: 'Thu', count: 25 },
    { day: 'Fri', count: 22 },
    { day: 'Sat', count: 18 },
    { day: 'Sun', count: 14 },
  ];

  const maxCount = Math.max(...dailyResponses.map((d) => d.count));

  const handleExportCSV = () => {
    if (responses.length === 0) {
      alert('No responses to export');
      return;
    }

    const headers = ['Response ID', 'Submitted At', 'Completion Time (s)', ...form.fields.map((f) => f.label)];
    const rows = responses.map((r) => [
      r.id,
      r.submittedAt,
      Math.round(r.completionTime / 1000),
      ...form.fields.map((f) => JSON.stringify(r.answers[f.id] || '')),
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${form.title}-responses.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen">
      <Header
        title={`${form.title} - Analytics`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate(`/builder/${form.id}`)}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Builder
            </Button>
            <Button onClick={handleExportCSV} leftIcon={<Download className="h-4 w-4" />}>
              Export CSV
            </Button>
          </div>
        }
      />

      <div className="p-6 max-w-7xl mx-auto space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 bg-blue-100 rounded-lg">
                <Users className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{responses.length}</p>
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
                <p className="text-2xl font-bold text-gray-900">{completionRate}%</p>
                <p className="text-sm text-gray-500">Completion Rate</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 bg-purple-100 rounded-lg">
                <Clock className="h-6 w-6 text-purple-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">
                  {avgCompletionTime > 60
                    ? `${Math.floor(avgCompletionTime / 60)}m ${avgCompletionTime % 60}s`
                    : `${avgCompletionTime}s`}
                </p>
                <p className="text-sm text-gray-500">Avg. Time</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 bg-orange-100 rounded-lg">
                <TrendingUp className="h-6 w-6 text-orange-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">+12%</p>
                <p className="text-sm text-gray-500">This Week</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Chart */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">Responses Over Time</h2>
          </CardHeader>
          <CardContent>
            <div className="h-64 flex items-end justify-between gap-2">
              {dailyResponses.map((day) => (
                <div key={day.day} className="flex-1 flex flex-col items-center gap-2">
                  <div
                    className="w-full bg-primary-500 rounded-t-lg transition-all hover:bg-primary-600"
                    style={{ height: `${(day.count / maxCount) * 100}%` }}
                  />
                  <span className="text-sm text-gray-500">{day.day}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent Responses */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Recent Responses</h2>
            <Button variant="outline" size="sm">
              View All
            </Button>
          </CardHeader>
          <CardContent>
            {responses.length === 0 ? (
              <p className="text-center text-gray-500 py-8">No responses yet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">ID</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">Submitted</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-500">Time</th>
                      {form.fields.slice(0, 3).map((field) => (
                        <th key={field.id} className="text-left py-3 px-4 text-sm font-medium text-gray-500">
                          {field.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {responses.slice(0, 10).map((response) => (
                      <tr key={response.id} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="py-3 px-4 text-sm text-gray-900 font-mono">
                          #{response.id.slice(0, 8)}
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-600">
                          {formatDate(response.submittedAt)}
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-600">
                          {Math.round(response.completionTime / 1000)}s
                        </td>
                        {form.fields.slice(0, 3).map((field) => (
                          <td key={field.id} className="py-3 px-4 text-sm text-gray-600 truncate max-w-xs">
                            {String(response.answers[field.id] || '-')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
