import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Search,
  Trash2,
  Eye,
  Edit2,
  Download,
  ChevronLeft,
  ChevronRight,
  Check,
  AlertTriangle,
  Calendar,
  Clock,
  Inbox,
  Share2,
  Users,
  CalendarDays,
  Timer,
  Upload,
} from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Button } from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { Modal } from '../components/ui/Modal';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { api } from '../lib/api';
import { toast } from '../stores/toastStore';
import { cn, sanitizeFilename } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';
import { CsvImportWizard } from '../components/builder';
import type { Form, FormField, FormResponse } from '../types/form';

const ITEMS_PER_PAGE = 10;

interface ResponseWithStatus extends FormResponse {
  status?: string;
  tags?: string[];
  computed?: Record<string, unknown>;
}

// Stats card component for consistency
function StatCard({
  icon: Icon,
  label,
  value,
  iconBg,
  iconColor,
  textColor,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  iconBg: string;
  iconColor: string;
  textColor?: string;
}) {
  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={cn('p-2.5 rounded-lg', iconBg)}>
            <Icon className={cn('h-5 w-5', iconColor)} />
          </div>
          <div>
            <p className={cn("text-2xl font-bold tracking-tight", textColor || "text-gray-900 dark:text-white")}>{value}</p>
            <p className="text-sm text-gray-500 dark:text-slate-400">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function FormResponses() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const storageMode = useFormStore((state) => state.storageMode);
  const getForm = useFormStore((state) => state.getForm);
  const localResponses = useResponseStore((state) => state.getResponsesByFormId);
  const deleteLocalResponse = useResponseStore((state) => state.deleteResponse);
  const updateLocalResponse = useResponseStore((state) => state.updateResponse);

  const [form, setForm] = useState<Form | null>(null);
  const [responses, setResponses] = useState<ResponseWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedResponse, setSelectedResponse] = useState<ResponseWithStatus | null>(null);
  const [isViewModalOpen, setIsViewModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [editedAnswers, setEditedAnswers] = useState<Record<string, unknown>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [sortField, setSortField] = useState<'submittedAt' | 'completionTime'>('submittedAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [showEmbedModal, setShowEmbedModal] = useState(false);
  const [showCsvImport, setShowCsvImport] = useState(false);

  // Load form and responses
  useEffect(() => {
    if (!formId) return;

    const loadData = async () => {
      setIsLoading(true);

      // Load form
      const localForm = getForm(formId);
      if (localForm) {
        setForm(localForm);
      } else if (storageMode === 'api') {
        const result = await api.getForm(formId);
        if (result.data?.form) {
          setForm(result.data.form);
        }
      }

      // Load responses
      if (storageMode === 'api') {
        const result = await api.getResponses(formId);
        if (result.data?.responses) {
          setResponses(result.data.responses as ResponseWithStatus[]);
        } else {
          toast.error('Failed to load responses', result.error || 'Unknown error');
        }
      } else {
        const localResps = localResponses(formId);
        setResponses(localResps as ResponseWithStatus[]);
      }

      setIsLoading(false);
    };

    loadData();
  }, [formId, storageMode, getForm, localResponses]);

  // Get display fields (first few meaningful fields)
  const displayFields = useMemo(() => {
    if (!form) return [];
    return form.fields
      .filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type))
      .slice(0, 6);
  }, [form]);

  // Calculate stats
  const stats = useMemo(() => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const today = new Date().toDateString();

    const thisWeek = responses.filter((r) => new Date(r.submittedAt).getTime() > weekAgo).length;
    const todayCount = responses.filter((r) => new Date(r.submittedAt).toDateString() === today).length;
    const avgTime = responses.length > 0
      ? responses.reduce((acc, r) => acc + (r.completionTime || 0), 0) / responses.length
      : 0;

    return { total: responses.length, thisWeek, todayCount, avgTime };
  }, [responses]);

  // Filter and sort responses
  const filteredResponses = useMemo(() => {
    let filtered = responses;

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((response) => {
        const answersStr = JSON.stringify(response.answers).toLowerCase();
        if (answersStr.includes(query)) return true;
        if (response.id.toLowerCase().includes(query)) return true;
        return false;
      });
    }

    // Sort
    filtered = [...filtered].sort((a, b) => {
      let aVal: number;
      let bVal: number;

      if (sortField === 'submittedAt') {
        aVal = new Date(a.submittedAt).getTime() || 0;
        bVal = new Date(b.submittedAt).getTime() || 0;
      } else {
        aVal = a.completionTime || 0;
        bVal = b.completionTime || 0;
      }

      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });

    return filtered;
  }, [responses, searchQuery, sortField, sortDirection]);

  // Pagination
  const totalPages = Math.ceil(filteredResponses.length / ITEMS_PER_PAGE);
  const paginatedResponses = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredResponses.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredResponses, currentPage]);

  // Handle view response
  const handleView = (response: ResponseWithStatus) => {
    setSelectedResponse(response);
    setIsViewModalOpen(true);
  };

  // Handle edit response
  const handleEdit = (response: ResponseWithStatus) => {
    setSelectedResponse(response);
    setEditedAnswers({ ...response.answers });
    setIsEditModalOpen(true);
  };

  // Handle save edit
  const handleSaveEdit = async () => {
    if (!selectedResponse || !formId) return;

    setIsSaving(true);
    try {
      if (storageMode === 'api') {
        const result = await api.updateResponse(formId, selectedResponse.id, {
          answers: editedAnswers,
        });
        if (result.error) {
          toast.error('Failed to update response', result.error);
          return;
        }
        setResponses((prev) =>
          prev.map((r) =>
            r.id === selectedResponse.id ? { ...r, answers: editedAnswers } : r
          )
        );
      } else {
        updateLocalResponse(selectedResponse.id, editedAnswers);
        setResponses((prev) =>
          prev.map((r) =>
            r.id === selectedResponse.id ? { ...r, answers: editedAnswers } : r
          )
        );
      }
      toast.success('Response updated', 'Changes saved successfully');
      setIsEditModalOpen(false);
    } catch {
      toast.error('Failed to save', 'An error occurred while saving');
    } finally {
      setIsSaving(false);
    }
  };

  // Handle delete confirmation
  const handleDeleteConfirm = (response: ResponseWithStatus) => {
    setSelectedResponse(response);
    setIsDeleteModalOpen(true);
  };

  // Handle delete
  const handleDelete = async () => {
    if (!selectedResponse || !formId) return;

    try {
      if (storageMode === 'api') {
        const result = await api.deleteResponse(formId, selectedResponse.id);
        if (result.error) {
          toast.error('Failed to delete', result.error);
          return;
        }
      } else {
        deleteLocalResponse(selectedResponse.id);
      }

      setResponses((prev) => prev.filter((r) => r.id !== selectedResponse.id));
      toast.success('Response deleted', 'The response has been removed');
      setIsDeleteModalOpen(false);
    } catch {
      toast.error('Failed to delete', 'An error occurred');
    }
  };

  // Handle export
  const handleExportCsv = () => {
    if (!form || responses.length === 0) return;

    // Export all fields, not just displayFields (which is limited to 6 for the table UI)
    const allExportFields = form.fields.filter(
      (f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type)
    );
    const escapeCell = (val: unknown) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const headers = ['ID', 'Submitted At', ...allExportFields.map((f) => f.label)];
    const rows = responses.map((r) => [
      r.id,
      new Date(r.submittedAt).toLocaleString(),
      ...allExportFields.map((f) => formatValue(r.answers[f.id])),
    ]);

    const csv = [headers.map(escapeCell).join(','), ...rows.map((row) => row.map(escapeCell).join(','))].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilename(form.title)}-responses.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Format value for display
  const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  // Format date
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Format duration
  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  // Toggle sort
  const toggleSort = (field: 'submittedAt' | 'completionTime') => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
    setCurrentPage(1);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950 transition-colors">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!form) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950 transition-colors">
        <EmptyState
          icon={Inbox}
          title="Form not found"
          description="The form you're looking for doesn't exist or has been deleted."
          action={<Button onClick={() => navigate('/')}>Go to Dashboard</Button>}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 transition-colors">
      <Header
        title={`${form.title} - Responses`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => navigate(`/analytics/${formId}`)}>
              <ArrowLeft className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Back to Analytics</span>
            </Button>
            <Button variant="outline" onClick={() => setShowEmbedModal(true)} title="Share & Embed">
              <Share2 className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Share</span>
            </Button>
            <Button variant="outline" onClick={() => setShowCsvImport(true)} title="Import CSV">
              <Upload className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Import CSV</span>
            </Button>
            <Button variant="outline" onClick={handleExportCsv} disabled={responses.length === 0} title="Export CSV">
              <Download className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Export CSV</span>
            </Button>
          </div>
        }
      />

      <div className="flex-1 w-full p-4 sm:p-6 lg:p-8">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <StatCard
            icon={Users}
            label="Total Responses"
            value={stats.total}
            iconBg="bg-indigo-500/10"
            iconColor="text-indigo-500"
            textColor="text-gray-900 dark:text-white"
          />
          <StatCard
            icon={CalendarDays}
            label="This Week"
            value={stats.thisWeek}
            iconBg="bg-green-500/10"
            iconColor="text-green-500"
            textColor="text-gray-900 dark:text-white"
          />
          <StatCard
            icon={Calendar}
            label="Today"
            value={stats.todayCount}
            iconBg="bg-blue-500/10"
            iconColor="text-blue-500"
            textColor="text-gray-900 dark:text-white"
          />
          <StatCard
            icon={Timer}
            label="Avg. Time"
            value={formatDuration(stats.avgTime)}
            iconBg="bg-amber-500/10"
            iconColor="text-amber-500"
            textColor="text-gray-900 dark:text-white"
          />
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                placeholder="Search responses..."
                aria-label="Search responses"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-colors text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => toggleSort('submittedAt')}
              className={cn(
                'px-4 py-2.5 text-sm rounded-lg border transition-all flex items-center gap-2 font-medium',
                sortField === 'submittedAt'
                  ? 'bg-primary-50 dark:bg-primary-500/10 border-primary-200 dark:border-primary-500/50 text-primary-700 dark:text-white shadow-sm'
                  : 'bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800'
              )}
            >
              <Calendar className="h-4 w-4" />
              Date {sortField === 'submittedAt' && (sortDirection === 'desc' ? '↓' : '↑')}
            </button>
            <button
              onClick={() => toggleSort('completionTime')}
              className={cn(
                'px-4 py-2.5 text-sm rounded-lg border transition-all flex items-center gap-2 font-medium',
                sortField === 'completionTime'
                  ? 'bg-primary-50 dark:bg-primary-500/10 border-primary-200 dark:border-primary-500/50 text-primary-700 dark:text-white shadow-sm'
                  : 'bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800'
              )}
            >
              <Clock className="h-4 w-4" />
              Time {sortField === 'completionTime' && (sortDirection === 'desc' ? '↓' : '↑')}
            </button>
          </div>
        </div>

        {/* Responses Table */}
        {responses.length === 0 ? (
          <Card>
            <CardContent className="p-0">
              <EmptyState
                icon={Inbox}
                title="No responses yet"
                description="Share your form to start collecting responses"
                action={<Button onClick={() => navigate(`/builder/${formId}`)}>Go to Builder</Button>}
              />
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden bg-white dark:bg-slate-900/50 border-gray-200 dark:border-slate-800">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50/50 dark:bg-slate-900/50 border-b border-gray-200 dark:border-slate-800">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider">
                      Date
                    </th>
                    {displayFields.map((field) => (
                      <th
                        key={field.id}
                        className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider hidden sm:table-cell"
                        title={field.label}
                      >
                        <span className="truncate block max-w-[150px]">{field.label}</span>
                      </th>
                    ))}
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider">
                      Time
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-slate-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-slate-800 bg-white dark:bg-slate-900/20">
                  {paginatedResponses.map((response) => (
                    <tr key={response.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
                      <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-white">
                        {formatDate(response.submittedAt)}
                      </td>
                      {displayFields.map((field) => (
                        <td
                          key={field.id}
                          className="px-4 py-4 text-sm text-gray-600 dark:text-slate-300 max-w-[200px] truncate hidden sm:table-cell"
                          title={formatValue(response.answers[field.id])}
                        >
                          {formatValue(response.answers[field.id])}
                        </td>
                      ))}
                      <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-slate-500">
                        {formatDuration(response.completionTime || 0)}
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => handleView(response)}
                            className="p-2 text-gray-500 hover:text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-500/10 rounded-lg transition-colors"
                            title="View details"
                            aria-label="View response details"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleEdit(response)}
                            className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded-lg transition-colors"
                            title="Edit response"
                            aria-label="Edit response"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteConfirm(response)}
                            className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors"
                            title="Delete response"
                            aria-label="Delete response"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-4 py-3 border-t border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between">
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  Showing <span className="font-medium text-gray-900 dark:text-white">{(currentPage - 1) * ITEMS_PER_PAGE + 1}</span> to{' '}
                  <span className="font-medium text-gray-900 dark:text-white">{Math.min(currentPage * ITEMS_PER_PAGE, filteredResponses.length)}</span> of{' '}
                  <span className="font-medium text-gray-900 dark:text-white">{filteredResponses.length}</span> responses
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 font-medium bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg">
                    {currentPage} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>

      {/* View Modal */}
      <Modal
        isOpen={isViewModalOpen}
        onClose={() => setIsViewModalOpen(false)}
        title="Response Details"
        description={selectedResponse ? `Submitted ${formatDate(selectedResponse.submittedAt)}` : undefined}
        size="lg"
      >
        {selectedResponse && (
          <>
            <div className="p-6 space-y-4">
              {form.fields
                .filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type))
                .map((field) => (
                  <div key={field.id} className="border-b border-gray-100 dark:border-slate-800 pb-4 last:border-0 last:pb-0">
                    <p className="text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">{field.label}</p>
                    <p className="text-gray-900 dark:text-white">
                      {formatValue(selectedResponse.answers[field.id]) || (
                        <span className="text-gray-400 dark:text-slate-500 italic">No answer</span>
                      )}
                    </p>
                  </div>
                ))}
              {/* Metadata */}
              <div className="pt-4 border-t border-gray-100 dark:border-slate-800">
                <h3 className="text-sm font-medium text-gray-500 dark:text-slate-400 mb-3">Metadata</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-gray-500 dark:text-slate-400">Response ID</p>
                    <p className="text-gray-700 dark:text-slate-300 font-mono text-xs bg-gray-100 dark:bg-slate-800 px-2 py-1 rounded mt-1">
                      {selectedResponse.id}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500 dark:text-slate-400">Completion Time</p>
                    <p className="text-gray-900 dark:text-white mt-1">
                      {formatDuration(selectedResponse.completionTime || 0)}
                    </p>
                  </div>
                  {selectedResponse.metadata?.userAgent && (
                    <div className="col-span-2">
                      <p className="text-gray-500 dark:text-slate-400">User Agent</p>
                      <p className="text-gray-900 dark:text-white text-xs truncate mt-1">
                        {selectedResponse.metadata.userAgent}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsViewModalOpen(false)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  setIsViewModalOpen(false);
                  handleEdit(selectedResponse);
                }}
              >
                <Edit2 className="h-4 w-4 mr-2" />
                Edit
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* Edit Modal */}
      <Modal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        title="Edit Response"
        description="Modify the response data"
        size="lg"
      >
        {selectedResponse && (
          <>
            <div className="p-6 space-y-4">
              {form.fields
                .filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type))
                .map((field) => (
                  <div key={field.id}>
                    <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                      {field.label}
                    </label>
                    {renderEditField(field, editedAnswers[field.id], (value) =>
                      setEditedAnswers((prev) => ({ ...prev, [field.id]: value }))
                    )}
                  </div>
                ))}
            </div>
            <div className="px-6 py-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/50 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsEditModalOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSaveEdit} isLoading={isSaving}>
                <Check className="h-4 w-4 mr-2" />
                Save Changes
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        size="sm"
        showCloseButton={false}
      >
        <div className="p-6">
          <div className="flex items-center gap-4 mb-4">
            <div className="p-3 bg-red-100 dark:bg-red-500/10 rounded-full">
              <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white tracking-tight">Delete Response</h2>
              <p className="text-sm text-gray-500 dark:text-slate-400">This action cannot be undone</p>
            </div>
          </div>
          <p className="text-gray-600 dark:text-slate-400 mb-6">
            Are you sure you want to delete this response? All data associated with this
            submission will be permanently removed.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsDeleteModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete}>
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </div>
        </div>
      </Modal>

      {/* Embed Modal */}
      <EmbedModal
        isOpen={showEmbedModal}
        onClose={() => setShowEmbedModal(false)}
        formId={form.id}
        formTitle={form.title}
      />

      {/* CSV Import Wizard */}
      <CsvImportWizard
        isOpen={showCsvImport}
        onClose={() => setShowCsvImport(false)}
        formId={form.id}
        fields={form.fields.map((f) => ({ id: f.id, label: f.label, type: f.type }))}
        onImportComplete={async () => {
          // Reload responses after import
          if (storageMode === 'api' && formId) {
            try {
              const result = await api.getResponses(formId);
              if (result.data?.responses) {
                setResponses(result.data.responses as ResponseWithStatus[]);
              }
            } catch {
              // Responses will refresh on next page load
            }
          }
        }}
      />
    </div>
  );
}

