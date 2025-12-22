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
  X,
  Check,
  AlertTriangle,
  Calendar,
  Clock,
  Filter,
  Share2,
} from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Button } from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { useFormStore } from '../stores/formStore';
import { useResponseStore } from '../stores/responseStore';
import { api } from '../lib/api';
import { toast } from '../stores/toastStore';
import { cn } from '../lib/utils';
import { EmbedModal } from '../components/builder/EmbedModal';
import type { Form, FormField, FormResponse } from '../types/form';

const ITEMS_PER_PAGE = 10;

interface ResponseWithStatus extends FormResponse {
  status?: string;
  tags?: string[];
  computed?: Record<string, unknown>;
}

export function FormResponses() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const storageMode = useFormStore((state) => state.storageMode);
  const getForm = useFormStore((state) => state.getForm);
  const localResponses = useResponseStore((state) => state.getResponsesByFormId);
  const deleteLocalResponse = useResponseStore((state) => state.deleteResponse);

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
      .slice(0, 4);
  }, [form]);

  // Filter and sort responses
  const filteredResponses = useMemo(() => {
    let filtered = responses;

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((response) => {
        // Search in answers
        const answersStr = JSON.stringify(response.answers).toLowerCase();
        if (answersStr.includes(query)) return true;
        // Search in ID
        if (response.id.toLowerCase().includes(query)) return true;
        return false;
      });
    }

    // Sort
    filtered = [...filtered].sort((a, b) => {
      let aVal: number;
      let bVal: number;

      if (sortField === 'submittedAt') {
        aVal = new Date(a.submittedAt).getTime();
        bVal = new Date(b.submittedAt).getTime();
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
        // Update local state
        setResponses((prev) =>
          prev.map((r) =>
            r.id === selectedResponse.id ? { ...r, answers: editedAnswers } : r
          )
        );
      } else {
        // Local storage update - would need to add updateResponse to store
        toast.warning('Edit not available', 'Editing is only available in cloud mode');
        return;
      }
      toast.success('Response updated', 'Changes saved successfully');
      setIsEditModalOpen(false);
    } catch (error) {
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
    } catch (error) {
      toast.error('Failed to delete', 'An error occurred');
    }
  };

  // Handle export
  const handleExportCsv = () => {
    if (!form || responses.length === 0) return;

    const headers = ['ID', 'Submitted At', ...displayFields.map((f) => f.label)];
    const rows = responses.map((r) => [
      r.id,
      new Date(r.submittedAt).toLocaleString(),
      ...displayFields.map((f) => formatValue(r.answers[f.id])),
    ]);

    const csv = [headers.join(','), ...rows.map((row) => row.map((cell) => `"${cell}"`).join(','))].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${form.title}-responses.csv`;
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
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (!form) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Form not found</h2>
          <Button onClick={() => navigate('/')}>Go to Dashboard</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title={`${form.title} - Responses`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate(`/analytics/${formId}`)}>
              <ArrowLeft className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Back to Analytics</span>
            </Button>
            <Button variant="outline" onClick={() => setShowEmbedModal(true)} title="Share & Embed">
              <Share2 className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Share</span>
            </Button>
            <Button variant="outline" onClick={handleExportCsv} disabled={responses.length === 0}>
              <Download className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Export CSV</span>
            </Button>
          </div>
        }
      />

      <div className="p-4 sm:p-6 max-w-7xl mx-auto">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-gray-500">Total Responses</p>
              <p className="text-2xl font-bold text-gray-900">{responses.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-gray-500">This Week</p>
              <p className="text-2xl font-bold text-gray-900">
                {responses.filter((r) => {
                  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
                  return new Date(r.submittedAt).getTime() > weekAgo;
                }).length}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-gray-500">Today</p>
              <p className="text-2xl font-bold text-gray-900">
                {responses.filter((r) => {
                  const today = new Date().toDateString();
                  return new Date(r.submittedAt).toDateString() === today;
                }).length}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-gray-500">Avg. Time</p>
              <p className="text-2xl font-bold text-gray-900">
                {responses.length > 0
                  ? formatDuration(
                      responses.reduce((acc, r) => acc + (r.completionTime || 0), 0) / responses.length
                    )
                  : '-'}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search responses..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => toggleSort('submittedAt')}
              className={cn(
                'px-3 py-2 text-sm rounded-lg border transition-colors flex items-center gap-2',
                sortField === 'submittedAt'
                  ? 'bg-primary-50 border-primary-200 text-primary-700'
                  : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              )}
            >
              <Calendar className="h-4 w-4" />
              Date {sortField === 'submittedAt' && (sortDirection === 'desc' ? '↓' : '↑')}
            </button>
            <button
              onClick={() => toggleSort('completionTime')}
              className={cn(
                'px-3 py-2 text-sm rounded-lg border transition-colors flex items-center gap-2',
                sortField === 'completionTime'
                  ? 'bg-primary-50 border-primary-200 text-primary-700'
                  : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
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
            <CardContent className="p-12 text-center">
              <div className="text-gray-400 mb-4">
                <Filter className="h-12 w-12 mx-auto" />
              </div>
              <h3 className="text-lg font-medium text-gray-900 mb-2">No responses yet</h3>
              <p className="text-gray-500 mb-4">
                Share your form to start collecting responses
              </p>
              <Button onClick={() => navigate(`/builder/${formId}`)}>Go to Builder</Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Date
                    </th>
                    {displayFields.map((field) => (
                      <th
                        key={field.id}
                        className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hidden sm:table-cell"
                      >
                        {field.label}
                      </th>
                    ))}
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Time
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {paginatedResponses.map((response) => (
                    <tr key={response.id} className="hover:bg-gray-50">
                      <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                        {formatDate(response.submittedAt)}
                      </td>
                      {displayFields.map((field) => (
                        <td
                          key={field.id}
                          className="px-4 py-4 text-sm text-gray-600 max-w-[200px] truncate hidden sm:table-cell"
                        >
                          {formatValue(response.answers[field.id])}
                        </td>
                      ))}
                      <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatDuration(response.completionTime || 0)}
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => handleView(response)}
                            className="p-2 text-gray-500 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                            title="View details"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleEdit(response)}
                            className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title="Edit response"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteConfirm(response)}
                            className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Delete response"
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
              <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
                <p className="text-sm text-gray-500">
                  Showing {(currentPage - 1) * ITEMS_PER_PAGE + 1} to{' '}
                  {Math.min(currentPage * ITEMS_PER_PAGE, filteredResponses.length)} of{' '}
                  {filteredResponses.length} responses
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="px-3 py-1 text-sm text-gray-700">
                    {currentPage} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
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
      {isViewModalOpen && selectedResponse && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Response Details</h2>
                <p className="text-sm text-gray-500">
                  Submitted {formatDate(selectedResponse.submittedAt)}
                </p>
              </div>
              <button
                onClick={() => setIsViewModalOpen(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="space-y-4">
                {form.fields
                  .filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type))
                  .map((field) => (
                    <div key={field.id} className="border-b border-gray-100 pb-4 last:border-0">
                      <p className="text-sm font-medium text-gray-500 mb-1">{field.label}</p>
                      <p className="text-gray-900">
                        {formatValue(selectedResponse.answers[field.id]) || (
                          <span className="text-gray-400 italic">No answer</span>
                        )}
                      </p>
                    </div>
                  ))}
                {/* Metadata */}
                <div className="pt-4 border-t border-gray-200">
                  <h3 className="text-sm font-medium text-gray-500 mb-3">Metadata</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-gray-500">Response ID</p>
                      <p className="text-gray-900 font-mono text-xs">{selectedResponse.id}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Completion Time</p>
                      <p className="text-gray-900">
                        {formatDuration(selectedResponse.completionTime || 0)}
                      </p>
                    </div>
                    {selectedResponse.metadata?.userAgent && (
                      <div className="col-span-2">
                        <p className="text-gray-500">User Agent</p>
                        <p className="text-gray-900 text-xs truncate">
                          {selectedResponse.metadata.userAgent}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end gap-2">
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
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {isEditModalOpen && selectedResponse && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Edit Response</h2>
                <p className="text-sm text-gray-500">
                  Modify the response data
                </p>
              </div>
              <button
                onClick={() => setIsEditModalOpen(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="space-y-4">
                {form.fields
                  .filter((f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type))
                  .map((field) => (
                    <div key={field.id}>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {field.label}
                      </label>
                      {renderEditField(field, editedAnswers[field.id], (value) =>
                        setEditedAnswers((prev) => ({ ...prev, [field.id]: value }))
                      )}
                    </div>
                  ))}
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsEditModalOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSaveEdit} isLoading={isSaving}>
                <Check className="h-4 w-4 mr-2" />
                Save Changes
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {isDeleteModalOpen && selectedResponse && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
            <div className="p-6">
              <div className="flex items-center gap-4 mb-4">
                <div className="p-3 bg-red-100 rounded-full">
                  <AlertTriangle className="h-6 w-6 text-red-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Delete Response</h2>
                  <p className="text-sm text-gray-500">This action cannot be undone</p>
                </div>
              </div>
              <p className="text-gray-600 mb-6">
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
          </div>
        </div>
      )}

      {/* Embed Modal */}
      <EmbedModal
        isOpen={showEmbedModal}
        onClose={() => setShowEmbedModal(false)}
        formId={form.id}
        formTitle={form.title}
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
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      );

    case 'long_text':
      return (
        <textarea
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
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
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      );

    case 'date':
      return (
        <input
          type="date"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      );

    case 'time':
      return (
        <input
          type="time"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      );

    case 'datetime':
      return (
        <input
          type="datetime-local"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      );

    case 'dropdown':
    case 'multiple_choice':
      return (
        <select
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="">Select...</option>
          {field.properties.options?.map((opt) => (
            <option key={opt.id} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );

    case 'checkboxes':
      const selectedValues = Array.isArray(currentValue) ? currentValue : [];
      return (
        <div className="space-y-2">
          {field.properties.options?.map((opt) => (
            <label key={opt.id} className="flex items-center gap-2">
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
                className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              />
              {opt.label}
            </label>
          ))}
        </div>
      );

    default:
      return (
        <input
          type="text"
          value={String(currentValue)}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      );
  }
}

export default FormResponses;