// Helper function to render edit field based on type
function renderEditField(
  field: FormField,
  value: unknown,
  onChange: (value: unknown) => void
) {
  const currentValue = value ?? '';
  const inputClasses = "w-full px-3 py-2.5 bg-white dark:bg-slate-900 border border-gray-300 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-colors text-gray-900 dark:text-white";
  const disabledClasses = "w-full px-3 py-2.5 bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg text-gray-500 dark:text-slate-400 cursor-not-allowed";

  // Read-only for calculated fields
  if (field.type === 'calculated') {
    return (
      <input
        type="text"
        value={String(currentValue)}
        disabled
        className={disabledClasses}
      />
    );
  }

  switch (field.type) {
    case 'short_text':
    case 'email':
    case 'phone':
    case 'url':
      return (
        <input
          type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );

    case 'long_text':
      return (
        <textarea
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className={inputClasses}
        />
      );

    case 'number':
    case 'rating':
    case 'scale':
      return (
        <input
          type="number"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
          className={inputClasses}
        />
      );

    case 'date':
      return (
        <input
          type="date"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );

    case 'time':
      return (
        <input
          type="time"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );

    case 'datetime':
      return (
        <input
          type="datetime-local"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );

    case 'dropdown':
    case 'multiple_choice':
      return (
        <select
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        >
          <option value="">Select...</option>
          {field.properties.options?.map((opt) => (
            <option key={opt.id} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );

    case 'checkboxes': {
      const selectedValues = Array.isArray(currentValue) ? currentValue : [];
      return (
        <div className="space-y-2">
          {field.properties.options?.map((opt) => (
            <label key={opt.id} className="flex items-center gap-3 p-2 hover:bg-gray-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={selectedValues.includes(opt.value)}
                onChange={(e) => {
                  if (e.target.checked) {
                    onChange([...selectedValues, opt.value]);
                  } else {
                    onChange(selectedValues.filter((v: string) => v !== opt.value));
                  }
                }}
                className="h-4 w-4 rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500"
              />
              <span className="text-gray-700 dark:text-slate-300">{opt.label}</span>
            </label>
          ))}
        </div>
      );
    }

    default:
      return (
        <input
          type="text"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
        />
      );
  }
}

export default FormResponses;
